# Reuse a server-declared tool catalog across an MCP reconnect

**This is a proposal, not a defect report.**

`dsh-mcp-client` lists a server's tools again on every reconnect. The MCP client library DSH pins already caches cacheable results, and already keeps a caller-supplied cache alive across a reconnect. `dsh-mcp-client` supplies neither the store nor the cache mode, so the cache is rebuilt empty for every transport generation. Two lines of intent close that gap; one policy question decides the rest.

## Current behavior

`packages/mcp/mcp-client/src/tools.ts:123` always refreshes:

```ts
: await client.listTools(undefined, { cacheMode: 'refresh' })
```

`packages/mcp/mcp-client/src/connection.ts:258` creates a new `Client` per transport generation and passes no `responseCacheStore`, so each generation gets the SDK's default fresh store. A reconnect therefore pays a fresh `tools/list` before the server's tools become usable again, and the supervisor retries the whole attempt up to `reconnect.maxAttempts` (default 10) per outage.

Refreshing is the right behavior for a first connect and for a server-reported change. The reconnect case is the one that pays twice: the client still holds the previous generation's registrations and the catalog they came from.

## What the pinned SDK already does

From `@modelcontextprotocol/client` 2.0.0, which `dsh-mcp-client` depends on:

- `ClientOptions.responseCacheStore` backs the cache. Per `ClientResponseCache.resetForReconnect()`, a supplied store is explicitly **preserved** across a connection reset while the default per-client store is cleared — "a user-supplied store is NOT — that would defeat the only reason to supply one".
- `CacheMode` already distinguishes `'use'` (serve a still-fresh entry without a round trip), `'refresh'` (always fetch and re-store), and `'bypass'`.
- Entries are keyed by `[serverIdentity, cachePartition]`, capped at `MAX_CACHE_TTL_MS` (24 h), and evicted by `list_changed` for the connected server's partitions only.

The missing pieces are DSH-side: share one store across the generations a supervisor creates, and ask for `'use'` on the sync a reconnect performs.

## The measurement that decides the policy

On the 2026-07-28 revision a cacheable result carries `ttlMs` and `cacheScope` (SEP-2549). Two behaviors interact, and neither side shows the result alone:

1. The server framework emits the conservative defaults `{ ttlMs: 0, cacheScope: 'private' }` for a server that configures no `cacheHints`. `0` is the spec's "immediately stale".
2. The client honors an explicit server `ttlMs` over `ClientOptions.defaultCacheTtlMs`. The client default fills only a missing field.

A trace from a real stdio connection against `@modelcontextprotocol/server` 2.0.0 shows the consequence. The store returns a hit, and the client lists again anyway. The store lines and the decision lines below come from two runs of the same scenario, one instrumenting the store and one wrapping the client's cache read:

```
set {"method":"tools/list","params":"","partition":"[\"fixture-server@1.0.0\",\"\"]"} expiresAt=…+300000
get {"method":"tools/list","params":"","partition":"[\"fixture-server@1.0.0\",\"\"]"} -> HIT expiresAt=…
_probe(tools/list) -> {"…","ttlMs":0,"cacheScope":"private",…}
now=… expiresAt=… fresh=false
read(tools/list) -> undefined
```

A client cannot make a server that declares `ttlMs: 0` reusable, and should not try. The change below therefore permits reuse rather than forcing it.

## Proposed change

One cache per plugin instance, shared by every generation it creates; `'use'` for the sync a reconnect performs; `'refresh'` unchanged everywhere else.

```ts
// connection.ts — one store per supervisor, shared by every generation
const responseCache = new InMemoryResponseCacheStore()
const reconnectOpts: ToolBridgeOptions = {
  ...opts,
  cacheMode: policy.catalogReuseTtlMs > 0 ? 'use' : 'refresh',
}

new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, {
  capabilities: {},
  versionNegotiation: { mode: 'auto' },
  responseCacheStore: responseCache,
  defaultCacheTtlMs: policy.catalogReuseTtlMs,
  listChanged: { /* unchanged */ },
})

// the initial connect and every listChanged re-sync keep 'refresh'
await enqueueSync(generation, startup ? startupOpts : reconnectOpts)
```

`syncTools` passes the disposition through instead of hard-coding `'refresh'`.

`defaultCacheTtlMs` applies to every cacheable verb, so the same patch pins resource requests to `cacheMode: 'bypass'`. Without that, a catalog lifetime could start serving `resources/read` results.

## The open question

A server that declares a lifetime should have it reused across a reconnect. That part is not in question. What is undecided is the **fallback**: should a server that declares nothing — every 2025-era server, and any 2026-era server that does not configure `cacheHints` — get a client-side lifetime anyway?

The patch as written does, through `reconnect.catalogReuseTtlMs`, defaulting to 300000 ms. The window is sized to cover an outage the retry budget could still be retrying: 10 attempts with delays doubling to the 30 s ceiling is about 2.5 minutes. Setting the option to `0` disables reuse entirely, which keeps today's behavior available per server.

The fallback is there because the era that re-lists most is the era that cannot say "cache me". Strictly server-declared reuse would drop `defaultCacheTtlMs` and keep the rest of the change.

## Evidence

Against `3e6ed5f11f` with the change applied:

- `packages/mcp/mcp-client/tests/` — 133 passed (128 before).
- `packages/mcp/mcp-client/tests/mcp-client.e2e.ts` — 25 passed (22 before).
- `oxlint` over the package's `src` and `tests` — clean.

Each new e2e test respawns the fixture server with one more tool than its first generation, so only a fresh `tools/list` can see the extra tool:

| Server declaration | Reconnect result |
|---|---|
| `cacheHints: { 'tools/list': { ttlMs: 60000 } }` | reuses the catalog (extra tool absent) |
| none (the framework emits `ttlMs: 0`) | lists again — the conservative default is respected |
| 60 s declared, `catalogReuseTtlMs: 0` | lists again — the switch works |

Reverting only `src/connection.ts` and `src/tools.ts` to HEAD, with every test change kept, fails the first test (`expected true to be false`) and the third (`reconnect.catalogReuseTtlMs is not a reconnect option`). The tests detect the behavior rather than passing vacuously.

Not verified here: no `tsc -b` typecheck and no coverage run (`oxlint` is the only static gate that ran), no live desktop session, and no production server was checked for a declared `tools/list` TTL. If no server declares one, the change is inert until one does.

## Environment

- Source: `3e6ed5f11f` (`dsh-v0.2.0-rc.2` plus later commits), package `packages/mcp/mcp-client`
- `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/server` 2.0.0
- The full patch is 546 lines across 7 files; everything outside the two hunks above is tests and the configuration field.
