*Posted 2026-10-04 as [comment 18745138](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18745138) on [discussion #8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720).*

Thanks — all three invalidation conditions are the right frame for review, and re-checking them changed one of my answers. Conditions 1 and 2 turn out to be structural in the pinned SDK (no new code, and one of them *is* the cache key); condition 3 is the one that costs code, and the protocol makes it harder than the comment assumed on my behalf.

### 1. The three invalidation conditions

**`notifications/tools/list_changed` drops the entry — already structural.** The SDK maps the notification to the methods it invalidates (`LIST_CHANGED_EVICTIONS`, `@modelcontextprotocol/client` 2.0.0 `dist/index.mjs:2899-2903`) and evicts them from the client's inbound-notification path (`:3985-3989`). The eviction deletes both partitions of the connected server and bumps a per-method generation *before* deleting, so a `tools/list` walk already in flight cannot write its stale aggregate back over the invalidation (`evict` `:1971`, the guard in `write` `:2071`). This is not gated on a handler being registered. DSH additionally re-syncs from its own `listChanged.tools.onChanged` (`src/connection.ts:263-268` -> `refreshTools` `:296-305` -> `enqueueSync` `:323`), and that path stays on `'refresh'`. Nothing to add.

**A server identity or version change is a miss — also structural, because it is the key.** An entry is partitioned by `JSON.stringify([serverIdentity, principal])` (`_partitionFor` `:1922-1924`), and the identity is recorded immediately after a successful connect as `serverInfo.name@version`, else the transport's `sessionId`, else a per-connection anonymous surrogate (`_deriveServerIdentity` `:3398-3402`, called at `:3243`, `:3296`, `:3359`). A server that returns as a different version therefore reads and writes a different partition: the previous generation's listing is unreachable and the catalog is fetched. An anonymous server gets a fresh surrogate every generation and is never reused at all — no identity, no reuse.

One case neither condition covers, and it is the one condition 3 is for: a redeploy that changes the tool set while keeping the same `name@version` and never sending `list_changed`. Inside `catalogReuseTtlMs` that is indistinguishable from the same server.

**An unknown tool cannot be a typed check, and I have not built it.** I had assumed MCP gave a client something to match on. It does not. From the reference server (`@modelcontextprotocol/server` 2.0.0, `dist/mcp-DXXb3Vv3.mjs`):

| Failure | Wire response |
|---|---|
| unknown tool | `ProtocolError(InvalidParams, "Tool <name> not found")` — `:1396` |
| bad arguments | `ProtocolError(InvalidParams, "Input validation error: Invalid arguments for tool <name>: ...")` — `:1429-1432` |
| the tool's own handler throws | not a JSON-RPC error at all: `tools/call` returns `isError: true` content — `:526-535` |

"This tool is gone" carries the same code as "your arguments were wrong", separated only by server-authored text. So there are two honest shapes, and which one ships is a maintainer call rather than something to smuggle into a cache patch:

1. **Omit it.** Conditions 1 and 2 plus the window leave only the same-version-redeploy case open.
2. **Build it as its own change.** That needs two things this patch does not have: knowing whether the live registrations came from a reuse (the SDK reports no hit/miss, so the store would have to be wrapped to observe `get`, otherwise the trigger fires on every unknown-tool error), and a supervisor-level re-list + re-register + retry that fires only on a JSON-RPC error response, never on a timeout, so a call that may have executed is never executed twice.

The idiom is not new: `callTool` already does evict -> `listTools(..., { cacheMode: 'refresh' })` -> retry once, for a header-mismatch failure (`index.mjs:4133-4150`). Option 2 is that shape with a different trigger. Say which is wanted and it becomes its own write-up instead of a third hunk here.

### 2. The API, and the concrete two lines

The seams by name, all `@modelcontextprotocol/client` 2.0.0:

- `ClientOptions.responseCacheStore?: ResponseCacheStore` (`dist/index.d.mts:1750`), with `InMemoryResponseCacheStore` (`:1501`) as the default. The cross-reconnect keep-alive is `ClientResponseCache.resetForReconnect()`: `if (!this._isUserSupplied) this._store.clear()` (`index.mjs:2136-2142`) — the default store is connection-scoped, a supplied one is not.
- `CacheMode = 'use' | 'refresh' | 'bypass'` (`index.d.mts:1393`), and `_serveFromCache` consults the cache for every disposition that is not `'refresh'` or `'bypass'` (`index.mjs:3724-3725`). So `'use'` is the SDK's default and DSH's hard-coded `'refresh'` is what suppresses reuse today.
- `ClientOptions.defaultCacheTtlMs` (`index.d.mts:1772`) fills a missing field only: `const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : this._defaultCacheTtlMs` (`index.mjs:3704-3706`). Freshness is `expiresAt > now()`, with `expiresAt = now + min(max(0, ttlMs), MAX_CACHE_TTL_MS)` and the 24 h ceiling at `:1828`.

The two lines are these; everything else in the diff is the option field, its validation, and tests:

```ts
// connection.ts — one store per supervisor, handed to every generation it creates
const responseCache = new InMemoryResponseCacheStore()
const opts: ToolBridgeOptions = { ..., cacheMode: 'refresh' }        // initial connect + list_changed re-syncs

new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, {
  capabilities: {},
  versionNegotiation: { mode: 'auto' },
  responseCacheStore: responseCache,                                  // (1)
  defaultCacheTtlMs: policy.catalogReuseTtlMs,
  listChanged: { /* unchanged */ },
})

// the connect sync may reuse; the initial connect and every list_changed re-sync pass 'refresh'
await enqueueSync(generation, startup ? startupOpts : reconnectOpts)  // (2), reconnectOpts.cacheMode = 'use'
```

`syncTools` then stops hard-coding the disposition: `client.listTools(undefined, { cacheMode: opts.cacheMode })` replaces `{ cacheMode: 'refresh' }` (`src/tools.ts:123`).

One consequence that is not obvious from "cache the catalog": `defaultCacheTtlMs` is not tools-specific. `readResource` goes through the same cache front (`index.mjs:3802-3803`), so the patch pins the resource path to `cacheMode: 'bypass'`; without that, a catalog lifetime could start serving `resources/read` bodies. `syncTools` also passes the listed definition on every call (`src/tools.ts:138-141`), so a reused entry's only job is registration — the call path never consults it.

### 3. Baseline, and the head you asked about

- Measured against `3e6ed5f11f` (`dsh-v0.2.0-rc.2` plus one commit).
- Your numbers hold: `0.1.7-rc.2 -> 0.2.1-alpha.1` is **714 commits** (GitHub compare, `ahead_by: 714`), and `dsh-v0.2.1-alpha.1` (published 2026-10-03T06:42:19Z) is `master` at `5badb15009ae1756c3afe0ae0cef1faafc290ccc`.
- **`dsh-mcp-client` is still unwired at that head**, verified by content hash rather than by reading: `src/tools.ts` and `src/connection.ts` are blobs `9e7b5c0ab550dc2f2074126ca08c07b12f65dcce` and `9a4ec9123aea0e416178b45da6e788bade46274f` at both the baseline and the tag — the same bytes, so `:123` still passes `{ cacheMode: 'refresh' }` and `:258` still constructs the `Client` with no store and no `defaultCacheTtlMs`.
- The published artifact agrees, which is the version a deployment would actually load: `@deepseek-ai/dsh-mcp-client@0.2.1-alpha.1` contains zero occurrences of `responseCacheStore` or `defaultCacheTtlMs` across all 11 files in its tarball, and `lib/index.js:129` still calls `listTools(void 0, { cacheMode: "refresh" })`.
- One correction on the dist-tags, because it points a reader at a different package: on `@deepseek-ai/dsh`, `latest` is `0.2.0-rc.2` and `alpha` is `0.2.1-alpha.1`, as you said; on `@deepseek-ai/dsh-mcp-client`, the package this change lands in, they are `latest: 0.0.1-rc.1`, `next: 0.2.0-rc.2`, `alpha: 0.2.1-alpha.1`.

### 4. On the "introduces a stale tool table" reading

Worth stating in the post, because it is what a reviewer should hold the change to: reuse is not unconditional. The client reuses only where the server declared a lifetime (or where the operator's fallback covers a server that declares nothing), only under the same declared identity, only inside `catalogReuseTtlMs`, and any trigger above drops the entry — including `list_changed`, which the SDK applies on its own. The remaining gap is the same-version redeploy, and that is the open question in item 1 rather than something the patch hides.

Not verified, and unchanged from the post: no live session here has reconnected against a server that declares a positive `tools/list` TTL, so in this deployment the change stays inert until one does.
