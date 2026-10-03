# MCP tool catalogs are now reusable across a reconnect

The S-effort Tier-3 item from [`../research/UPLIFT-PLAN.md`](../research/UPLIFT-PLAN.md) (§3.8, raw
report R5): a transport drop should not force a fresh `tools/list` when the client is still holding
the catalog the server gave it.

| | |
|---|---|
| **Patch** | [`mcp-catalog-reuse.patch`](mcp-catalog-reuse.patch) — 546 lines, 7 files, +283/−15 |
| **Applier** | [`mcp-catalog-reuse.mjs`](mcp-catalog-reuse.mjs) — `--check` / `--revert`, git-verified hunks |
| **Probe** | [`mcp-catalog-reuse-probe.mjs`](mcp-catalog-reuse-probe.mjs) — the SDK behaviours this rests on |
| **Applied** | `packages/mcp/mcp-client` in `/Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src` at `3e6ed5f11f` |
| **Verified** | 133 unit tests, 25 e2e tests, oxlint clean, applier round-trip byte-exact |
| **Filed** | [discussion 8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720) (Ideas), 2026-10-03 — copy in [`../research/upstream/PROPOSAL-mcp-catalog-reuse.md`](../research/upstream/PROPOSAL-mcp-catalog-reuse.md) |

## The change

| File | Change |
|---|---|
| `src/connection.ts:153` | One `InMemoryResponseCacheStore` per plugin instance, shared by every transport generation |
| `src/connection.ts:295-296` | That store and `defaultCacheTtlMs` passed to each generation's `Client` |
| `src/connection.ts:169-172` | `reconnectOpts`: a reconnect lists with `cacheMode: 'use'`; `catalogReuseTtlMs: 0` turns it back into `'refresh'` |
| `src/connection.ts:407` | Resource reads pinned to `'bypass'`, so the catalog's lifetime cannot start serving resource bodies |
| `src/tools.ts:136` | `syncTools` passes the disposition instead of hard-coding `'refresh'` |
| `src/connection.ts:41-47,90,104-111` | `reconnect.catalogReuseTtlMs`, default `300000`, validated against the SDK's own 24 h ceiling |
| tests | 5 unit + 3 e2e, including a control that fails without the change |

## Why the raw plan changed

R5 proposed a new `packages/mcp/mcp-client/src/catalog-cache.ts` — a bounded LRU mirroring Codex's
`tool_catalog_cache.rs`. **Do not build that.** The pinned SDK (`@modelcontextprotocol/client`
2.0.0, the version `mcp-client` depends on) already ships the machinery, and a second cache in DSH
would be weaker than it in three ways at once:

- `ClientOptions.responseCacheStore` is a caller-supplied store, and `ClientResponseCache.resetForReconnect()`
  clears the **default** store while explicitly preserving a supplied one — *"a user-supplied store
  is NOT — that would defeat the only reason to supply one"*. That is precisely the cross-reconnect
  seam R5 wanted to build by hand.
- `CacheMode = 'use' | 'refresh' | 'bypass'` already exists; R5's "keep `refresh` for the initial
  connect and for genuine `listChanged` notifications" is a per-call argument, not new code.
- The SDK already scopes entries by connected-server identity and partition, caps the TTL at 24 h,
  and evicts on `list_changed`. A hand-rolled LRU would have to reimplement all of it.

So the patch is the two things DSH was missing — a shared store, and asking for a cached list on a
reconnect — plus the policy for servers that declare nothing.

## The protocol detail that decided the design, and it is not obvious

Measured, not read: the fixture server's `tools/list` result body carries **`ttlMs: 0`** on the
2026-07-28 revision. The server framework emits `{ ttlMs: 0, cacheScope: 'private' }` for any server
that declares no cache hint — the spec's "immediately stale" — and the client honours an explicit
server value over `ClientOptions.defaultCacheTtlMs`. The store trace shows the consequence exactly:

```
set {"method":"tools/list","params":"","partition":"[\"fixture-server@1.0.0\",\"\"]"} expiresAt=… (gen 1)
get {"method":"tools/list","params":"","partition":"[\"fixture-server@1.0.0\",\"\"]"} -> HIT expiresAt=…
_probe(tools/list) -> {"…","ttlMs":0,"cacheScope":"private",…}
now=… expiresAt=… fresh=false
read(tools/list) -> undefined        <- the hit is rejected, and the client lists again
```

Three consequences shaped the patch:

1. A client-side TTL cannot make a server that declares `ttlMs: 0` reusable, and should not try.
   The reconnect sync therefore only *permits* reuse; the freshness decision stays the server's.
2. `catalogReuseTtlMs` is a **fallback**, not an override: it supplies a lifetime only where the
   server is silent (the 2025-era and non-SDK case, which is where the original re-list cost was
   paid). A declaring server always wins.
3. `0` had to become a real switch — passing `'use'` with a zero TTL is indistinguishable from
   `'refresh'`, so an operator who wants today's behaviour needs the mode itself to change
   (`src/connection.ts:171`).

## Evidence

**Suites** (`vitest`, in the checkout):

```
packages/mcp/mcp-client/tests/                          133 passed (9 files)   [baseline 128]
packages/mcp/mcp-client/tests/mcp-client.e2e.ts          25 passed (1 file)    [baseline 22]
oxlint --config .oxlintrc.json packages/mcp/mcp-client   0 warnings, 0 errors
```

**The e2e tests measure the behaviour, not the wiring.** The fixture respawns with one more tool
than its first generation, so only a fresh `tools/list` can see it; the assertion is whether the
completed re-sync saw it (`tests/mcp-client.e2e.ts:379-400`).

| Scenario | Result |
|---|---|
| Server declares `ttlMs: 60000` | reuses the pre-drop catalog (`revived` absent) |
| Server declares nothing (framework's `ttlMs: 0`) | lists again — the protocol default is respected |
| `catalogReuseTtlMs: 0`, server declares 60 s | lists again — the switch works |

**The control run.** With only `src/connection.ts` and `src/tools.ts` reverted to `HEAD` and every
test change left in place:

```
FAIL  reuses the catalog across a reconnect when the server declares it cacheable
      AssertionError: … expected true to be false
FAIL  lists again on a reconnect when catalog reuse is disabled
      Error: mcp-client(reuseoff): reconnect.catalogReuseTtlMs is not a reconnect option
      Tests  2 failed | 3 passed | 20 skipped
```

That is the direction that matters: the new test fails on unmodified source, so it is detecting the
change rather than passing vacuously.

**Isolated SDK probes** (`mcp-catalog-reuse-probe.mjs`, not part of the suite) establish the
mechanism the patch relies on — one store, two `Client` instances:

```
session 1 (refresh, stable):        tools=["stable"]              notices=[]
session 2 (use, +extra tool):       tools=["stable"]              <- shared store reused
session 3 (refresh, +extra tool):   tools=["stable","extra"]      <- refresh always lists
session 4 (use, default store):     tools=["stable","extra"]      <- no store, no reuse
```

**Applier round-trip.** `--revert` → working tree empty; `--check` → "applies cleanly"; apply →
identical file hashes to the tested tree; `--check` → "applied"; re-apply → "already applied".

## What is not verified

- **No typecheck and no coverage run.** `oxlint` is the only static gate that ran; `tsc -b` and the
  repository's per-file 100 % coverage gate were not, so neither new branch is coverage-attested.
- **No live DSH session.** Every result above comes from the package's own unit and e2e lanes. No
  running desktop session has reconnected against a server that declares a positive `tools.list`
  TTL, which is the production shape of this change.
- **No real server was checked for a declared TTL.** Whether any server in this deployment grants a
  reusable catalog is unmeasured. If none does, the change is inert here until one does — which is a
  server-side decision, not a defect in the patch.
- `lib/` is gitignored build output, so nothing was rebuilt; `pnpm build` regenerates
  `lib/types/tools.d.ts` and `lib/types/connection.d.ts` with the new fields.

## What this does not buy

The queue note that placed this item *on the critical path for the 63 %-of-tool-bytes finding* is
wrong, and worth correcting where it was written. The tool block's 35 SAGE tools cost ~37 KB on
every request, and a cached catalog across a reconnect does not remove one byte of it: the same
definitions are registered either way. Reducing those bytes needs MCP definitions that can be
declared deferred (UPLIFT-PLAN §3.2), which the scorecard measured and dropped — 4.5 % of a real
request, 1.4 % of the window. This patch is a reconnect-cost and availability item: with it, a
flapping or slow server no longer has to answer `tools/list` before its tools are usable again.

## Filed

[Discussion 8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720), category
**Ideas**, posted 2026-10-03. DSH declines external pull requests and names GitHub Discussions as the
channel ([`UPSTREAM-REPORTS.md`](UPSTREAM-REPORTS.md)); the bug channel there is `General`, so a
proposal belongs in `Ideas` instead.

The post carries the two behaviours, the SDK seams they use, the `ttlMs: 0` measurement, the test
evidence including the control direction, and the open question: whether a client-side fallback for
a server that declares nothing is the semantics the maintainers want, or whether reuse should be
strictly server-declared. The posted body was verified byte-identical to the copy in this repository.
