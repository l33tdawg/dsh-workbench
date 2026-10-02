# 08 — Verification Loops, Code Intelligence, and Developer Experience

**Axis:** what each harness gives the model for knowing the codebase, finding symbols, getting
diagnostics after an edit, running tests, running long jobs, and reporting results — plus
observability, search, and engineering maturity.

| | DSH | Codex |
|---|---|---|
| Revision | `639ed015397290b3745d163aafe02ffee4aa3f84` — "Merge pull request #5479 … release-dsh-0.2.0-rc.2" | `2abb02bc0` |
| Source root | `/Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src` | `/Users/l33tdawg/nodejs-projects/codex` |
| Language / layout | TypeScript, pnpm workspace, ~3,754 `.ts` files under `packages/` | Rust, cargo+bazel workspace, ~3,434 `.rs` files under `codex-rs/` |

Evidence markers: **[V]** = I read the cited code/markdown at that revision. **[I]** = inference from
name/structure/documentation, not from reading the implementation.

---

## 0. Verdict on the axis

**Codex has no LSP integration of any kind.** `codex-rs/lsp/` does not exist **[V]**, and a
case-insensitive search for `lsp` / `textDocument` / `language server` across `codex-rs` returns only
substring false positives such as `LoadableToolSpec` **[V]**. `codex-rs/diagnostics/` is unrelated to
code diagnostics — it is a process-wide gauge registry (`Gauge`, `GaugeGuard`, `increment`/
`decrement`) **[V]**.

**DSH has a real LSP client — but it is read-only navigation with four operations and *deliberately no
diagnostics*.** `packages/lsp/lsp/src/types.ts:17` defines the closed union as
`'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'` **[V]**. Diagnostics are
excluded by design, stated twice in the package README **[V]** and enforced in code: every
server→client notification — the LSP channel that carries `textDocument/publishDiagnostics` — is
dropped on the floor at `packages/lsp/lsp-stdio/src/connection.ts:248` ("A server→client
notification (e.g. diagnostics, logs): ignored by this MVP host.") **[V]**.

So neither harness feeds language-server diagnostics back into the edit loop. The difference is that
DSH *could* with modest work (the transport, lifecycle, and provider registry already exist), while
Codex has no LSP substrate at all.

Everything else on the axis splits less cleanly — see §6 for where DSH is clearly ahead.

---

## 1. Codebase intelligence: symbols, types, diagnostics

### 1.1 DSH LSP — architecture

Three packages, cleanly split as a capability seam (Service Definition / Service Provider / Consumer):

| Package | Role | Evidence |
|---|---|---|
| `packages/lsp/lsp/` | The `ctx.lsp` seam: provider selection by extension, four normalized read-only operations | `packages/lsp/lsp/README.md:25` **[V]** |
| `packages/lsp/lsp-stdio/` | Generic stdio backend; drives configured server commands over `ctx.fs` + `ctx.subprocess` | `packages/lsp/README.md:26` **[V]** |
| `packages/lsp/tool-lsp/` | The single model-facing `lsp` tool | `packages/lsp/README.md:27` **[V]** |

**Operations (exactly four).** `LspOperation` is a closed union and the file's own header says the
seam "exposes no protocol types, process or document controls, or generic JSON-RPC escape hatch —
only the four semantic operations" (`packages/lsp/lsp/src/types.ts:6,17`) **[V]**. Symbol search and
call hierarchy are explicitly deferred "because they need different schemas"
(`packages/lsp/lsp/README.md:129`) **[V]**.

**Model-facing schema.** One tool named `lsp`, four required args (`operation`, `file_path`, `line`,
`character`), one-based UTF-16 cursor coordinates converted to the seam's zero-based positions
(`packages/lsp/tool-lsp/src/index.ts:109-123, 184`) **[V]**. Result caps: `maxLocations` default 100,
`maxResultChars` default 16,000 (`packages/lsp/tool-lsp/src/render.ts:18,21`) **[V]**. Per-call
timeout budget `DEFAULT_LSP_TOOL_TIMEOUT_MS = 60_000` enforced through the tool-call timeout policy
(`packages/lsp/tool-lsp/src/index.ts:50,182`) **[V]**.

**Language coverage: zero shipped.** The lsp group README states plainly: "Deployments must supply and
configure their language servers; this group ships none" (`packages/lsp/README.md:12`) **[V]**. The
`lsp-stdio` plugin *requires* a non-empty `servers` table and throws otherwise
(`packages/lsp/lsp-stdio/src/index.ts:105-107,128`) **[V]**. A grep for `tool-lsp`, `lsp-stdio`,
`typescript-language-server`, `rust-analyzer`, `pyright`, or `gopls` across `packages/` and `apps/`
(excluding `packages/lsp/` itself) finds only a devDependency in `packages/ssh/ssh/package.json:80`
and its live test **[V]**. **`tool-lsp` is not mounted by any shipped profile or agent preset** —
`packages/bundle/web-app/presets/standard.patch.yml:10-45` lists the standard preset's plugins
(`persona`, `agent-instructions`, `tool-bash`, `tool-pwsh`, `tool-fs`, `tool-fs-search`, `tool-jobs`,
`skill-filesystem`, `tool-skill`, `tool-goal`, `plan-mode`, …) with no `tool-lsp` **[V]**. Effective
language coverage in a default DSH session is therefore **none**.

**Server management.** One plugin instance per named server; each lazily single-flights one process per
canonical workspace target (`packages/lsp/lsp-stdio/src/index.ts:216-238, 332-339`) **[V]**. Queries
are serialized per workspace through a promise-queue tail (`:318-329`) **[V]**. A transport that dies
is disposed and retried once, transparently, because queries are read-only (`:307-312`) **[V]**.
Teardown: unregister routes first, then `shutdown`/`exit` within `shutdownTimeoutMs` (5,000 ms default)
escalating over `killGraceMs` (2,000 ms) (`:52-53, 179-185`) **[V]**. Bounds: `maxMessageBytes`
16 MB, `maxStderrBytes` 1 MB, `maxDocumentBytes` 4 MB (`:49-51`) **[V]**.

**Document lifecycle: transient open → query → close.** Each query performs
`textDocument/didOpen` with `version: 1` and the full file text, then the request, then
`textDocument/didClose` (`packages/lsp/lsp-stdio/src/instance.ts:159-177`) **[V]**. A server that does
not support transient `didOpen` is rejected with `LSP_UNSUPPORTED_OPERATION`
(`instance.ts:150`) **[V]**. Only `utf-16` position encoding is negotiable; anything else is a protocol
error (`packages/lsp/lsp-stdio/src/translate.ts:91-99`) **[V]**.

### 1.2 Is DSH's LSP wired into the edit loop?

**No — and the design says so on purpose.**

1. The prompt guidance positions LSP as a **pre-edit precision aid**, not a post-edit check:
   `LSP_PROMPT_TEXT` = "Use search/read for ordinary navigation. Use lsp when textual matches are
   ambiguous or **before a change requires precise definitions, implementations, or references**."
   (`packages/lsp/tool-lsp/src/index.ts:53-54`) **[V]**.
2. Diagnostics are named as a deliberate omission, twice: "Navigation is read-only and deliberately
   excludes generic JSON-RPC access, rename, formatting, **diagnostics**, and symbol lists"
   (`packages/lsp/lsp/README.md:12`) and "symbols and call hierarchy are deferred because they need
   different schemas; **diagnostics need separate freshness and accumulation rules**"
   (`packages/lsp/lsp/README.md:129`) **[V]**.
3. The transport physically discards diagnostic notifications (`connection.ts:248`) **[V]**.
4. There is no persistent document state. Because every query opens and closes the document
   (`instance.ts:159,177`), there is no versioned buffer a diagnostics read could be attributed to —
   consistent with the README's "freshness and accumulation rules" gap **[V]** as a mechanism, **[I]**
   as motivation.
5. Nothing in the tool surface reacts to `edit`/`write`. A grep for `tools/post-execute` consumers
   whose body mentions test/lint/typecheck/diagnostics returns nothing **[V]**. DSH's interception
   surface (`tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` →
   `finalizeContent` → `tools/result`) *would* allow a post-edit diagnostics hook
   (`.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md`) **[V]**, but no
   package implements one.

### 1.3 What the model actually uses to know the codebase

**DSH:** `glob` and `grep` (packaged ripgrep through `ctx.subprocess`, no host `rg`, no shell layer)
plus `read` / `read_image`, plus the optional `lsp` tool, plus workspace instruction files via
`agent-instructions` (AGENTS.md-compatible, 65,536-byte budget, `dsh-base` default)
(`packages/fs/README.md:12`; `packages/context/agent-instructions/README.md:12`) **[V]**.

**Codex:** **there is no model-facing `grep`, `read_file`, or `list_dir` tool.** The exported handler
list is `ApplyPatchHandler`, `CurrentTimeHandler`, `DynamicToolHandler`, `GetContextRemainingHandler`,
`ListAvailablePluginsToInstallHandler`, `McpHandler`, `ListMcpResourcesHandler`,
`NewContextWindowHandler`, `PlanHandler`, `RequestPermissionsHandler`, `RequestUserInputHandler`,
`SendUserMessageAsyncHandler`, `SleepHandler`, `TestSyncHandler`, `ExecCommandHandler`,
`WriteStdinHandler`, `ViewImageHandler` (`codex-rs/core/src/tools/handlers/mod.rs:55-80`) **[V]**.
The model-visible plain tool names in `codex-rs/core/src/tools/` are `exec_command`, `write_stdin`,
`apply_patch`, `view_image`, `update_plan`, `request_permissions`, `tool_search`, `web_search`,
`sleep`, plus multi-agent control tools **[V]**. Codebase intelligence in Codex is therefore
"run `rg`/`sed`/`ls` through the shell" — powerful and unbounded, but unstructured, unranked, and
entirely dependent on the model writing correct shell.

---

## 2. Post-edit verification

**Neither harness runs an automatic test, lint, or typecheck after an edit. Both are model-discretion
plus a user-configurable hook point.**

### Codex — a long, explicit "Validating your work" prompt section

`codex-rs/core/prompt_with_apply_patch_instructions.md:149-163` **[V]**, mirrored byte-for-byte in
`codex-rs/protocol/src/prompts/base_instructions/default.md:149-163` **[V]**:

- `:151` "If the codebase has tests or the ability to build or run, **consider** using them to verify
  that your work is complete."
- `:153` "start as specific as possible to the code you changed … then make your way to broader tests
  as you build confidence … do not add tests to codebases with no tests."
- `:155` formatting: "you can iterate up to 3 times to get formatting right".
- `:161-163` approval-mode gating: in `never` mode, "proactively run tests, lint and do whatever you
  need"; in `untrusted`/`on-request`, "hold off on running tests or lint commands until the user is
  ready for you to finalize"; test-related tasks may run tests regardless of mode.
- `:189` the final message should offer next steps such as "running tests, committing changes".

This is a *rich, shipped* verification policy — but it is advice, and it is deliberately throttled by
approval mode.

### DSH — no equivalent shipped clause

The standard agent preset's entire persona is two sentences:
`prefix: "You are a coding agent powered by the {{model}} model."`,
`suffix: "Your working directory is {{cwd}}."`
(`packages/bundle/web-app/presets/standard.patch.yml:14-15`) **[V]**; the `ptc` preset is identical
(`presets/ptc.patch.yml:14-15`) and `minimal` is "You are a helpful software engineer assistant."
(`presets/minimal.patch.yml:14`) **[V]**. Persona text is *deployment config*, not code
(`packages/preset/persona/src/index.ts:29-49`) **[V]**. Verification discipline in DSH therefore comes
from three other places:

1. **Workspace instruction files** — `agent-instructions` injects the AGENTS.md/CLAUDE.md chain
   (`packages/context/agent-instructions/README.md:12`) **[V]**. This is the mechanism by which the
   DSH repo's own 184-line `AGENTS.md` reaches the model, including its
   "`test:coverage`, not `test`, is the CI coverage gate" and "report only commands run" rules
   (`AGENTS.md:118,120`) **[V]**. Note this is *observed live*: in the session authoring this report,
   the injected policy includes "Read an existing file before overwriting it … prefer edit for
   targeted changes" — i.e. the workspace-instruction channel is doing real work **[V, observed]**.
2. **Tool sections** — the `pty` section warns "An inferred_idle or timeout result does not prove the
   foreground command exited" (`packages/terminal/tool-terminal/src/index.ts:158-160`) **[V]**; the
   `lsp` section frames precision-before-change (§1.2) **[V]**.
3. **Loop-hygiene guards**, shipped enabled in the base bundle: `repeat-tool-reminder` (advisory
   reminders at 3, 5, and 8 identical repeats, cleared by a new user message) and `timeout-policy`
   (per-tool cooperative deadline returning a clear model error)
   (`packages/guard/README.md:12`; `packages/guard/repeat-tool-reminder/README.md:12`;
   `packages/guard/timeout-policy/README.md:6-8`) **[V]**. These protect against *stuck* loops, not
   against *unverified* work.

### Both: post-tool hook extension points exist, neither ships a verification hook

DSH runs `tools/post-execute` as an inspect/transform waterfall that may "block with feedback" or
attach `additionalContexts` **[V]**, and ships Claude Code / Codex `hooks.json` bridges supporting
`PostToolUse` (`packages/hooks/hook-protocol/README.md:69`; native hooks are "just an ordinary Cordis plugin subscribing to the canonical lifecycle events" (`.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md`, "Decision")) **[V]**.
Codex has the same shape: `PostToolUse` hook config
(`codex-rs/config/src/hook_config.rs:41-42`) executed by `run_post_tool_use_hooks`
(`codex-rs/core/src/hook_runtime.rs:272-287`) **[V]**. In both cases a user can wire "run `pnpm
typecheck` after every edit"; neither product does it by default.

### The one automatic post-edit artifact DSH has that Codex lacks

`packages/deliverables/workspace-changes/` snapshots the git working tree at top-level turn start and
turn end, diffs them, records per-file line counts, and copies every file-tool-edited file whole
before its first edit and again at turn end — covering files git does not. It appends one
`workspace/changes` session event naming the turn, and serves per-file comparisons on the Host
(`packages/deliverables/workspace-changes/README.md:12`) **[V]**. Defaults: `maxFiles` 500,
`maxFileBytes` 2,097,152, `outputMaxBytes` 8,388,608, `timeoutMs` 30,000, `diffTimeoutMs` 100
(`README.md:31-38`) **[V]**. It writes through a private index into a temporary object directory with
the real repository object store attached read-only as an alternate, so the developer's index, objects,
work tree, refs, and pre-existing uncommitted changes are untouched (`README.md:40`) **[V]**. This is
*evidence for the operator*, not a check run for the model — but it is the single best automatic
"what did this turn actually change" primitive in either harness.

---

## 3. Background jobs & long-running commands

### 3.1 Model-facing control surface

| Capability | DSH | Codex |
|---|---|---|
| Start long command | `bash(run_in_background: true)` → job id (`packages/shell/tool-bash/src/index.ts:393`); `terminal_send(run_in_background: true)` → job id (`packages/terminal/tool-terminal/src/index.ts:207`) | `exec_command` returns a `session_id` in its output when still running (`codex-rs/core/src/tools/handlers/shell_spec.rs:96-105, 214-218`) |
| Read output | `job_output(job_id, wait?, timeout_ms?)` (`packages/jobs/tool-jobs/src/index.ts:311-318`) | `write_stdin(session_id, chars: "", yield_time_ms)` — empty `chars` = poll (`shell_spec.rs:117-149`) |
| List | `job_list` (`tool-jobs/src/index.ts:352-354`) | none (one session id per call; no enumeration tool) |
| Kill | `job_kill(job_id, reason?)` (`tool-jobs/src/index.ts:372-376`) | none as a model tool; send Ctrl-C via `write_stdin` on a `tty` session, or kill from another shell command. `ProcessSignal` in the exec-server RPC enum has exactly one member, `Interrupt` (`codex-rs/exec-server-protocol/src/protocol.rs:389-401`) **[V]** |
| Blocking wait | `job_output(wait: true, timeout_ms)` — "a timed-out wait leaves the job running" (`tool-jobs/src/index.ts:317`) | `write_stdin` empty-poll default window 5,000–300,000 ms (`shell_spec.rs:134`) |
| Push completion notice | Yes — completion is delivered to the owning agent in-session via `agent.inject()`, not polled (`packages/jobs/README.md:12`; `packages/tool-catalog.md` row `@deepseek-ai/dsh-tool-jobs`: "`user/message` via `agent.inject()` for background completion notices") **[V]** | No — the model must poll |
| Ownership isolation | Jobs are fenced per owning agent session; "one agent never sees another's work" (`packages/jobs/README.md:12`) **[V]** | N/A — no job registry |
| Persistent interactive shell | Yes, first-class: six tools `terminal_open`, `terminal_send`, `terminal_read`, `terminal_signal`, `terminal_close`, `terminal_list` (`packages/terminal/tool-terminal/src/index.ts:164,199,302,335,360,391`) **[V]**; sessions keep cwd, env, and live child processes across calls (`packages/terminal/README.md:6`) **[V]** | `exec_command(tty: true)` + `write_stdin` — same effect, two tools, no session list/close |
| Signals | `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGTSTP`, `SIGHUP` to the foreground process group; shell-targeted `SIGKILL` rejected (`tool-terminal/src/index.ts:339`) **[V]** | `Interrupt` only via `write_stdin` **[V]**; `terminate_process`/`terminate_all_processes` exist in-process (`codex-rs/core/src/unified_exec/process_manager.rs:1647,1684`) and are surfaced to app-server clients (`codex-rs/app-server/src/request_processors/thread_processor.rs:2420`) but not as a model tool **[V]** |
| Read-without-sending | `terminal_read(sessionId, offset, count)` — bounded page, newest-relative offset (`tool-terminal/src/index.ts:302-307`) **[V]** | none distinct; empty `write_stdin` both polls and drains |
| Yield semantics | Explicit reason enum `stdin_read \| inferred_idle \| timeout \| session_exit` (`packages/terminal/terminal/src/types.ts:29`) **[V]** — a *typed* answer to "why did control come back" | Numeric `yield_time_ms` only (`shell_spec.rs:31-34,134`) |
| Defaults | bash background: "No timeout applies" (`tool-bash/src/index.ts:393`) **[V]** | `exec_command` yield 10,000 ms, effective range 250–30,000 ms (`unified_exec.rs:60-62`; `shell_spec.rs:33`); `write_stdin` 250 ms default (`unified_exec.rs:56-58`) |
| Output cap / spill | Truncated to tail, full output spilled to a file whose path is reported (`packages/shell/tool-bash/src/index.ts:94`) **[V]** | `max_output_tokens` defaults to 10,000 tokens, "larger requests may be capped by policy" (`shell_spec.rs:59-62`) **[V]** |

### 3.2 Underlying machinery

**DSH** separates concern cleanly: `jobs/` is the owner-fenced registry contract
(`ctx.jobs`), `jobs-local/` is the in-process implementation (with a ring buffer, pump, and typed
events), `tool-jobs/` is the model surface (`packages/jobs/README.md:25-29`) **[V]**. `terminal/`
splits the same three ways: session service, bash/pwsh backend under the shared sandbox policy with
readiness detection, and the six tools (`packages/terminal/README.md:25-29`) **[V]**. Job ids are
generic across kinds — "background bash commands, PTY sends, and subagents are read, listed, and
killed through the same three tools" (`docs/tool-catalog.md`, `@deepseek-ai/dsh-tool-jobs` row) **[V]**.
The design note is `.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md`
(referenced at `packages/jobs/README.md:33`) **[I]**.

**Codex** has a genuinely strong *execution* substrate: `codex-rs/core/src/unified_exec/` with
`process_manager.rs`, `async_watcher.rs`, `head_tail_buffer.rs`, `oneshot.rs`, `shell_snapshot.rs`,
`stdin_approval.rs`, and committed `snapshots/` **[V]**; and `codex-rs/exec-server/`, a JSON-RPC
server over `codex-utils-pty` with a Rust client (`ExecServerClient`), `ws://` transport, remote
registration, and a forward/relay mode (`codex-rs/exec-server/README.md:3-40`) **[V]**. The protocol
supports `Exec`, `Read`, `Write`, `Signal`, `Terminate`, plus filesystem RPCs
(`codex-rs/exec-server-protocol/src/protocol.rs:256-533`) **[V]**. This is materially more
sophisticated than DSH's local-only job registry *as infrastructure* — Codex can drive processes on a
remote environment. But **the model gets only two tools over it**, with no enumeration and no kill.

**Comparison.** DSH gives the model better *control* (poll with bounded wait, list, kill, push
completion, typed yield reason, persistent-terminal read/signal/close). Codex gives the model a better
*wire* (PTY, head/tail buffering, remote executors) with a thinner control surface. On the question as
asked — "which gives the model better control (poll, kill, output streaming)?" — **DSH wins on poll,
kill, and enumeration; the two are comparable on streaming** (DSH streams per-job deltas with lossy
marking via `ringDelta(read.chunks, read.lossy, …)`, `packages/shell/tool-bash/src/index.ts:356` **[V]**;
Codex streams chunked output with `chunk_id` and elapsed-time metadata,
`shell_spec.rs:204-224` **[V]**).

---

## 4. Observability: debugging a bad session

### 4.1 DSH

| Surface | What it gives | Evidence |
|---|---|---|
| Durable session log | JSONL persistence, one row per event, versioned format with migrating successors (`session-format-v0-to-v1` … `v3-to-v4`) and a monotonic SQLite `SCHEMA_VERSION` | `packages/session/` tree; `AGENTS.md:9` **[V]** |
| Model-visible ⟺ logged invariant | "anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event" | `AGENTS.md:143` **[V]** |
| Session query service | `ctx.sessionQuery`: exact reads, filtered lists, relationship traces, full-text search; SQLite **FTS5** index for search | `packages/session-query/README.md:12` **[V]** |
| Model-facing history tools | `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read` — "cursor-free and workspace-scoped", every result authorized from the immutable calling agent session | `packages/session-query/README.md:12`; `packages/session-query/tool-session-query/src/index.ts:51-57,66-109` **[V]** |
| Export | Web `/export` command downloads a session ZIP | `packages/session-query/README.md:28` **[V]** |
| Runtime invariants | `ctx.invariants`: package-owned checks that verify each package's durable event and data relationships **while the composition is live**; a violation is attributed to the owning package; global switch + package-name filters | `packages/runtime-diagnostics/README.md:12` **[V]** |
| Invariant hygiene | Companion `./invariant` wiring is mechanically gated; "empty installers and checks of service presence, plugin metadata, effects, or fixed examples are invalid" | `AGENTS.md:139`; `.agents/notes/implemented/architecture/2026-07-19-package-invariant-runtime-contracts.md` **[V]** |
| Telemetry | `ctx.otel.createEventReporter()` (SDK count-based batching) and `createSessionLogReporter()` (one complete event per record, `eventName: "session-log"`, `sessionId`, JSON `content`, ≤4,000,000 uncompressed request bytes, own queue, never shares a request with ordinary events). **No global OTel provider installed**; mount creates no transport and sends nothing | `packages/telemetry/otel/README.md:12,24,28` **[V]** |
| Feedback | `/feedback` session remark (fixed category taxonomy) + per-message ratings/notes; explicitly one-way — "Neither kind of feedback reaches the model"; per-message ratings "never appear in model history or telemetry" | `packages/feedback/README.md:12,33` **[V]** |
| Turn diff | `workspace/changes` event + per-file turn-start/turn-end comparison (§2) | `packages/deliverables/workspace-changes/README.md:12` **[V]** |
| Snapshot replay | Keyless recorded-session replay through shipped profiles: `DSH_SNAPSHOT=replay/record/refresh`; 415 recorded `session*.jsonl` fixtures under `snapshots/{session,sdk,acp,web}` | `package.json` scripts `test:snapshot*`; `docs/testing.md:14` **[V]** |
| GUI host/client split | `packages/host/` (GUI host) and `packages/client/` (GUI client) over a typed Remote layer | `AGENTS.md:66-67`; `packages/api/README.md:7` **[V]** |

**Weakness:** DSH's telemetry is deliberately *unwired by default* — "The service has no deployment
defaults or automatic collection policy of its own" (`packages/telemetry/otel/README.md:24`) **[V]**.
An operator debugging a bad session on a stock build has the session JSONL and the replay harness,
but no OTLP exporter running.

### 4.2 Codex

| Surface | What it gives | Evidence |
|---|---|---|
| Rollout | Versioned JSONL session files, an index, a reference index, a reverse JSONL scanner, a seekable reader, LLM-based search, compression, maintenance/GC, and SQLite state | `codex-rs/rollout/src/{recorder,list,search,reverse_jsonl_scanner,seekable_reader,session_index,rollout_reference_index,compression,maintenance,state_db}.rs` **[V]** |
| **Rollout trace (the standout)** | Opt-in via `CODEX_ROLLOUT_TRACE_ROOT` (`codex-rs/rollout-trace/src/thread.rs:44`). Writes a bundle: `manifest.json` (trace_id, rollout_id, root_thread_id), `trace.jsonl` (ordered raw event spine), `payloads/*.json` (large raw evidence). A **deterministic offline reducer** (`replay_bundle`) produces `state.json`: threads+turns, `conversation_items` (what the model saw), runtime objects (`inference_calls`, `tool_calls`, `code_cells`, `terminals`, `compactions`), interaction edges (spawn/task/result/close), and raw payload refs. Explicit design stance: **"observe first, interpret later"** — hot-path code writes ordered raw events, the reducer decides semantics offline | `codex-rs/rollout-trace/README.md` (privacy note, "What This Gives Us", mermaid system shape); `codex-rs/rollout-trace/src/bundle.rs:8-14` **[V]** |
| Privacy posture | "Rollout tracing is not telemetry. Codex does **not** upload or report these traces; it writes local bundles only when `CODEX_ROLLOUT_TRACE_ROOT` is set." Bundles can contain prompts, responses, tool I/O, terminal output, paths — "treat them as sensitive" | `codex-rs/rollout-trace/README.md:3-7` **[V]** |
| Tool dispatch trace | `codex-rs/core/src/tools/tool_dispatch_trace.rs` + tests | **[V]** (file existence) |
| OTel | Full OTLP stack: `MetricsConfig::otlp`, `LogExporter`/`SpanExporter`, `Protocol::{Grpc,Http}`, HTTP/gRPC+TLS, `OTEL_EXPORTER_OTLP_TIMEOUT`, a Statsig OTLP HTTP endpoint constant, metric-name registry, timer utility, process metrics, tag/validation layers, `SessionTelemetry` (1,334 lines) | `codex-rs/otel/src/{provider,otlp,config,metrics/names,metrics/timer,metrics/process,events/session_telemetry}.rs`; `codex-rs/otel/src/config.rs:9` **[V]** |
| TUI logs | `TUI_LOG_FILE_NAME = "codex-tui.log"` under the Codex home `log/` dir; `RUST_LOG`/`EnvFilter`; a separate `codex-logs.log` | `codex-rs/tui/src/lib.rs:91-92,245,336`; `codex-rs/feedback/src/lib.rs:400` **[V]** |
| Feedback | Captures a `tracing_subscriber` layer into a snapshot; attaches `codex-logs.log`, feedback diagnostics, a `windows-sandbox.log` attachment on Windows, and path-backed rollout attachments, gated by `include_logs` / options | `codex-rs/feedback/src/lib.rs:43-44, 202-207, 246, 391-406` **[V]** |
| App server | `codex-rs/app-server/` + `app-server-protocol` + `app-server-client` + `app-server-daemon` + `app-server-test-client`; `terminate_background_terminal` exposed to clients | `codex-rs/app-server/src/request_processors/thread_processor.rs:2420` **[V]** |
| `codex-diagnostics` | **Not** code diagnostics — a process-wide gauge registry (`Gauge::new`, `increment`, `decrement`, `track() -> GaugeGuard`, `GAUGES`) | `codex-rs/diagnostics/src/lib.rs:1-60` **[V]** |

### 4.3 Which is easier to debug from?

**Codex, for a deep single-session post-mortem.** `rollout-trace` answers causal questions that DSH's
event log only implicitly supports: "Which model request produced this tool call?", "Which code-mode
`exec` cell issued a nested tool call?", "Which terminal operation created or reused a running
process?" (`rollout-trace/README.md`, "What This Gives Us") **[V]**. The raw-then-reduce split means
the raw evidence survives even when the interpretation is wrong.

**DSH, for breadth and for cross-session retrieval.** Five model-accessible query tools over live and
durable history with FTS5, workspace-scoped authorization, relationship tracing, `/export`; runtime
invariants that fire while the composition is live rather than only during offline replay; and a
keyless replay harness that turns any recorded session into a regression test. Codex's rollout search
is human/LLM-facing (`rollout/src/search.rs`, `list.rs` uses `codex-file-search` for session listing)
rather than a model tool **[V]**.

They are complementary rather than ranked: DSH has better *retrieval and self-checking*; Codex has
better *causal reconstruction*.

---

## 5. Search

### 5.1 DSH — `packages/fs/tool-fs-search/`

Two model tools, `glob` and `grep`, both foreground ripgrep subprocess calls through `ctx.subprocess`.
Never background jobs; no shell layer, so no quoting; every model-controlled value is a plain argv
element (`packages/fs/tool-fs-search/README.md:12,28,104-106`) **[V]**. The binary is the packaged
`@vscode/ripgrep` (or a `-rg` sidecar in a pkg single-file runtime), so **no host `rg` install is
required** (`README.md:12,52`) **[V]**. `--no-config` is prepended so a host `RIPGREP_CONFIG_PATH`
cannot inject a `--pre` preprocessor into the unconfined spawn (`README.md:88`) **[V]**.

**`glob`** — `buildGlobCommand` (`src/glob.ts:89-107`) **[V]**:
`--files --glob=<pattern> --sort=modified --no-ignore --hidden` then two negated globs per VCS name
(`!**/<name>` and `!**/<name>/**`, the second because the bare form never fires when the search root
is *at or inside* the directory — `src/glob.ts:96-103`) **[V]**, then `--` before the path so a
leading-dash path is never parsed as a flag **[V]**.

- **Ordering: modification time, not relevance.** Results are mtime-ordered and grouped by top-level
  entry; there is **no fuzzy/subsequence matching and no score**. `sampleOverCapGlobResults` (required,
  no default) chooses whether an over-cap page samples across top-level entries or keeps the
  mtime-ordered head (`README.md:47`) **[V]**.
- **Ignore rules: deliberately inverted from ripgrep defaults** — `--no-ignore --hidden` means ignored
  and hidden files *are* searched; only VCS metadata is excluded. This is the opposite of the usual
  "respect .gitignore" default, and the README flags it as intentional (`README.md:22`) **[V]**.

**`grep`** — `buildGrepCommand` (`src/grep.ts:112-115`) **[V]**: `--json --regexp=<pattern>`,
`--glob=<include>` if given, `--` before the path. **No `--no-ignore`/`--hidden`**, so `grep` respects
`.gitignore` by default while `glob` does not — an inconsistency worth noting **[V]**.
`include` is validated to be exactly one positive glob: blanks rejected, `!`-negation rejected,
comma-separated lists rejected with the hint to use `{a,b}` alternation (`src/grep.ts:63-77`) **[V]**.
Output is parsed from `rg --json` NDJSON into flat matches and grouped by file as
`<path>\nLine N: <preview>` (`src/grep.ts:195-200`) **[V]**. Malformed NDJSON is a hard
`SEARCH_FAILED`, never a silently partial parse (`src/grep.ts:119-123`; `README.md:88`) **[V]**.

**Budgets** (`README.md:36-46`) **[V]**: `globMaxResults` 100, `grepMaxMatches` 250,
`grepMaxLineBytes` 2,000 (UTF-8-boundary preserving), `rawOutputMaxBytes` 20,000,000 (overflow →
`SEARCH_RAW_OUTPUT_OVERFLOW`), `timeoutMs` 30,000 enforced through `exec.signal`, `graceMs` 3,000,
`stderrMaxBytes` 65,536, `searchMetaMaxBytes` 65,536.

**Recovery design**: complete results are always collected in memory and only the *inline page* is
capped; over-cap results spill the complete formatted preview to the spill store and the page carries
its locator. A missing/failed spill keeps the inline page and says so — never an error
(`README.md:88,94`) **[V]**. Error codes are package-owned: `SEARCH_INVALID_PATTERN`, `SEARCH_FAILED`,
`SEARCH_RAW_OUTPUT_OVERFLOW`, `SEARCH_ABORTED` (`README.md:47`) **[V]**. Exit 0 = results, exit 1 =
successful empty search, model argument mistakes stay ordinary tool-argument errors **[V]**.
Paths are displayed relative to the resolved workdir (the calling session's cwd when present)
(`README.md:47`) **[V]**.

### 5.2 Codex — `codex-rs/file-search/`

1,221-line `lib.rs` **[V]**. Imports: `ignore::WalkBuilder`, `ignore::overrides::OverrideBuilder`,
`nucleo::{Config, Injector, Matcher, Nucleo, Utf32String}`, `nucleo::pattern::{CaseMatching,
Normalization}`, `crossbeam_channel::{select, after, never, unbounded}`, and `tokio::process::Command`
(`codex-rs/file-search/src/lib.rs:1-37`) **[V]**. So:

- **Fuzzy filename matching** via `nucleo` (the Helix fuzzy matcher), with a relevance `score: u32` and
  optional `indices` for highlight positions, computed lazily `#[cfg(test)]`-free and gated behind
  `compute_indices` (`lib.rs:38-60`) **[V]**. Match type distinguishes `File` from `Directory`
  (`lib.rs:62-66, 73-79`) **[V]**.
- **Ignore rules via the `ignore` crate** — standard `.gitignore`/`.ignore`/global-gitignore semantics,
  with `OverrideBuilder` for glob overrides (`lib.rs:8-9`) **[V]**. This is the *inverse* of DSH
  `glob`'s `--no-ignore --hidden`.
- `tokio::process::Command` appears in the same crate — **[I]** used for a bulk/parallel fallback or a
  git-backed listing path; I did not trace it.

**Not a model tool.** `codex-file-search` is a workspace dependency of exactly three consumers:
`codex-rs/tui` (file-mention autocomplete: `tui/src/file_search.rs`, `bottom_pane/file_search_popup.rs`,
`mentions_v2/filter.rs`, `chat_composer.rs`, `chatwidget.rs`), `codex-rs/app-server`
(`app-server/src/fuzzy_file_search.rs`, with `app-server-protocol`'s "Superset of
`codex_file_search::FileMatch`"), and `codex-rs/rollout` (session listing, `rollout/src/list.rs:26`)
**[V]**. It is also a standalone binary (`src/main.rs`, `src/cli.rs`, wired as `just file-search`)
**[V]**. **The model cannot call it directly** — it gets fuzzy path search only insofar as the shell
tool lets it invoke `codex-file-search` or `rg`/`fd` manually.

### 5.3 Search verdict

| Dimension | DSH | Codex |
|---|---|---|
| Fuzzy filename ranking | **No** — mtime order only | **Yes** — nucleo with scores and highlight indices |
| Content search as a tool | **Yes** — first-class `grep`, structured `--json` parsing, grouped output | **No** dedicated tool — model writes `rg` in a shell |
| Ignore rules | `glob` ignores nothing (`--no-ignore --hidden`); `grep` respects `.gitignore`; VCS always excluded | `ignore` crate — standard ignore semantics |
| Result limits | Explicit, configurable, documented caps on both tools; overflow → spill artifact, never an error | `--limit` on the CLI, `matches_truncated` warning to stderr (`main.rs`) |
| Output shape | Structured JSON → grouped `Line N:` previews with byte caps and UTF-8-safe truncation | Raw path lines or JSONL `FileMatch` (CLI only) |
| Ranking/limits for content search | flat match cap + per-line byte cap + raw-output cap | none — whatever the model's `rg` flags produce, bounded only by `max_output_tokens` |
| Robustness | `--no-config`, `--` separators, no shell, spill recovery, typed errors | N/A (a library + CLI, no model contract) |

Net: **DSH has the better *tool*; Codex has the better *matcher*.** DSH's `grep` gives the model a
bounded, robust, spill-recoverable content search with a documented contract; Codex's `file-search`
gives a genuinely better *filename* ranking algorithm that the model cannot call.

---

## 6. Where DSH is clearly BETTER and should be preserved / leaned into

1. **A generated, mechanically-checked tool catalog.** `docs/tool-catalog.md` enumerates every tool with
   its package, its model-facing names, its `inject` list, the session events it produces, its child
   tool names, and a prose contract — e.g. the `@deepseek-ai/dsh-tool-lsp` row naming
   `ctx.tools, ctx.lsp, ctx.systemPrompt` and the `LSP_UNAVAILABLE` fallback behavior
   (`docs/tool-catalog.md:36`) **[V]**. Codex has no equivalent artifact; its tool surface is
   discoverable only by reading `spec_plan.rs` and handler modules. **Preserve and lean in:** this is
   the single best onboarding and review asset in either harness.

2. **The interception extension-point surface is genuinely typed and phased.**
   `tools/pre-execute` (waterfall gate, `PreToolDecision` = allow/deny/ask) →
   `ctx.tools.guard()` (synchronous, deny-or-abstain only) → `tools/execute` (around-dispatch wrapper
   for timeout/retry/metrics) → `tools/post-execute` (inspect/transform: accept, block with feedback,
   replace presentation or value, attach contexts) → `finalizeContent` (once, content-only, lossless)
   → `tools/result` (contained observer). Plus `agent/turn-stopping` as the last chance to steer another
   step (`.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md`) **[V]**.
   The explicit rationale — "anything a bridge can do, a plain plugin can do directly — more
   powerfully (no serialization boundary, full `ctx`, typed returns)" — is the correct architecture.
   **This is exactly the substrate a post-edit verification loop needs, and it already exists.**

3. **Post-edit ground truth via `workspace-changes`.** Git working-tree snapshotting with a *private*
   index and a read-only alternate into the real object store, plus whole-file capture for
   file-tool-edited files that git does not cover, degrading gracefully outside a repository
   (`packages/deliverables/workspace-changes/README.md:12,40`) **[V]**. Nothing in Codex produces a
   per-turn, line-counted, comparison-servable change set.

4. **Model-facing session retrieval.** Five read-only tools (`session_search`,
   `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read`) over a
   unified service with SQLite FTS5, workspace-scoped authorization, and cursor-free results
   (`packages/session-query/README.md:12`; `tool-session-query/src/index.ts:51-57`) **[V]**. A DSH agent
   can consult its own and prior sessions' history; a Codex agent cannot.

5. **Runtime invariants as a first-class, gated concept.** Package-owned live checks with failure
   attribution to the owning package, a global switch, package filters, and a mechanical gate
   rejecting empty installers or checks of service presence/plugin metadata/effects/fixed examples
   (`packages/runtime-diagnostics/README.md:12`; `AGENTS.md:139`) **[V]**. This catches "the event
   relationships this package owns have diverged" *during* a session instead of in offline replay.

6. **Search robustness and honesty.** `--no-config`, `--` argv separators, no shell layer, NDJSON
   parse-or-fail, complete-result spill with a retrieval hint, typed `SEARCH_*` codes, and a documented
   cap table (`packages/fs/tool-fs-search/README.md:59-69,77,104-106`) **[V]**. The "never an error — keep the
   inline page and say the complete result could not be saved" rule is exactly right.

7. **A keyless replay harness that is mandatory.** 415 recorded session fixtures; `DSH_SNAPSHOT=replay`
   enforced read-only in CI; "Every non-trivial model-, protocol-, or human-visible change adds or
   updates a keyless recorded-session scenario in the same PR; package, e2e, mock-only, and rationale
   evidence does not replace the assembled transcript" (`docs/testing.md:55`) **[V]**. Codex has no
   equivalent.

8. **Typed yield reasons for interactive sends** — `stdin_read | inferred_idle | timeout |
   session_exit` (`packages/terminal/terminal/src/types.ts:29`) **[V]** — paired with the prompt warning
   that "An inferred_idle or timeout result does not prove the foreground command exited"
   (`tool-terminal/src/index.ts:160`) **[V]**. Codex models this only as a numeric yield window.

9. **The correctness culture around test *meaning*** — "Verify the world, not the self-report. An e2e
   assertion re-runs the command or re-reads the file externally; a keyword probe on the agent's own
   output lets a cheating agent pass. Assert untouched files are byte-identical."
   (`docs/testing.md:33`) **[V]**; "A guard only guards if the regression fails it… prove it: introduce
   the regression, watch red, revert" (`docs/testing.md:55`) **[V]**; "read a spec that passes only when
   it runs alone as a defect in the spec rather than an unstable runner" (`docs/testing.md:21`) **[V]**.

**Where DSH should *not* lean in:** the two-sentence default persona. Codex's
`prompt_with_apply_patch_instructions.md:149-163` shows that a shipped verification policy can be
specific, mode-aware, and brief. DSH pushes all of this onto each deployment's persona config, which
means a default DSH session has *no* stated verification expectation at all.

---

## 7. Test suite & CI structure — engineering maturity

### 7.1 DSH

**Taxonomy (counts from `find … -name "*.<suffix>" | wc -l`, excluding `node_modules`) [V]:**

| Tier | Suffix | Count |
|---|---|---|
| Unit | `*.spec.ts` | 1,622 (375 of them `*.client.spec.ts`) |
| Real-API e2e | `*.e2e.ts` | 270 |
| Expected-output e2e | `*.expected.e2e.ts` | 26 |
| Package perf (diagnostic) | `*.perf.ts` | 2 |
| Keyless snapshot | `*.snapshot.ts` | 4 |
| Recorded fixtures | `snapshots/**/session*.jsonl` | 415 across `session/`, `sdk/`, `acp/`, `web/` |

**Is it meaningful?** Yes, on the evidence:

- **The coverage gate is the gate, and it is per-file 100%** on `packages/*/*/src`, with an explicit
  stance that an uncovered line is usually dead code to delete rather than a test to bolt on, and an
  explicit acknowledgement that line coverage "is necessary, never sufficient — it proves lines ran,
  not that the feature works as shipped" (`docs/testing.md:10`) **[V]**. A pwsh-less host self-skips and
  `vitest.config.ts` exempts the file so CI runners (which ship pwsh) enforce the full bar — a
  deliberate, documented exemption rather than a silent skip **[V]**.
- **Snapshot tier is recorded-session replay through shipped profiles**, not hand-written golden JSON:
  a top-level scenario's highest recorded parent generation supplies user input *and* model replay,
  then serves as the expected persisted result; process scenarios start through the real `dsh` binary
  (headless / SDK / ACP / Web); mutating scenarios independently compare a complete
  `workspace.expected/` tree that record and refresh never rewrite (`docs/testing.md:14`) **[V]**. That
  last rule is a real anti-cheat: the test author cannot regenerate the "expected" workspace.
- **Web browser snapshots run in Chromium, with the model/reasoning picker also in WebKit**, and CI
  enforces read-only `DSH_SNAPSHOT=replay` while record/refresh stay local with every diff reviewed
  (`docs/testing.md:15`) **[V]**.
- **Benchmarks are a required Linux PR gate**, not advisory: `benchmarks/` groups user-path gates
  (`active-stream-reconnect`, `agent-continuation`, `conversation-fold`, `long-session-browser`,
  `session-open`, `terminal-io`), building libraries and workers, running timed code under plain Node
  and never TSX, enforcing time/heap/scaling budgets on synthetic inputs
  (`docs/testing.md:13`; `benchmarks/`) **[V]**.
- **Test infrastructure is a product group with real capability**: `packages/test-support/` ships
  `session-snapshot` (adapters), `agent-loop-testkit`, `client-runtime` (a jsdom slot bench),
  `remote-mock` (endpoint-named Typert Remote mock + Connection carrier), `loader-smoke` (boots
  Loader-composed applications and drives fixture turns), `llm-mock-server` (a **scriptable
  OpenAI-compatible fault server** for recovery tests), and `llm-replay` (`packages/test-support/README.md:25-32`)
  **[V]**. A dedicated fault-injection server is a maturity marker most projects never reach.
- **"Prefer the real implementation over a mock"**: mock only the expensive or non-deterministic
  boundary (LLM adapter, network, clock), keep everything downstream real; the ACP bridge harness
  mounts the loop, session store, tool registry, and JSONL persistence with `MockAdapter` as the only
  mock (`docs/testing.md:29`; `packages/acp/acp/tests/harness.ts`) **[V]**.
- **A postmortem culture with a cited incident**: `docs/testing.md:25` justifies with-key smoke tests
  by pointing at `postmortem/0001-acp-default-export-drops-inject.md`, and `docs/testing.md:40` encodes
  the resulting regression as a required assertion (`expect('default' in mod).toBe(false)` plus an
  `unwrapExports` round-trip) **[V]**.
- **Source-plane vs artifact-plane is explicit**: every vitest config resolves bare workspace imports
  to `src` via `vite-tsconfig-paths`/`tsconfig.base.json` "never through package `exports` to built
  `lib/` — stale artifacts there load a second copy of module singletons"; built artifacts are consumed
  only explicitly (`docs/testing.md:43`) **[V]**. That is a bug class most monorepos never diagnose.
- **Beyond tests: `pnpm run lint` (oxlint), `pnpm run typecheck` (tsc -b), `pnpm run duplication`
  (jscpd clone detection across `packages scripts`), `pnpm run hygiene` (publint + workspace/package/
  dependency checks + NodeNext consumer check), `pnpm run doc-sync` and `pnpm run test:docs`
  (documentation gates, one of which mechanically enforces JSDoc on every export via
  `verify-export-jsdoc`), and `pnpm run check:windows-wine`** (`AGENTS.md:78-92`) **[V]**.

**CI (`.github/workflows/`, 20 files, `ci.yml` 726 lines) [V]:**

| Job | What it runs |
|---|---|
| `node 24 / static` | `pnpm run check:ci:static` |
| `node 24 / coverage` | `pnpm run check:ci:coverage` — partitioned, with a `.coverage-times.json` cache save/restore across runs to rebalance shards (`ci.yml:110-191, 638`) |
| `node 24 / benchmarks` | `pnpm run check:ci:bench` on `ubuntu-24.04` — required PR gate |
| `node 24 / snapshots and artifacts` | `pnpm run check:ci:consumers`, after preparing the Office runtime |
| `node compat` | matrix over **22.19 / 24.9 / 26** |
| `python-sdk`, `python-runtime` (reusable `build-exe-for-python-sdk.yml`) | both SDK projections gated |
| `windows node 24 / build & observational` | split into **blocking** and **observational-ready** gates |
| `windows node 24 / coverage` | full coverage bar on Windows |
| `windows node 24 / native tests` | PR-only, 60-min timeout, Developer Mode for symlink support, ReFS-aware `pnpm install --package-import-method=clone`, four specific native specs |
| `all checks passed` | single stable required check for branch protection, aggregating via `needs`, with an explicit comment on why names change and why the verdict retargets with the Linux failover switch |

Also: `e2e.yml` runs the real DeepSeek API with a **preflight that requires `DEEPSEEK_API_KEY`**,
prepares bubblewrap for unrestricted userns, builds `lib` for the e2e example bins, and prepares the
Office runtime before `pnpm run test:e2e` (`e2e.yml:92-127`) **[V]**. There is a dedicated
`sandbox.yml` (168 lines) **[V]**. Runner selection is failover-aware with documented tradeoffs,
including the acknowledged consequence that a Blacksmith outage strands both workers and the verdict
(`ci.yml:713-722`) **[V]**.

**Maturity signals that are about *process*, not code:** `lefthook.yml` (pre-commit), 184 lines of
`AGENTS.md` conventions covering invariants, branded ids, fail-loud misconfiguration, "Model-visible ⟺
logged", "Plugins, not loop changes", and a documentation-per-change rule; a bilingual doc pipeline
(`*.zh.md` + `*.i18n.yaml`); `.agents/notes/{implemented,archived,proposed}/` as a durable decision
record with a frozen-archive policy; and an explicit `dsh-pre-push-checks` skill that says "Never
default to the full suite or repeat a passing check for commit or push. CI owns exhaustive coverage and
the platform matrix" (`AGENTS.md:118`) **[V]**.

### 7.2 Codex

**Taxonomy [V]:** 14,705 `#[test]` / `#[tokio::test]` attributes across `codex-rs`; 401 `insta::`
usages; 20+ committed `snapshots/` directories (heaviest in `tui/src/**` — `chatwidget`, `bottom_pane`,
`markdown_render`, `streaming`, `status`, `history_cell` — plus `core/src/{unified_exec,guardian,session,context/world_state}`
and `core/tests/suite`); 139 integration files under `codex-rs/core/tests/suite/`; 28 `#[ignore]`
attributes.

**Is it meaningful?** Yes, and the integration harness is the strong part:

- `codex-rs/core/tests/common/` is a real harness crate: `responses.rs` + `streaming_sse.rs` (a
  scripted Responses-API model server over SSE), `test_codex.rs` / `test_codex_exec.rs` (drive the real
  binary), `apps_test_server.rs` (a **`wiremock::MockServer`** for the hosted-apps surface),
  `context_snapshot.rs`, `process.rs`, `hooks.rs`, `zsh_fork.rs`, `tracing.rs` **[V]**. Driving the real
  binary against a fake SSE model server is exactly the "green unit tests, broken product" antidote
  DSH's testing doc describes.
- `codex-rs/core/tests/suite/` covers aborting tasks, approvals, apply-patch CLI + serialization,
  code-mode and code-mode elicitation, compaction (local, remote, parity, resume/fork), exec,
  exec-policy, hooks (three files), interrupts, MCP (auth elicitation, refresh, cache, exposure, turn
  metadata, startup grace, HTTP proxy cleanup), multi-agent mode/resume, network approval, OTel,
  permissions messages, sandbox multi-exec, image rollout, and more **[V]**. Breadth maps closely to
  real subsystems.
- TUI rendering is snapshot-tested with `insta` at high density, which is the only tractable way to
  regression-test a terminal UI **[V]**.
- `codex-rs/otel/tests/suite/` includes `otlp_http_loopback.rs`, `otel_export_routing_policy.rs`,
  `snapshot.rs`, and `timing.rs` — telemetry is tested against a loopback collector and a routing
  policy, not asserted by proxy **[V]**.
- `codex-rs/app-server-test-client/` and `codex-rs/test-binary-support/` exist as first-class support
  crates **[V]**.

**Gaps [V]:**

- **No load/performance bench framework.** `grep -rn "criterion" --include='Cargo.toml' codex-rs/`
  returns nothing; there is exactly one `[[bench]]` target in the whole workspace
  (`codex-rs/utils/image/Cargo.toml:25`). The CI "Rust benchmark smoke test" is `just bench-smoke` →
  `just bench -- --test` → `cargo bench --workspace --bench '*' --test`, i.e. compile-and-start only.
  The Bazel `//codex-rs:e2e-benchmarks` suite is a `test_suite` containing exactly one test,
  `//codex-rs/cli:codex-help-bench` (`codex-rs/BUILD.bazel:20-27`; `codex-rs/cli/e2e_benches/codex_help.rs`)
  — measuring `codex --help`. DSH's six budget-enforcing `benchmarks/` groups as a required PR gate is
  in a different league.
- **No property-based testing.** No `proptest`/`quickcheck` in any `Cargo.toml` **[V]**. DSH has no
  equivalent either, so this is a shared gap, not a Codex-specific one.
- **28 `#[ignore]` tests** with no visible owner policy **[V]**.

**CI (`.github/workflows/`, 30 files) [V]:**

- `blocking-ci.yml:14-53` is the merge gate: `Bazel`, `Blob size policy`, `cargo-deny`, `Codespell`,
  `repo-checks`, `rust-ci`, `sdk` → `CI required`, which "Require[s] successful dependencies" via
  `.github/scripts/check_ci_results.py`. The single-verdict pattern matches DSH's `all checks passed`.
- `rust-ci.yml`: a **changed-areas detector** ("Detect changed paths (no external action)", `:9-21`) so
  expensive lanes skip unrelated PRs; `cargo fmt --check` with `imports_granularity=Item`; `cargo shear
  --deny-warnings` (unused-dependency detection); a custom **dylint-based "argument comment lint"**
  built from source and run per-platform via Bazel on Linux/macOS/Windows (`:110-214`) — a
  bespoke, self-hosted lint is a genuine maturity marker; and a "clean worktree" check after every lane
  to catch steps that mutate the checkout (`:55, 81, 105, 160, 214`).
- `rust-ci-full.yml` (main-only, via `postmerge-ci.yml`): a large cross-compile **build matrix** —
  `macos-15-xlarge` (aarch64 + x86_64), `ubuntu-24.04`, `ubuntu-24.04-arm`, `windows-x64`,
  `windows-arm64` — across debug and release profiles (`:154-245`), plus a **Test matrix** on
  macos/aarch64, ubuntu/x86_64 (remote), ubuntu-arm/aarch64, windows-x64, windows-arm64, each calling
  the reusable `rust-ci-full-nextest-platform.yml` (`:461-513`) **[V]**.
- Bazel and Cargo coexist; `MODULE.bazel`/`defs.bzl`/`rbe.bzl` (remote build execution) are present at
  the root, and several lanes run through Bazel **[V]**.
- `repo-checks.yml`, `codespell.yml`, `cargo-deny.yml`, `blob-size-policy.yml`, `cla.yml`,
  `issue-*`, `postmerge-ci.yml`, and release workflows including `rust-release.yml`,
  `rust-release-windows.yml`, `rust-release-zsh.yml`, `python-sdk-release.yml`,
  `python-runtime-release.yml`, `r2-release.yml`, `rusty-v8-release.yml` **[V]**.

### 7.3 Maturity comparison

| Signal | DSH | Codex |
|---|---|---|
| Test attributes / spec files | 1,622 unit specs + 270 real-API e2e | 14,705 test attributes + 139 integration files |
| Coverage gate | **Per-file 100% on `packages/*/*/src`** as the CI gate, with documented exemptions | Not visible in the workflows I read **[I]** |
| Snapshot tests | 415 **recorded-session** fixtures replayed through the real binary; browser snapshots in Chromium+WebKit enforced replay-only in CI | `insta` snapshots, densest in TUI rendering; no recorded-transcript-replay tier |
| Fake-model harness | `llm-mock-server` (scriptable OpenAI-compatible **fault** server) + `llm-replay` | SSE Responses-API mock (`tests/common/responses.rs`, `streaming_sse.rs`) + `wiremock` |
| Performance gates | **6 user-path benchmark groups, required Linux PR gate, time/heap/scaling budgets** | One `[[bench]]` target; CI runs `cargo bench --test` (smoke only); Bazel "e2e benchmarks" = `codex --help` timing |
| Anti-cheat test rules | Explicit: verify the world not the self-report; byte-identical untouched files; "a guard only guards if the regression fails it"; expected-workspace trees that record/refresh cannot rewrite | Not articulated in the files I read **[I]** |
| Custom lints beyond the language | oxlint, `verify-export-jsdoc`, `verify-cordis-config`, jscpd clone detection, publint hygiene, doc-budget gates | `cargo shear`, dylint argument-comment lint, codespell, cargo-deny, blob-size policy |
| Platform matrix | node 22.19/24.9/26, Windows blocking+coverage+native, macOS, plus a dedicated `sandbox.yml` | 5 OS/arch build targets ×2 profiles, 5 test platforms via nextest, bazel on Linux/macOS/Windows |
| Change-aware CI | No path filtering observed in `ci.yml` **[I]** | Yes — explicit changed-area detection gating lanes |
| Real-API e2e in CI | Yes, with key preflight; self-skips keyless | Not in the workflows I read **[I]** |
| Documented testing *philosophy* | `docs/testing.md` (55 dense lines), postmortems, `dsh-ci-test-reliability` skill, a flake-diagnosis workflow | Workflow comments and crate READMEs; no single testing-policy doc found **[I]** |

**Assessment.** Both are top-decile. Codex's advantages are **breadth** (14.7k tests, 139 integration
files, a 5-platform × 2-profile build matrix, change-aware lane skipping, a bespoke dylint lint) and
**sandbox/remote-execution testing depth**. DSH's advantages are **rigor per line** (per-file 100%
coverage as the gate), **product-level realism** (415 recorded sessions replayed through the shipping
binary; fault-injection LLM server), **performance as a blocking gate** (Codex effectively has none),
and, most of all, **explicit written standards for what makes a test trustworthy** — the
"verify the world, not the self-report" and "prove the guard by introducing the regression" rules are
the kind of thing that only appears after a team has been burned, and they are codified with postmortem
citations. DSH's test suite is *smaller but stricter and more opinionated*; Codex's is *larger and
broader*.

---

## 8. Prioritized Recommendations

### R1 — Add a `diagnostics` operation to the LSP seam and feed it back after `edit`/`write`

- **Impact: H.** This is the single largest capability gap on this axis, and DSH is one of the only
  agent harnesses with the substrate to close it. Neither DSH nor Codex currently tells the model that
  an edit broke a type.
- **Effort: M–H.** The transport, provider registry, workspace pooling, queueing, retry, and teardown
  all exist; what is missing is the *semantics* the README already names ("freshness and accumulation
  rules") — a versioned document, accumulation across `publishDiagnostics` notifications, and a
  settle/quiescence rule.
- **Exact files to touch:**
  - `packages/lsp/lsp/src/types.ts` — extend `LspOperation` with `'diagnostics'` (or add a separate
    `LspDiagnosticsRequest`/`LspDiagnosticsResult` pair so the four-operation union stays closed);
    add a versioned-document concept and a diagnostics result variant.
  - `packages/lsp/lsp-stdio/src/connection.ts:248` — stop discarding notifications; route
    `textDocument/publishDiagnostics` to a per-instance latest-diagnostics store keyed by URI+version.
    Add `textDocument/diagnostic` (pull model) support alongside the push model.
  - `packages/lsp/lsp-stdio/src/instance.ts:159-177` — keep the document open across edits (send
    `didChange` with an incremented `version`) instead of transient open/close, so diagnostics are
    attributable to a version.
  - `packages/lsp/lsp-stdio/src/translate.ts` — capability check for `diagnosticProvider` /
    `publishDiagnostics` support; keep the closed capability switch exhaustive.
  - `packages/lsp/tool-lsp/src/index.ts` — add the operation to `LSP_OPERATIONS` and the output schema
    (closed union → extend both arms and the `assertNever`); raise `DEFAULT_LSP_TOOL_TIMEOUT_MS` for the
    settle window.
  - `packages/lsp/tool-lsp/src/render.ts` — a diagnostics renderer with per-severity caps on top of
    `maxResultChars`.
  - `packages/lsp/lsp/README.md:12,129` and `packages/lsp/tool-lsp/README.md` — delete the two
    "diagnostics are excluded" claims or replace them with the freshness contract.
- **Verification loop wiring (the part that makes it a *loop*):** register a `tools/post-execute`
  listener that, when the call was `edit`/`write` and a provider is registered for the file's extension,
  runs the diagnostics query and attaches the result as `additionalContexts` — the interception surface
  already supports exactly this (`.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md`,
  `packages/hooks/README.md:12`). Put it in a new `packages/lsp/lsp-diagnostics-policy/` so removing the
  plugin leaves bare navigation behavior, matching the `fs-observation-policy` precedent
  (`packages/fs/README.md:32`).

### R2 — Ship a default language-server table and mount `tool-lsp` in the standard preset

- **Impact: H.** Right now `tool-lsp` is dead code in every shipped profile: no servers configured, not
  in `standard`/`ptc`/`minimal`/`cordis` presets, no default extensions. Effective coverage is zero.
- **Effort: L–M** (config plus packaging of the server binaries/paths; the code needs nothing).
- **Exact files to touch:** `packages/bundle/web-app/presets/standard.patch.yml:10-45` (add a
  `tool-lsp` row and a `lsp-stdio` row, gated by `disabled: !!js` on server availability);
  `packages/lsp/lsp-stdio/src/index.ts:105-107` if a convenience default table helps (but keep
  "misconfiguration fails loud", `AGENTS.md:144` — prefer an explicit preset row over a hidden default);
  `packages/lsp/README.md:12`; `docs/tool-catalog.md` (regenerated); and a new preset-level snapshot
  scenario, which `docs/testing.md:55` makes mandatory for a model-visible change. Start with
  `typescript-language-server` for `.ts/.tsx/.js/.jsx`, `rust-analyzer` for `.rs`, `pyright` for `.py`,
  `gopls` for `.go` — extending `extensionToLanguage` per server
  (`packages/lsp/lsp-stdio/src/index.ts:59-60`).

### R3 — Adopt a shipped "Validating your work" persona for DSH defaults

- **Impact: H.** DSH's standard preset ships a two-sentence persona
  (`packages/bundle/web-app/presets/standard.patch.yml:15`) and no stated verification expectation,
  while Codex ships 15 lines of mode-aware verification policy
  (`codex-rs/core/prompt_with_apply_patch_instructions.md:149-163`). A default DSH session currently
  has nothing telling it to run the tests.
- **Effort: L.**
- **Exact files to touch:** `packages/bundle/web-app/presets/standard.patch.yml:14-15` (extend `prefix`
  or add a `systemPrompt`-contributing row) and the matching `ptc`/`cordis` presets; keep it *brief and
  concrete* — start-specific-then-broad, don't-add-tests-to-a-testless-codebase, and a
  matched-evidence rule lifted from DSH's own `AGENTS.md:118` ("Match evidence to the surface: focused
  behavior tests, model/user-output snapshots, `doc-sync` for docs, built smokes for published paths,
  and real-API e2e for providers"). Because persona is config
  (`packages/preset/persona/src/index.ts:29-49`), this needs no loop change — exactly the architecture
  the project claims. Add or update a snapshot scenario per `docs/testing.md:55`.

### R4 — Add fuzzy filename ranking to `glob`

- **Impact: M.** DSH `glob` returns mtime-ordered paths with no relevance score
  (`packages/fs/tool-fs-search/src/glob.ts:93`), so `glob "**/*auth*"` on a large tree buries the file
  the model wanted behind every recently-touched match. Codex's `nucleo` matcher with `score` +
  `indices` (`codex-rs/file-search/src/lib.rs:38-60`) is strictly better at this.
- **Effort: M.** Keep ripgrep for enumeration (the `--no-config`, no-shell, spill-recovery design is
  good) and re-rank in-process: either embed a small subsequence scorer over the already-collected
  `--files` output, or add an optional `nucleo`-equivalent dependency.
- **Exact files to touch:** `packages/fs/tool-fs-search/src/glob.ts:89-107` (command) and the
  inline-page/sampling logic (`:113-221`); `packages/fs/tool-fs-search/README.md:22,36-46` (document the
  ranking contract and any new config key); `packages/fs/tool-fs-search/src/presentation.ts` if highlight
  indices are surfaced. Add a spec under `packages/fs/tool-fs-search/tests/`. Note the constraint from
  `AGENTS.md:144`: ranking must be a validated `Config` choice, not a hidden default.

### R5 — Make `glob` and `grep` agree on ignore rules, and let the model choose

- **Impact: M.** `glob` passes `--no-ignore --hidden` (`src/glob.ts:94-95`) while `grep` passes neither
  (`src/grep.ts:112-115`), so the same workspace yields two different universes depending on which tool
  the model picks. The current split is deliberate (`README.md:22`) but undocumented as a *choice the
  model can make*.
- **Effort: L.**
- **Exact files to touch:** `packages/fs/tool-fs-search/src/{glob.ts,grep.ts}` and their schemas
  (`glob.ts:307-310`, `grep.ts:286-287`) — add an optional, defaulted `ignore` mode shared by both tools
  (`vcs` | `all` | `none`), keeping VCS-metadata exclusion unconditional
  (`GLOB_VCS_EXCLUDES`, `glob.ts:96-103`). Then update the arg validators (`parseGlobArgs`
  `glob.ts:71-74`, `parseGrepArgs` `grep.ts:89-96`) and `README.md:36-46`.

### R6 — Promote a rollout-trace equivalent: a raw, replayable, per-session evidence bundle

- **Impact: M–H.** DSH's session log is model-visible-event-shaped by design ("Model-visible ⟺ logged",
  `AGENTS.md:143`), which is excellent for reconstructing requests but leaves *runtime* causality
  unrecorded: which job spawned which process, which tool call produced which spill artifact, which
  subagent notification arrived when. Codex's `rollout-trace` answers exactly those questions with an
  "observe first, interpret later" raw-then-reduce design
  (`codex-rs/rollout-trace/README.md`; `bundle.rs:8-14`) **[V]**.
- **Effort: H.** This is real work; the honest scoping is a *new opt-in package*, not a change to
  `session-persistence`.
- **Exact files to touch:** a new `packages/session/rollout-trace/` (or
  `packages/runtime-diagnostics/trace-bundle/`) writing `manifest.json` + `trace.jsonl` +
  `payloads/*` behind an env var; producers hooked at the existing seams — `tools/result` (already a
  contained observer), `ctx.jobs` typed events (`packages/jobs/jobs-local/src/events.ts`),
  `ctx.terminals`, `ctx.subagents`, and the LLM adapter. Reuse `packages/spill/` for payload storage
  rather than inventing a second blob store. Publish a `./invariant` companion per
  `packages/AGENTS.md` invariant rules (`AGENTS.md:139`) and gate it in `docs/persistence-catalog.md`.

### R7 — Close the benchmark gap in the other direction (do not regress DSH's)

- **Impact: M (defensive).** DSH's six budget-enforcing benchmark groups as a required Linux PR gate
  (`docs/testing.md:13`; `.github/workflows/ci.yml:193-237`) are a clear DSH advantage over Codex's
  smoke-only `cargo bench --test` and its single-test `//codex-rs:e2e-benchmarks` suite. The risk is
  erosion: `*.perf.ts` is already classed as merely "diagnostic" and only 2 exist.
- **Effort: L.**
- **Exact files to touch:** `benchmarks/AGENTS.md` and `benchmarks/*/` when adding any new user path;
  `docs/testing.md:13`; `vitest.bench.config.ts`; and `package.json:84-96` gate wiring. Rule to add:
  a new user-visible path (tool, command, or profile) ships with a `benchmarks/` group or a written
  justification in the PR, mirroring how `docs/testing.md:55` makes snapshot scenarios mandatory.

### R8 — Expose a per-turn verification summary in the deliverables card

- **Impact: M.** `workspace-changes` already computes per-turn changed files with line counts
  (`packages/deliverables/workspace-changes/README.md:12`) and `present` already declares final files
  (`packages/deliverables/README.md:12`). What is missing is the *verification* half: which commands the
  turn ran and what they returned.
- **Effort: M.**
- **Exact files to touch:** a new `packages/deliverables/turn-verification/` (or an extension of
  `workspace-changes`) that, per top-level turn, records each shell/terminal/job invocation and its
  exit status from the existing `tool/result` and `ctx.jobs` event streams, appends one
  `workspace/verification` event, and serves it beside the changed-files comparison;
  `packages/client/ui-deliverables/` for the card. This is the cheapest way to give an operator
  (and a reviewer) the answer to "did this turn actually check its work?" without changing what the
  model sees. Note the deliverables family's own rule: it is client-read Session events
  (`packages/deliverables/README.md:12`).

### R9 — Codify the argument in `packages/lsp/lsp/README.md:129` as a tracked design note

- **Impact: L.** The README explains *that* diagnostics were deferred and *why* (freshness and
  accumulation rules) in a "Known Limitations" bullet, which is where good intentions go to die. The
  repo's own convention (`.agents/notes/proposed/`) exists for exactly this.
- **Effort: L.**
- **Exact files to touch:** add `.agents/notes/proposed/feature/<date>-lsp-diagnostics.md` with the
  freshness/accumulation contract sketched (document versioning, settle window, severity filtering,
  cap policy, interaction with the transient-open design); cross-link from
  `packages/lsp/lsp/README.md:129` and `.agents/notes/README.md`. Same for the other named deferrals
  (symbols, call hierarchy, rename/code actions) so the "deferred as the over-reach signal" pattern
  (`2026-06-30-interception-extension-points.md`, "Alternatives considered") stays auditable.

---

## Appendix — method and limits

**Method.** All DSH and Codex claims marked **[V]** come from reading the cited file at the pinned
revision with the `read`/`grep`/`glob` tools, or from `git log -1` / directory listings. Counts used
`find … -name "<pattern>" | wc -l` and `grep -rn … | wc -l`; the exact commands are stated inline where
a number is load-bearing. No file in either repository was modified.

**Limits.**

- The DSH LSP finding is the strongest claim in this report and is backed by *three independent*
  signals — the type union, an explicit code comment that notifications are ignored, and two README
  statements — so it is **VERIFIED**, not inferred.
- I did not trace every consumer of `codex-file-search`'s internal `tokio::process::Command` usage
  (**[I]**, §5.2).
- I did not find a Codex coverage gate, property-testing setup, or real-API e2e lane in the workflows I
  read; absent-evidence claims are marked **[I]** rather than asserted as absence, because I did not
  read all 30 workflow files line by line.
- The claim that `tool-lsp` is unmounted rests on grepping `packages/` and `apps/` for `tool-lsp` /
  `lsp-stdio` and on reading the four shipped preset patches; a deployment-specific profile outside
  this repository could mount it.
- §7's "meaningful vs. not" judgement is mine. It is grounded in specific artifacts (per-file 100%
  coverage as the gate, expected-workspace trees that record/refresh cannot rewrite, the fault-injection
  LLM server, `wiremock`-backed app tests, `insta` TUI snapshots, `otlp_http_loopback.rs`) rather than
  in file counts, but a different reviewer could weight breadth over strictness and reach a different
  overall verdict on §7.3.
