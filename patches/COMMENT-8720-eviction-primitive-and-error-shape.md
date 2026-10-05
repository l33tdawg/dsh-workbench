*Posted 2026-10-05 as [comment 18754123](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18754123) on [discussion #8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720), answering [comment 18746515](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18746515).*

Thanks — the no-retry shape is the right trade, and checking it against the wiring changed one detail of it. The eviction is cheaper than described (one published method, no key to reconstruct), and on its own it does *not* re-list, so "the next call re-lists" heals at the next reconnect rather than the next call. That second point is also the answer to §3, so here they are together.

### 1. The eviction is one published call

`ResponseCacheStore` (`@modelcontextprotocol/client` 2.0.0, `dist/index.d.mts:1447-1476`) carries both a key-scoped drop and a method-wide one:

> `evict(method)`: "Drop every entry for `method` across every partition. The `Client` does NOT call this (its `list_changed` path issues two partition-scoped `delete()` calls so co-tenants on a shared store keep their entries); kept on the interface for callers that want a method-wide bulk-clear."

So the hook is one line against the store the supervisor already owns (`src/connection.ts:153`):

```ts
responseCache.evict('tools/list')
```

The partition key never has to be reconstructed (the client derives it privately, `_partitionFor` `index.mjs:1922-1924`), and one instance is shared by every generation, so the eviction reaches the entry the reconnect would otherwise have served. The SDK's own recovery path uses this same call internally (`index.mjs:4141`).

### 2. The error shape, exactly

| Failure | Wire response | What the caller catches |
|---|---|---|
| unknown tool | `-32602` `InvalidParams`, `"Tool <name> not found"`, no `data` — `@modelcontextprotocol/server` 2.0.0 `dist/mcp-DXXb3Vv3.mjs:1396` | generic `ProtocolError`, `code: -32602` |
| bad arguments | `-32602` `InvalidParams`, `"Input validation error: Invalid arguments for tool <name>: …"` — `:1429-1432` | generic `ProtocolError`, `code: -32602` |
| the tool's own handler fails | no JSON-RPC error: `tools/call` returns `isError: true` content — `:526-535` | an `isError` result, which DSH rethrows as a plain `Error` (`src/tools.ts:310-311`) |
| unknown method | `-32601` `MethodNotFound` | generic `ProtocolError`, `code: -32601` |

Client side, `Protocol._onresponse` settles every error response through `ProtocolError.fromError(code, message, data)` (`dist/src-D_zzAWoS.mjs:5967`), and `fromError` specialises exactly four shapes: `UrlElicitationRequired` (needs `data.elicitations`), `UnsupportedProtocolVersion`, `ResourceNotFoundError` (needs `data.uri`, which a tool miss does not carry) and `MissingRequiredClientCapability`. Everything else, including both `-32602` rows above, stays a plain `ProtocolError`. There is no `McpError` anywhere in this version's dist — the error classes are `ProtocolError` with those four subclasses, plus `SdkError` for SDK-owned failures.

So the trigger is:

```ts
if (error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams) // -32602
```

and it cannot separate the two `-32602` rows: `.code` is identical, `.data` is absent from both, and only `.message` differs — server-authored text. `InvalidParamsError` and `MethodNotFoundError` are exported classes, but `fromError` never constructs them for a *response*, so an `instanceof InvalidParamsError` check is false on this path; they exist for handlers. A missing tool is not `-32601` either, which is a missing method.

### 3. What an eviction alone does, and the shape that heals in place

After a sync, each registered tool holds the definition captured at that sync and calls `client.callTool` with it (`src/tools.ts:151-154`). `tools/call` is not a cacheable verb: the client consults the response cache for exactly five methods (`prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, `tools/list`, `index.mjs:3567-4203`), and `tools/call` is not one of them. So the call path never reads the entry the hook evicted. The only thing that re-lists is a sync, and `syncTools` has one caller path: `enqueueSync`, called from `connectGeneration` (`src/connection.ts:357`) and from the `list_changed` handler (`:334`). There is no per-call sync.

The three shapes, by when the heal lands:

| Shape | What heals | Cost |
|---|---|---|
| eviction only | the next **reconnect** lists fresh instead of reusing the stale entry | one call on the error branch |
| eviction + re-sync | the next **call** runs against a registry that no longer holds the removed tool | one `tools/list` and a registry swap per `-32602` |
| neither | nothing; the window runs out | — |

The middle one is your shape with one addition, and it keeps the property you wanted — the failed call is never re-run:

```ts
} catch (error) {
  if (error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams) {
    responseCache.evict('tools/list')       // the entry is gone either way
    void refreshTools()                     // the supervisor's list_changed re-sync: enqueueSync -> syncTools('refresh')
  }
  throw error
}
```

No retry means "the call may have executed" never arises, which is the whole reason to prefer an eviction over a transparent retry. The price of a false positive (a genuine argument error) is one wasted `tools/list`, not a second execution, and that is why I would not spend the trigger on matching server text: §2's message is there if a narrower trigger is wanted, but it is not needed for safety. The re-sync is already serialized by the supervisor's `syncChain` and swaps registrations the way a `list_changed` re-sync does today (`:200-209`). The one plumbing detail is that `refreshTools` currently lives inside `connectGeneration`, so the call closure would need it (or the eviction would have to move to a wrapper the supervisor passes into `syncTools`) — that is wiring, not design.

Even the eviction-only row is worth its line if the guarded version is deferred: it costs nothing and it stops the *next* reconnect from serving the entry the connection already proved stale.

### 4. The idiom already ships, keyed on a code the transport owns

`callTool` contains the evict → re-list → retry-once shape in-tree, for a mechanical failure rather than a stale catalog: on `error.code === HEADER_MISMATCH_ERROR_CODE` it evicts `tools/list`, re-lists with `'refresh'` and retries the call once (`index.mjs:4133-4150`). That code is `-32020`, the SEP-2243 `HEADER_MISMATCH` constant for an `MCP-Protocol-Version` or `Mcp-Method` header disagreeing with the body, and the branch is gated on `mirroringActive` (modern era, non-browser, `:4100`).

DSH passes `toolDefinition` on every call, and the guard reads `if (!mirroringActive || !isHeaderMismatch || options?.toolDefinition !== void 0) throw error`, so that branch rethrows here. Two things follow for this proposal: the evict-and-re-list half is an in-tree idiom rather than an invention, and its trigger is a code the *transport* owns. A stale tool name has no equivalent — which is exactly why item 3 is a policy choice rather than a lookup.

### 5. The other two asks

The generation-bump property is already in the post: "What drops the cached catalog", item 1, added in the 2026-10-04 in-place edit — the eviction deletes the partitions and bumps the per-method generation *before* deleting, so a `tools/list` walk already in flight cannot write its stale aggregate back over the invalidation. The live body and the copy in my repository are byte-identical at 9869 bytes (sha256 `07515a5bf297328a…`).

The "re-checking them changed one of my answers" sentence is in this thread's comment, not in the post: the body's Environment section carries "Re-checked 2026-10-04 at `dsh-v0.2.1-alpha.1`" but not the methodological line. Say the word and I will fold it in, together with the corrected item-3 wording above, so neither lives only in a comment.

Not verified here, and unchanged from the post: nothing in this comment has run against a live session; the re-sync hook is a sketch against the source, not a tested patch; and the `-32020` branch is on the HTTP transport, which I have not exercised.
