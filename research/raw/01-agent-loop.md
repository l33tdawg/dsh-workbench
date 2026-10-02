# Axis 01 — Agent loop and turn orchestration: DSH vs Codex

**Revisions pinned for every claim below**

- DSH `639ed015397290b3745d163aafe02ffee4aa3f84` (`dsh-v0.2.0-rc.2`), TypeScript pnpm monorepo at
  `/Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src`. Paths are repo-relative
  (`packages/...`), `:line` = 1-based line in the file at that SHA.
- Codex `2abb02bc004fe2847d1f99f47610c92d1744b22d`, Rust workspace at
  `/Users/l33tdawg/nodejs-projects/codex`. Paths are relative to `codex-rs/`
  (e.g. `core/src/tasks/mod.rs`).

**Method / verification legend.** Everything tagged **[V]** was read directly in the cited file at
the cited line during this investigation. Everything tagged **[I]** is an inference drawn from
cited code plus, where noted, documented upstream library behaviour; it was *not* executed,
benchmarked, or observed on a running system. No code in either repo was modified. Latency numbers
are arithmetic models, not measurements — this axis produced no empirical run (the live-measurement
sibling report `00-empirical-live-measurements.md` covers measurements for other axes).

---

## Summary

1. **DSH does execute independent tool calls concurrently — but only for tools that opt in**, and the
   opt-in set is read-only helpers. The scheduler is a bounded rolling pool (`maxParallelToolCalls`,
   default 10) that re-reads each call's concurrency mode immediately before starting it, keeps
   *dispatch* concurrent while committing *results* in model order, and forms a barrier at any
   non-parallel call. Decision predicate:
   `packages/core/tools/src/index.ts:1303-1313` (`executionMode`, fail-closed), pool:
   `packages/core/agent-loop/src/tool-calls.ts:85-100,199-231`. **[V]**
2. **The practically important case is still serial.** Every latency-dominant tool in DSH — `bash`
   (both variants), `write`, `edit`, MCP-bridged tools, and `run_code` — declares no
   `isConcurrencySafe`, so it is classified `exclusive`. An assistant message containing N shell
   commands runs them strictly end-to-end. Only 8 tool definitions in the whole repo opt in:
   `fs read`, `fs read-image`, `web search`, `web fetch`, three `session-query` tools, `subagent`.
   **[V]** (see Finding F4 for the enumeration and the latency model.)
3. **Both harnesses have the same *concurrency decision shape*: per-tool opt-in, fail-closed.** Codex
   defaults `supports_parallel_tool_calls()` to `false` (`tools/src/tool_executor.rs:122-124` **[V]**)
   and gates execution on a per-`ToolCallRuntime` `RwLock<()>`: parallel-safe calls take a read lock,
   everything else takes a write lock (`core/src/tools/parallel.rs:155-159` **[V]**). The substantive
   difference is *which* tools opt in: Codex marks `exec_command` and `write_stdin` parallel-safe
   (`core/src/tools/handlers/unified_exec/exec_command.rs:126-128`,
   `.../write_stdin.rs:45-47`), so a batch of shell commands genuinely overlaps, while DSH
   serializes the equivalent batch.
4. **Codex starts tool work *while the model is still streaming*; DSH cannot.** Codex pushes a tool
   future the moment the stream emits the finished `FunctionCall` item
   (`core/src/stream_events_utils.rs:321-327`, `core/src/session/turn.rs:2419`) and the actual
   dispatch runs on its own `tokio::spawn` (`core/src/tools/parallel.rs:147-178`), so handler
   execution overlaps the tail of generation. DSH must finish the whole assistant message
   (`packages/core/agent-loop/src/agent.ts:440-443`), assemble blocks
   (`.../assistant-stream.ts:117-119`), append one durable `assistant/message`
   (`agent.ts:512-529`) and only then schedules tools (`agent.ts:532-537`). **[V]**
5. **Both fold mid-turn user input at step boundaries; neither injects text into an in-flight model
   call.** DSH exposes three distinct primitives (`followup`/`steer`/`inject`,
   `agent.ts:163-173`) over a *durable* two-list inbox (`inbox.ts:27-65,109-114`), and its GUI
   chooses between queue and steer per user setting
   (`packages/client/ui-conversation/src/submission-settings.ts:12,18`;
   `packages/api/session-controller/src/commands.ts:364-365`). Codex folds `pending_input` into the
   next sampling request of the *same* turn (`core/src/session/turn.rs:296-307,425`), fed by
   `turn/steer` or by `turn/start` auto-steering (`core/src/session/turn_input.rs:546-635`,
   `app-server/src/request_processors/turn_processor.rs:628,1035`). **[V]**
6. **Neither harness has a max-iteration / max-turn valve in the loop itself.** DSH's loop is
   `while (await this.turn())` with no step cap (`agent.ts:252-265`; the only loop config is
   `maxParallelToolCalls` + `agents`, `agent-loop/src/index.ts:292-309`). Codex's loop is
   `loop { … }` with no counter (`core/src/session/turn.rs:303-601`); no `max_turns` /
   `max_iterations` symbol exists in `core/src` or `config/src` **[V]** (repo-wide grep). Codex does
   have two valves DSH lacks: a **Stop-hook block/continue** mechanism with a `stop_hook_active`
   loop guard (`turn.rs:466-535`), and a **guardian-rejection circuit breaker** that force-interrupts
   a turn after 3 consecutive / 10 recent auto-review denials (`core/src/guardian/mod.rs:62-66,209-231`).
   DSH's own Codex-dialect hook bridge documents the missing loop guard as a TODO
   (`packages/hooks/hooks-codex/src/index.ts:263-265` **[V]**).
7. **Both have provider-routed model-request retry with exponential backoff + jitter; only Codex
   retries at the *tool* layer, and only for sandbox escalation.** DSH: `llm-retry` plugin, default
   5 retries on `RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE`, 500 ms → 10 s, jitter 0.1,
   durable `llm/retry` events (`packages/llm/llm-retry/src/index.ts:188-241`,
   `packages/llm/llm/src/retry-policy.ts:14-24`). Codex: stream retries with `stream_max_retries`
   (default 5, cap 100), `backoff()` 200 ms·2ⁿ ±10 %, WebSocket→HTTPS fallback, and optional
   unbounded connection retries (`core/src/responses_retry.rs:44-129`, `core/src/util.rs:86-91`,
   `model-provider-info/src/lib.rs:28-29,372-375`); tool-level "retry" is the sandbox-escalation
   second attempt with approval caching (`core/src/tools/orchestrator.rs:409-499`). **[V]**
8. **DSH is durable-log-first; Codex is mutable-history-first.** DSH derives every model request from
   the session log (`agent.ts:671-686`), freezes it (`agent.ts:669-677`) and repairs crash-orphaned
   turns on resume (`agent-loop/src/index.ts:852-856`, `packages/core/session/src/repair.ts:105-198,209-211`).
   Codex mutates a `ContextManager` history plus a rollout writer and reconstructs fewer invariants
   from the log. This is the structural reason DSH's streaming frames are revision-numbered and
   replayable while Codex's deltas are fire-and-forget client events. **[V]**

---

## Findings

### F1 — Turn start / end and the driver loop

**DSH [V].** `ReactLoopAgent` is a small phase machine: `idle | maintenance | running`
(`packages/core/agent-loop/src/agent.ts:42-50`). Waking input forks one driver:

- `send()` splices into the inbox and calls `wakeDriver` (`agent.ts:154-161`).
- `wakeDriver` refuses to start a second driver, latching `wakeRequested` instead, then sets the
  `running` phase with a **fresh `AbortController` per driver** and calls `kick()` under
  `agents.withInitiator` (`agent.ts:214-235`).
- `kick()` is `while (await this.turn()) {}` — the turn loop — with `try/catch` containment and a
  `finally` that returns the machine to `idle` and re-wakes if a latch survived
  (`agent.ts:252-265`).
- `turn()` opens `turn/start` (`agent.ts:305`), runs an inner `while (true)` of steps
  (`agent.ts:313-365`), and in `finally` always appends exactly one `turn/end` with a
  `TurnEndReason` (`agent.ts:382-389`). It returns `true` (another turn) only when the inbox still
  has work (`agent.ts:390-395`), so queue draining is the *only* thing that keeps a driver alive
  across turns.
- One step = one model call + its tools: `step/start` (`agent.ts:329`), `step()` (`agent.ts:338`),
  `step/end` in `finally` (`agent.ts:356`).

**Codex [V].** A turn is a `SessionTask` (`core/src/tasks/mod.rs:177-217`) executed on a background
Tokio task. `Session::start_task` mints a `CancellationToken`, spawns the task
(`tasks/mod.rs:363-396`), and stores a `RunningTask` on the session's `ActiveTurn`
(`tasks/mod.rs:401-412`). `RegularTask::run` emits `TurnStarted`, then loops
`run_turn(...)` while pending input remains (`core/src/tasks/regular.rs:76-95`). Turn finalisation
is centralised at the spawn site: `on_task_finished` (`tasks/mod.rs:589-867`) emits exactly one
terminal `TurnComplete` or `TurnAborted` (`tasks/mod.rs:806-836`). `spawn_task` first calls
`abort_all_tasks(TurnAbortReason::Replaced)` (`tasks/mod.rs:269-278`), so a new turn preempts the
old one rather than running beside it.

*Difference worth noting:* DSH's per-driver AbortController is re-minted per turn
(`agent.ts:391-393`), so cancelling turn N does not poison turn N+1; Codex's cancellation token is
per-task, and the task-attribute model makes "replace the turn" the default (`Replaced`).

### F2 — Streaming of partial assistant output

**DSH [V].** Streaming is a first-class, revision-numbered, *process-local* publication plus a
durable compact record:

- `AssistantStreamAttempt` emits `start` / `chunk` / `end` frames with a monotone `revision`
  (`packages/core/agent-loop/src/assistant-stream.ts:49-109`); each chunk is timestamped once and
  fed to both a durable `AssistantStreamAccumulator` and a `BlockAssembler`
  (`assistant-stream.ts:60-71`).
- Frames are dispatched as `agent/assistant-stream` (`agent.ts:426-433`), documented as transient:
  "Chunk frames are transient; the loop appends one final v2 `assistant/message` or
  `assistant/attempt` with the same stream before a committed end frame"
  (`packages/core/agent/src/runtime-types.ts:355-363`).
- Settlement is ordered against durability: `settle()` appends first, then emits `end` with the
  committed seq, and an `abandon()` path exists when no durable event can be written
  (`assistant-stream.ts:78-109`).
- **Interrupted output is preserved as a real assistant message**: on abort with partial blocks the
  loop appends `assistant/message` with `interrupted: true` and `live.interruptedBlocks()`
  (`agent.ts:445-471`); with nothing partial it appends `assistant/attempt` (`agent.ts:472-477`).

**Codex [V].** Deltas are streamed to the client as protocol events but are not revisioned or made
replayable: `ResponseEvent::OutputTextDelta` → `AgentMessageContentDeltaEvent`
(`core/src/session/turn.rs:2614-2640`), reasoning deltas similarly (`turn.rs:2675-2740`), with a
stream parser only for plan-mode/citation segmentation (`turn.rs:2255-2265`). The durable artifact
is the completed response item recorded on `OutputItemDone` (`turn.rs:2322`, and
`record_completed_response_item` in `core/src/stream_events_utils.rs:317-320`).

*Practical difference:* a DSH client that reconnects mid-answer can rebuild the partial text from
the log (frames carry `revision` and the settled event embeds the same stream, `agent.ts:520-529`);
a Codex client that misses deltas has, until the item completes, no partial to replay. **[I]** from
the cited code (no reconnect test was run).

### F3 — Tool-call parsing and dispatch

**DSH [V].** Tool calls are not parsed from raw deltas by the loop; they are assembled by the LLM
layer's `BlockAssembler` from `tool-call-delta` chunks
(`packages/llm/llm/src/assembler.ts:69-76`), surface as `ContentBlock`s, and are extracted
*after the message is complete*:

```ts
const toolCalls = message.content.filter(block => block.type === 'tool-call')   // agent.ts:532
if (toolCalls.length === 0) return { kind: 'completed' }                        // agent.ts:533
const { concluded } = await executeToolCalls(                                  // agent.ts:534
  this.loopCtx, turn, step, toolCalls, signal,
  context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
)
return concluded ? { kind: 'completed' } : null                                 // agent.ts:538
```

`executeToolCalls` groups by *live* mode, re-reading the registry before each start:

```ts
const mode = ctx.tools.executionMode(first.exec).kind          // tool-calls.ts:89
const group = mode === 'parallel' ? planned.slice(next) : [first]  // tool-calls.ts:90
const outcome = await runGroup(ctx, turn, step, group, mode, signal, acceptContext)  // :91
next += outcome.consumed                                        // :94
```

with the barrier rule inside the pool:

```ts
while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {  // :200
  const nextCall = group[nextToStart]!
  if (nextToStart > 0 && mode === 'parallel'
    && ctx.tools.executionMode(nextCall.exec).kind !== 'parallel') break   // :204-205  (exclusive barrier)
  await startCall(nextToStart)                                             // :206
  …
}
```

Dispatch results land in slots and are committed only in contiguous model order
(`tool-calls.ts:147-161`), and `additionalContexts` from a result are pushed into the next-step
inbox (`tool-calls.ts:157`, `agent.ts:536`). Durability is explicit: `tool/call` is appended before
dispatch (`tool-calls.ts:263-266`) and `tool/result` cites that seq via `sourceEventSeqs`
(`tool-calls.ts:282-289`).

**Codex [V].** Parsing happens per stream item, and dispatch starts immediately:
`build_tool_call(item)` converts a `FunctionCall`/`CustomToolCall`/`ToolSearchCall` into a
`ToolCall` (`core/src/tools/router.rs:246-298`); `handle_output_item_done` boxes
`tool_runtime.handle_tool_call(...)` into an `InFlightFuture` and sets `needs_follow_up = true`
(`core/src/stream_events_utils.rs:321-327`); `turn.rs:2419` pushes it onto a
`FuturesOrdered<InFlightFuture>`; the sampling loop keeps consuming the stream. Results are drained
in model order after the stream ends (`turn.rs:2770-2779`, `turn.rs:2155-2177`).

### F4 — Does DSH run independent tool calls concurrently? (exact answer)

**Yes, conditionally — and the conditional excludes the tools that dominate wall-clock latency.**

The scheduler is genuinely concurrent: `inFlight: Map<index, Promise>` (`tool-calls.ts:163,184`),
`Promise.race(inFlight.values())` to harvest whichever settles (`tool-calls.ts:221-222`), and
`fillPool()` replenishes up to `ctx.agentLoop.config.maxParallelToolCalls.get()`
(`tool-calls.ts:132,199-213`) where the default is **10**
(`packages/core/agent-loop/src/constants.ts:6`, wired at `agent-loop/src/index.ts:335`).

The decision is per call, argument-aware, and fail-closed **[V]**:

```ts
executionMode(exec: ToolExecutionInput): ToolExecutionMode {          // tools/src/index.ts:1303
  const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
  if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }          // :1305
  try {
    const concurrencySafe: unknown = tool.isConcurrencySafe(exec.arguments)
    return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' }  // :1308
  } catch {
    return { kind: 'exclusive' }                                      // :1310
  }
}
```

Exhaustive enumeration of opt-ins (repo-wide grep for `isConcurrencySafe`, excluding the catalog
and the core plumbing at `packages/core/tools/src/schema.ts:573,626-630`) **[V]**:

| Opt-in (`→ parallel`) | Exclusive (= default) |
|---|---|
| `fs read` (`packages/fs/tool-fs/src/read.ts:136`) | `bash` (`packages/shell/tool-bash/src/index.ts:374` — no declaration) |
| `fs read-image` (`packages/fs/tool-fs/src/read-image.ts:238`) | persistent `bash` (`packages/shell/tool-bash-persistent/src/index.ts:414` — none) |
| `web search` (`packages/web/tool-web/src/search.ts:364`) | `write` (`packages/fs/tool-fs/src/write.ts:73`), `edit` (`.../edit.ts:85`) |
| `web fetch` (`packages/web/tool-web/src/fetch.ts:498`) | `pwsh` variants (`packages/shell/tool-pwsh*`) |
| 3 × `session-query` (`packages/session-query/tool-session-query/src/index.ts:90,103,118`) | all MCP-bridged tools (`packages/mcp/mcp-client` registers none) |
| `subagent` (`packages/subagent/tool-subagent/src/index.ts:470`) | `run_code` / PTC (`packages/core/tools/src/ptc.ts:336`) |

**Latency cost [I] — arithmetic, not measurement.** For a step whose assistant message requests N
exclusive calls with durations d₁…d_N, DSH wall-clock is `Σdᵢ + ε` (a strict chain, because each
exclusive call is its own group: `tool-calls.ts:90`), and even *later parallel-safe* calls cannot
start until the chain reaches them. With Codex's policy those same shell calls take
`max(dᵢ) + ε` (read locks, `parallel.rs:155-159`). Concretely: `npm test` 40 s, `cargo build` 90 s,
`git status` 2 s → ~132 s serialized vs ~92 s overlapped (a 1.4× win from one barrier); a batch of
8 independent 5 s probes (grep/curl/`git log`) → ~40 s vs ~5–6 s (≈7×). Two second-order costs
compound it: (a) no tool starts until the whole message is assembled (Finding F2/F3), so the first
tool's latency is added on top of full generation; (b) an exclusive call in the middle of a batch
splits the batch into three sequential phases instead of one (barrier at `tool-calls.ts:204-205`).
Modeled effect on a 20-tool-call turn with mixed intent: DSH's *effective* parallel width over the
tool phase is ≈1 for shell/edit-dominated turns; Codex's is ≈(number of same-message parallel-safe
calls) bounded only by the `RwLock`, i.e. effectively unbounded per step.

**What a change would look like (precise, ordered by leverage).**

1. *Cheapest, biggest win*: give shell calls an argument-aware classifier. Add
   `isConcurrencySafe: args => isReadOnlyCommand(args.command)` to the `defineTool` config of
   `packages/shell/tool-bash/src/index.ts:374` and
   `packages/shell/tool-bash-persistent/src/index.ts:414`, where the predicate is owned by the shell
   plugin (allowlist of read-only verbs: `git status|log|diff`, `rg`, `ls`, `cat`, `wc`, `curl -sI`,
   …) and defaults to `false` on any parse doubt — this matches the existing fail-closed contract at
   `tools/src/index.ts:1305-1310` and needs no scheduler change. Same treatment for MCP tools using
   the server's `readOnlyHint` annotation at the bridge registration site.
2. *Second*: make fs mutation calls path-aware — `write.ts:73` / `edit.ts:85` declare
   `isConcurrencySafe: args => true` only when the resolved absolute target path is not already
   claimed by another call in the batch. This requires the classifier to see batch context, which
   `isConcurrencySafe(args)` does not provide; the clean hook is the scheduler in
   `tool-calls.ts:199-213` (a per-group `Set<path>` consulted before `startCall`), or a
   registry-level "resource claim" key added to `ToolExecutionInput` (`packages/core/tools/src/types.ts`).
3. *Structural*: start tools as the stream emits them rather than after full assembly. Requires
   (a) a per-block completion hook on `AssistantStreamAttempt` (`assistant-stream.ts:60-71`) so a
   finished `tool-call` block can be scheduled, and (b) a dispatch point in `step()`
   (`agent.ts:440-443` currently drains the stream first) that feeds a persistent scheduler instead
   of the single `executeToolCalls` call at `agent.ts:534`. The durable-model risk is real: today the
   loop appends exactly one `assistant/message` before tool events (`agent.ts:520-529`), and the
   repair invariant in `packages/core/session/src/repair.ts:124-130` assumes tool calls are only
   known from a committed `assistant/message`; the change must keep "call event precedes result
   event" or teach `ToolCallRecovery` the new shape. Effort H, correctness-sensitive.

### F5 — How Codex's router/orchestrator decide parallelism and ordering

**Router [V].** `ToolRouter` holds the finalized registry plus the model-visible spec surface
(`core/src/tools/router.rs:74-81`). `tool_supports_parallel` is a fail-closed registry lookup
(`router.rs:235-239`), where the registry additionally requires the tool not be `Hidden`
(`core/src/tools/registry.rs:498-502`). `build_tool_call` normalizes three item shapes into a
`ToolCall` (`router.rs:246-298`), and `dispatch_tool_call_with_terminal_outcome` builds a
`ToolInvocation` snapshot (turn, step context, cancellation token, diff tracker, call id, payload)
and hands it to the registry (`router.rs:348-382`).

**Parallelism gate [V].** `ToolCallRuntime` owns one `Arc<RwLock<()>>` per sampling request
(`core/src/tools/parallel.rs:42-62`, constructed at `core/src/session/turn.rs:1374-1378`):

```rust
let supports_parallel = router.tool_supports_parallel(&call);      // parallel.rs:116
…
let _guard = if supports_parallel {
    Either::Left(lock.read().await)                                // parallel.rs:156
} else {
    Either::Right(lock.write().await)                              // parallel.rs:158
};
```

and the whole dispatch, including approval and the sandbox attempt, runs on a spawned task
(`parallel.rs:147-178`) so the model stream can continue. Consequences **[V for the code, I for the
scheduling semantics]**:

- N parallel-safe calls overlap; parallelism is unbounded by code (no semaphore) and only bounded in
  practice by the model's own call count and resource contention.
- A non-parallel call waits for every holder of the read lock to drop, and — because
  `tokio::sync::RwLock` is documented as write-preferring/fair **[I, upstream-tokio doc, not a claim
  in this repo]** — later parallel-safe calls queue behind the pending writer. That yields the
  intuitive semantics: *calls execute in model order with maximal overlap over maximal runs of
  parallel-safe calls.*
- Parallel-safe set in the core handlers **[V]**: `exec_command`, `write_stdin`, `view_image`,
  `tool_search`, MCP tools whose server advertises it
  (`core/src/tools/handlers/mcp.rs:128-132`, opt-in computed at `mcp.rs:763-796`), `test_sync`
  (test-only). Everything else — `apply_patch`, the shell tool, `request_user_input`, plan
  tools, multi-agent tools, `list_available_plugins_to_install` (explicit `false`,
  `.../list_available_plugins_to_install.rs:66-68`), `request_plugin_install` (explicit `false`,
  `.../request_plugin_install.rs:81-83`) — takes the write lock.

**Approval ordering [V].** Approval happens *inside* the tool's own spawned task, via
`ToolOrchestrator::run` → `Session::request_approval` (`core/src/tools/orchestrator.rs:144-230`).
Requests are keyed by `call_id` (+`approval_id`) in a per-turn `HashMap<String, oneshot::Sender<..>>`
(`core/src/session/mod.rs:2541-2555`, `core/src/state/turn.rs:116-128`), and the requester awaits its
own oneshot: `rx_approve.await.unwrap_or(ReviewDecision::Abort)` (`session/mod.rs:2583`). Therefore:

- **Approvals are not serialized** by the harness; several parallel-safe calls can each be pending.
  A duplicate key logs `Overwriting existing pending approval` and replaces the sender
  (`session/mod.rs:2553-2556`).
- The **guardian reviewer** serializes its own model session with `Semaphore::new(1)` but degrades
  gracefully: `try_acquire` failure spawns an ephemeral forked review
  (`core/src/guardian/review_session.rs:619-630`, `:672`), so guardian review does not become a
  global throughput bottleneck.
- **A rejection is per-call, not per-batch**: `ToolError::Rejected(msg)` is converted to
  `FunctionCallError::RespondToModel` (`core/src/tools/events.rs:431-456`), which
  `parallel.rs:86-88` turns into an ordinary failure response — siblings keep running and the model
  sees an error output for that one call.
- The exception is `ReviewDecision::Abort`, which becomes `CodexErr::TurnAborted`
  (`core/src/tools/approvals.rs:488-490`) → `FunctionCallError::Fatal` → `Err(CodexErr)` from the
  tool future: the turn ends.
- **Ordering of the escalation retry** is decided per call, not per batch: denial under the initial
  sandbox triggers the second attempt only if `tool.escalate_on_failure()` and the approval policy
  allow it (`orchestrator.rs:352-396`), and the retry's *second* approval is skipped when
  `should_bypass_approval(policy, already_approved)` holds (`orchestrator.rs:409-437`).

### F6 — Interruption / cancellation

**DSH [V].** Cancellation is a phase-scoped `AbortController` plus a durable inbox clear:
`cancel(cause, {keepInbox})` clears both inbox lists (unless told otherwise), clears the wake latch,
and aborts the active controller (`agent.ts:175-181`); the abort *reason* is the typed cause
(`user | parent | disposed | hook{reason}`), copied into `turn/end`
(`agent.ts:366-372`, `agent.ts:80-95`, `packages/core/session/src/types.ts:203`). The loop checks
the signal at every boundary (`agent.ts:273,283,302,314,328,358,402,437,441,444`) and in the tool
scheduler (`tool-calls.ts:212,229`). In-flight *started* tools are drained, not killed, and
not-yet-started calls receive synthetic `tool/call` + error `tool/result` pairs so replay stays
valid (`tool-calls.ts:238-243`, `:250-260`). Disposal is a separate, harder stop: `cancel({kind:'disposed'})`
then `whenIdle()` then scope teardown (`agent-loop/src/index.ts:543-547`).

**Codex [V].** `Op::Interrupt` → `interrupt()` → `interrupt_task()`
(`core/src/session/handlers.rs:542-545`, `:59-61`) → `abort_all_tasks(TurnAbortReason::Interrupted)`
→ cancel the task token, wait up to `GRACEFULL_INTERRUPTION_TIMEOUT_MS = 100` for graceful
completion, then `task.handle.abort()` on the Tokio handle
(`core/src/tasks/mod.rs:68,512-540,901-938`). It then optionally records a model-visible
"interrupted" marker into history so the next turn knows the prior turn was cut off
(`tasks/mod.rs:940-958`, marker construction at `tasks/mod.rs:99-115`), flushes the rollout, emits
`TurnAborted` (`tasks/mod.rs:980-987`), drops pending approvals *after* letting tasks observe
cancellation (`tasks/mod.rs:532-536`), and — for `Interrupted` only — restarts pending work
(`tasks/mod.rs:537-539`). Individual tool calls also self-cancel: `parallel.rs:182-208` selects on
the cancellation token, aborts the dispatch handle, emits `notify_tool_aborted`, and synthesises an
`aborted by user after {secs}s` output.

*Contrast:* DSH has no grace-then-hard-kill timer for the driver — cancellation is cooperative all
the way to `whenIdle()` (`agent-loop/src/index.ts:544-546`); Codex guarantees the task terminates
within ~100 ms of a hard stop, at the cost of potentially abandoning tool output mid-write. **[V]**

### F7 — Steering: can a user inject a message mid-turn?

**DSH — yes, three distinct primitives, all durable [V].**

- `followup(msg)` → `send(msg,'next-turn',true)`: a whole future turn (`agent.ts:163-165`).
- `steer(msg)` → `send(msg,'next-step',true)`: consumed at the *nearest* step boundary
  (`agent.ts:167-169`; contract at `packages/core/agent/src/runtime-types.ts:225-231`).
- `inject(msg)` → `send(msg,'next-step',false)`: context that never wakes the driver
  (`agent.ts:171-173`; contract at `runtime-types.ts:233-241`).
- Representation: two ordered lists in a *projection over the session log*
  (`packages/core/agent-loop/src/inbox.ts:27-65`); every mutation appends an
  `agent/inbox/spliced` event (`inbox.ts:227-235`), `claim()` removes and returns the batch for a
  step (`inbox.ts:109-114`), and a step re-enters when `inbox.nextStep` is non-empty even after the
  model finished (`agent.ts:359-364`).
- UI: plain Enter while busy is configurable and defaults to **queue** (`submission-settings.ts:12,18`);
  the controller routes `mode:'steer'` to `agent.steer` and everything else to `agent.followup`
  (`commands.ts:364-365`), and a still-pending queued item can be *converted* to steering later
  (`commands.ts:477-499`).
- Mid-turn delivery is a step boundary, not a stream interruption: the currently executing model
  request is untouched — verified by the fact that the signal is only checked between awaits
  (`agent.ts:437-444`) and the inbox is only claimed in `preStep` (`agent.ts:267-286`). **[V]**

**Codex — yes, folded into the same turn [V].**

- `turn/steer` (explicit, `expected_turn_id`) and `turn/start` (auto-steer when a regular turn is
  active) both land in `Session::steer_input`, which appends to `turn_state.pending_input.items`
  (`core/src/session/turn_input.rs:546-635`; entry points `codex_thread.rs:348-356,462-479`;
  app-server `turn_processor.rs:628,1035`).
- `run_turn` drains that queue at the top of each loop iteration and folds it into the next sampling
  request (`core/src/session/turn.rs:296-307`), and `needs_follow_up = model_needs_follow_up || has_pending_input`
  (`turn.rs:425`) is what keeps the turn open for it.
- Admission is refused for non-regular tasks (`Review`, `Compact`) with a typed reason
  (`turn_input.rs:569-587`), on empty input (`:592-594`), on output-schema mismatch (`:595-601`), and
  on expected-turn mismatch (`:565-571`) — a stricter contract than DSH's, which accepts steering
  into any running driver.
- Also not a stream interruption: input is only observed at the next sampling request. **[V]**

### F8 — Turn termination conditions and safety valves

**DSH [V].** `step()` returns exactly one of: `{kind:'completed'}` when the assistant message has no
tool calls (`agent.ts:532-533`), `{kind:'max-tokens'}` when the adapter reported truncation
(`agent.ts:530`), `null` when tools ran and did not conclude the turn (`agent.ts:534-538`), or
`{kind:'completed'}` when a tool result carried `concludesTurn` (`tool-calls.ts:158`,
`packages/core/tools/src/index.ts:1854-1860`). `turn()` then closes when `turnEnds != null` **and**
the next-step inbox is empty, after awaiting the serial `agent/turn-stopping` hook which may itself
steer more work (`agent.ts:359-364`). `max-tokens` is sticky across steps
(`agent.ts:336-341`). Turn end reasons are a merge-extensible union
(`packages/core/session/src/types.ts:201-228`): `completed | aborted{reason} | blocked | error{error} | max-tokens | interrupted | forked`.
Crash-orphaned turns are closed retroactively on resume by appending synthetic closers
(`agent-loop/src/index.ts:852-856`, `packages/core/session/src/repair.ts:209-211`).

**Safety valves in DSH:** abort signal at every boundary; tool-level abort → synthetic results;
`ToolCallRecovery` synthesises missing tool results when a step throws
(`agent.ts:331-353`, `session/src/repair.ts:105-207`); a plugin-supplied retry policy
(`agent.ts:494-509`); and — one level up, not in the loop — a goal-round cap
(`packages/goal/goal-round-driver/src/index.ts:166-169`). **No step cap, no turn cap, no repeat/doom
detection, and no timeout on the driver.** A blocking `Stop` hook force-continues forever, and DSH's
own bridge says so:

> `// TODO(stop-loop-guard): Codex supplies 'stop_hook_active' so a Stop hook can`
> `// avoid continuing the same turn indefinitely. It is always false here, so an`
> `// unconditionally blocking hook force-continues every step until it self-limits.`
> — `packages/hooks/hooks-codex/src/index.ts:263-265` **[V]**

(Per-tool `timeoutMs` is declared and validated in the core registry — `packages/core/tools/src/index.ts:1072-1076`,
`packages/core/tools/src/schema.ts:574-575` — but I found **no enforcement site** in the core
dispatch path; only individual tools such as `bash` implement their own deadline
(`packages/shell/tool-bash-persistent/src/index.ts:305,458`). **[V]** for the absence of a core
enforcement call; the `timeoutMs` field therefore reads as a declaration/contract today.)

**Codex [V].** The turn loop continues while `needs_follow_up` (a tool ran, an item requested a
response, or pending input exists) or until an error/stop condition:

- `end_turn == Some(false)` from the provider → `needs_follow_up = true` (`turn.rs:2606-2608`), i.e.
  an output-truncated response **auto-continues** instead of ending the turn — the opposite of DSH's
  sticky `max-tokens` turn end.
- Stop hooks can block (inject a continuation prompt, with `stop_hook_active` set so the hook can
  avoid looping) or stop (`turn.rs:466-535`).
- Context-window pressure mid-turn triggers inline auto-compaction and `continue`
  (`turn.rs:460-499`).
- Errors are reported and `break` (`turn.rs:564-590`); `TurnAborted` propagates
  (`turn.rs:563-565`).
- Budget: `SessionBudgetExceeded` from the rollout budget (`core/src/session/rollout_budget.rs:19-30`)
  surfaces as `TurnAbortReason::BudgetLimited` (`tasks/mod.rs:556,798,873`); token-budget reminders
  are injected pre-step (`core/src/session/token_budget.rs`, called at `turn.rs:462-468`).
- Repeat detection: **the guardian-rejection circuit breaker** — 3 consecutive or 10-of-50 recent
  auto-review denials in one turn force an interrupt (`core/src/guardian/mod.rs:62-66,200-231`),
  cleared at turn start/finish (`tasks/mod.rs:302-306,838-842,988-992`). This is the closest thing
  either harness has to a doom-loop valve.
- **No max-turn / max-iteration constant exists** in `core/src` or `config/src` (repo-wide grep for
  `max_turns|max_iterations` returns nothing). **[V]**

### F9 — Retry / backoff on model errors

**DSH [V].** The loop's retry hook is the `agent/request-error` waterfall, called after the failed
attempt has been durably settled as `assistant/attempt`:

```ts
const action = await this.dispatch.waterfall('agent/request-error',
  { turn, step, provider, failure: finish.failure, retryPolicy: preparedCall?.retryPolicy, signal },
  () => Promise.resolve<RequestErrorAction>(undefined))     // agent.ts:494-504
signal.throwIfAborted()
if (action?.kind !== 'retry') throw new LlmError(...)       // agent.ts:505-508
continue                                                     // agent.ts:509  (retry the step's while(true))
```

The policy executor is a separate plugin, `packages/llm/llm-retry/src/index.ts`, which:

- owns per-turn state in a projection reset by `step/start`/`turn/end` (`llm-retry/src/index.ts:130-137`);
- retries only configured codes in `normal` mode and stops at `maxRetries`
  (`llm-retry/src/index.ts:215-223`);
- computes `initialDelayMs * 2^(retry-1)` capped at `maxDelayMs`, scaled by symmetric jitter, and
  honours a provider `retryAfterMs` (`llm-retry/src/index.ts:59-64,226-238`);
- **makes the retry durable before waiting** — appends `llm/retry`, sleeps cancellably, then appends
  `llm/retry-started` (`llm-retry/src/index.ts:188-191`);
- supports `mode:'always'` for unbounded retry until success/cancel/disposal
  (`llm-retry/src/index.ts:199-214`).

Defaults (per provider route): `maxRetries 5`, `initialDelayMs 500`, `maxDelayMs 10_000`,
`jitterRatio 0.1`, retryable codes `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT`
(`packages/llm/llm/src/retry-policy.ts:14-24`; `EMPTY_RESPONSE` defined and explained in
`packages/llm/llm/src/error.ts:38-42`). Because retry is a plugin, the *loop* imposes no bound of
its own beyond the signal.

**Codex [V].** `run_sampling_request` wraps `try_run_sampling_request` in a retry loop bounded by the
provider's `stream_max_retries()` (`core/src/session/turn.rs:1384-1458`). Handling
(`core/src/responses_retry.rs:44-129`):

- `UnboundedConnectionRetries` feature + `ConnectionFailed` → infinite retry with a 5 s → 60 s
  doubling delay (`responses_retry.rs:17-18,58-83`);
- after exhausting retries, a WebSocket→HTTPS transport fallback resets the counter and retries
  (`responses_retry.rs:85-100`);
- otherwise `delay = err.retry_delay() (server-provided) ?? backoff(retry_count)`, with
  `backoff(n) = 200 ms · 2^(n-1) · U(0.9,1.1)` (`core/src/util.rs:6-7,86-91`), and each retry emits a
  `Reconnecting... {n}/{max}` notification (`responses_retry.rs:102-125`);
- defaults `stream_max_retries = 5` (cap 100) and `request_max_retries = 4` (cap 100)
  (`model-provider-info/src/lib.rs:28-35,367-375`).

**Tool errors.** Neither harness retries a *failing tool body*. DSH turns tool failures into
materialised error results (`packages/core/tools/src/index.ts:1356-1369` contract; results appended
at `tool-calls.ts:269-289`) and synthesises `ABORTED` / `ABORTED_BEFORE_DISPATCH` outcomes on
cancellation (`packages/core/tools/src/index.ts:483-486,1965,1979`). Codex's only tool-level retry is
the sandbox-escalation second attempt (`orchestrator.rs:440-499`); ordinary tool failures become
model-visible `FunctionCallError::RespondToModel` outputs (`tools/events.rs:394-456`). A `Fatal`
tool error in Codex ends the call with `Err(CodexErr::Fatal)` (`parallel.rs:85`), and
`drain_in_flight` then **logs it via `error_or_panic` and keeps draining siblings**
(`turn.rs:2168-2172`) — note `error_or_panic` **panics under `debug_assertions`** and only logs in
release (`core/src/util.rs:93-98`), so a release build silently drops a fatal tool result from the
transcript while a debug build aborts the process. **[V]** (that last consequence is a code-reading
inference from the two cited functions.)

### F10 — Concurrency control *between* agents (context for turn orchestration)

**Codex [V].** Turn admission is capped by an execution limiter: `ensure_execution_capacity_for_turn_start`
returns `AgentLimitReached{max_threads}` when the multi-agent version/session source is
execution-limited and `active >= max_threads` (`core/src/agent/control/execution.rs:29-66,68-86`); the
admission check runs before a turn starts (`codex_thread.rs:389-393,486-490`).

**DSH [V].** The analogous control is structural: a child agent's inbox is owner-scoped and the
factory tracks live agents for teardown (`agent-loop/src/index.ts:98-148`), and `subagent` tools
declare themselves concurrency-safe (`packages/subagent/tool-subagent/src/index.ts:470`), so
sibling subagent calls run in the same DSH parallel pool rather than through a global thread cap.
No `max_threads`-style limiter was found in the agent/agent-loop packages. **[V]** for absence in
those packages only.

---

## Gaps

Ordered by user-visible cost. Each is scoped to the loop axis; "Gap" means DSH lacks something Codex
has, or DSH is measurably worse on the cited code.

| # | Gap | Evidence |
|---|---|---|
| G1 | **Shell/MCP/edit batches are strictly serial.** `exec_command` overlaps in Codex; `bash` cannot overlap in DSH because no `isConcurrencySafe` is declared. Dominant wall-clock cost of agent turns. | DSH `packages/core/tools/src/index.ts:1303-1313`; Codex `core/src/tools/handlers/unified_exec/exec_command.rs:126-128`, `core/src/tools/parallel.rs:155-159` |
| G2 | **No streaming tool start.** DSH waits for the full assistant message, appends it, then dispatches; Codex dispatches per finished call item while the stream is live. Adds the whole generation tail to first-tool latency on every step. | DSH `agent.ts:440-443,512-537`; Codex `core/src/stream_events_utils.rs:321-327`, `core/src/session/turn.rs:2419` |
| G3 | **No turn-level loop guard.** Neither has a max-iteration cap, but Codex's Stop hook receives `stop_hook_active` while DSH always passes `false` (its own TODO), so a blocking Stop hook loops indefinitely. | `packages/hooks/hooks-codex/src/index.ts:263-265`; Codex `core/src/session/turn.rs:466-535` |
| G4 | **No repeat/doom-loop detection.** Codex interrupts a turn after repeated guardian denials; DSH has no analogue, so a model looping on a failing tool runs until the user or a token wall stops it. | Codex `core/src/guardian/mod.rs:62-66,200-231`; DSH: no equivalent found (grep for `doomLoop|repeatDetection|circuit`) |
| G5 | **`turn/end` on `max-tokens` ends the turn.** DSH marks the turn `max-tokens` and stops; Codex treats provider `end_turn == Some(false)` as `needs_follow_up`, continuing the turn automatically. For long file writes this means DSH hands control back mid-artifact. | DSH `agent.ts:530`, `packages/core/session/src/types.ts:214`; Codex `core/src/session/turn.rs:2606-2608` |
| G6 | **Tool `timeoutMs` is declarative only.** Declared + validated in the core registry, but no core dispatch path enforces it; only self-managing tools (bash) impose their own deadline. | `packages/core/tools/src/index.ts:1072-1076`; absent enforcement in `execute`/`prepareExecution` path (`.../index.ts:1355+`) |
| G7 | **Cancellation has no hard-stop ceiling.** DSH cancellation waits for `whenIdle()`; a wedged tool or a non-cooperative adapter can keep the driver (and disposal) alive indefinitely. Codex bounds this at 100 ms then aborts the task handle. | DSH `agent-loop/src/index.ts:543-547`; Codex `core/src/tasks/mod.rs:68,926-938` |
| G8 | **Steering is not gated by turn kind.** Codex refuses steering into `Review`/`Compact` turns with a typed reason and an expected-turn-id check; DSH's `steer` accepts any running driver and can silently miss a request whose pre-step already claimed its batch (documented at `runtime-types.ts:228-231`). | DSH `agent.ts:167-169`, `runtime-types.ts:225-231`; Codex `core/src/session/turn_input.rs:565-587` |
| G9 | **Only start/step boundaries for assistant text.** DSH publishes revision-numbered replayable frames; Codex's deltas are unrecoverable if missed. (This one is a *Codex* gap, listed for symmetry.) | DSH `assistant-stream.ts:49-109`; Codex `core/src/session/turn.rs:2614-2640` |

---

## Prioritized Recommendations

Each item: title — impact / effort — exact touch points.

**R1. Declare argument-aware concurrency safety for shell (and MCP) tools.**
Impact **H** / Effort **L**.
Touch `packages/shell/tool-bash/src/index.ts:374` (`bash` `defineTool` config → add
`isConcurrencySafe`), `packages/shell/tool-bash-persistent/src/index.ts:414`,
`packages/shell/tool-pwsh/src/index.ts`, `packages/shell/tool-pwsh-persistent/src/index.ts`, and the
MCP bridge registration in `packages/mcp/mcp-client` (map server `readOnlyHint` →
`isConcurrencySafe: () => true`). No scheduler change: `executionMode`
(`packages/core/tools/src/index.ts:1303-1313`) and the pool (`tool-calls.ts:199-213`) already do the
rest, including re-classification mid-batch. Predicate must be owned by the shell plugin and return
`true` only for a parsed, allowlisted read-only command shape — anything ambiguous stays exclusive,
matching the fail-closed contract. Add tests beside `packages/core/agent-loop/tests/tool-calls.spec.ts`
(batch of 3 read-only bash calls must overlap; a mutation command in the middle must still barrier).

**R2. Introduce a batch-context concurrency classifier for path-scoped mutations.**
Impact **M** / Effort **M**.
Touch `packages/fs/tool-fs/src/write.ts:73` and `packages/fs/tool-fs/src/edit.ts:85` (declare a
resource key), `packages/core/tools/src/index.ts:326` (`ToolExecutionInput` — add an optional
`concurrencyKey(args)`/resource-claim field, exposed on `ToolDefinition` via
`packages/core/tools/src/schema.ts:508`), and
`packages/core/agent-loop/src/tool-calls.ts:199-213` (`fillPool` consults a per-group claim set
before `startCall`). Goal: two writes to *different* resolved absolute paths overlap; same path stays
a barrier.

**R3. Add a stream-time tool dispatch path.**
Impact **H** / Effort **H**.
Touch `packages/core/agent-loop/src/assistant-stream.ts:60-71` (emit a per-block-complete signal for
`tool-call` blocks; the `BlockAssembler` already knows a block is closed,
`packages/llm/llm/src/assembler.ts:77-84`), `packages/core/agent-loop/src/agent.ts:440-443` (feed a
persistent scheduler instead of draining the whole stream first) and `agent.ts:532-537` (reconcile
the scheduler's results with the committed message). **Invariant to preserve:** the durable order
`assistant/message` → `tool/call` → `tool/result` that `ToolCallRecovery`
(`packages/core/session/src/repair.ts:124-135`) and replay rely on; either buffer tool events until
the assistant message commits, or teach recovery the new shape. Gate behind the existing
`maxParallelToolCalls` config so the semantics can be turned off.

**R4. Add a per-turn loop guard, and make DSH's Stop hook honest.**
Impact **M** / Effort **L**.
Touch `packages/hooks/hooks-codex/src/index.ts:263-272` and
`packages/hooks/hooks-claude-code/src/index.ts:273-285` (thread a real `stop_hook_active` flag, or
count blocking continuations and refuse after K), plus a loop-level guard in
`packages/core/agent-loop/src/agent.ts:313-365` — e.g. a `maxStepsPerTurn` /
`maxConsecutiveToolFailures` config next to `maxParallelToolCalls`
(`packages/core/agent-loop/src/index.ts:334-346`), ending the turn with a new
`TurnEndReasonMap` variant (`packages/core/session/src/types.ts:201-228`). This is the cheapest
defence against G3+G4.

**R5. Port a repeat/rejection circuit breaker.**
Impact **M** / Effort **M**.
Touch a new module under `packages/core/agent-loop/src/` fed by tool results
(`tool-calls.ts:147-161` is the single commit point for every result) with thresholds modelled on
Codex (`codex-rs/core/src/guardian/mod.rs:62-66`), aborting via the existing
`this.phase.abort.abort({kind:'hook', reason})` path (`agent.ts:180`) so the turn ends as
`aborted{reason:{kind:'hook'}}` (`agent.ts:80-95`) rather than a new mechanism.

**R6. Continue (or explicitly refuse) on `max-tokens` instead of silently ending.**
Impact **M** / Effort **L**.
Touch `packages/core/agent-loop/src/agent.ts:530` — either auto-continue while a
`maxTokensContinuations` budget remains (config beside `maxParallelToolCalls`,
`agent-loop/src/index.ts:334`), reusing the existing step loop, or keep the turn open and surface a
`developer/message` note so the model finishes the artifact. Codex's precedent:
`codex-rs/core/src/session/turn.rs:2606-2608`.

**R7. Enforce `timeoutMs` in the core dispatch path.**
Impact **M** / Effort **M**.
Touch `packages/core/tools/src/index.ts` around `prepareExecution`/`dispatchScheduledExecution`
(`:1355-1400`) to race the tool body against a deadline built from the definition's `timeoutMs`
(`:1072-1076`), aborting with a `TIMEOUT`-coded error result so the scheduler
(`tool-calls.ts:165-197`) records it like any other failure. Reuse `@deepseek-ai/dsh-timeout`
(`MAX_TIMER_DELAY_MS` is already the retry-policy ceiling, `packages/llm/llm/src/retry-policy.ts:12,82-83`).

**R8. Bound cancellation convergence.**
Impact **M** / Effort **M**.
Touch `packages/core/agent-loop/src/index.ts:543-547` (wrap `machine.whenIdle()` in a grace deadline
before `scope.dispose()`), mirroring `GRACEFULL_INTERRUPTION_TIMEOUT_MS`
(`codex-rs/core/src/tasks/mod.rs:68,926-934`). Must keep the existing guarantee that started tools
drain (`tool-calls.ts:238-243`) — so the deadline should escalate to a second `cancel` cause rather
than skip the drain.

**R9. Gate steering by turn/step-kind and report misses.**
Impact **L** / Effort **L**.
Touch `packages/core/agent-loop/src/agent.ts:167-169` and the contract in
`packages/core/agent/src/runtime-types.ts:225-231`: return whether the steering was claimed at a
boundary (or emit an event when a claim batch was already in flight), so
`packages/api/session-controller/src/commands.ts:477-478` can surface `session/steer-unavailable`
with parity to Codex's typed refusals (`codex-rs/core/src/session/turn_input.rs:565-587`).

**R10. Emit a first-tool-call / tool-phase telemetry histogram.**
Impact **L** / Effort **L**.
Touch `packages/core/agent-loop/src/tool-calls.ts:165-214` (record per-call start/settle offsets and
observed parallel width per group) so R1–R3 can be validated against real traffic instead of the
arithmetic in F4. Codex already has this shape in `ToolCallTimingGuard` (`codex-rs/core/src/tools/parallel.rs:32-39,296-350`).

---

## Appendix — verification notes

- **Read in full for this axis:** DSH `agent.ts`, `tool-calls.ts`, `assistant-stream.ts`, `inbox.ts`,
  `constants.ts`, `agent-loop/src/index.ts`; Codex `tools/parallel.rs`, `tools/router.rs`,
  `tools/orchestrator.rs`, `tasks/mod.rs`, `tasks/regular.rs`, `responses_retry.rs`.
  Read in targeted ranges: DSH `tools/src/index.ts` (executionMode, execute, concludesTurn),
  `llm-retry/src/index.ts`, `retry-policy.ts`, `session/src/types.ts`, `session/src/repair.ts`,
  `api/session-controller/src/commands.ts`, `hooks/hooks-codex/src/index.ts`;
  Codex `session/turn.rs`, `session/turn_input.rs`, `session/input_queue.rs`, `stream_events_utils.rs`,
  `state/turn.rs`, `state/session.rs`, `codex_thread.rs`, `session/mod.rs` (approval plumbing),
  `session/handlers.rs`, `guardian/mod.rs`, `guardian/review_session.rs`, `agent/control/execution.rs`,
  `tools/registry.rs`, `tools/events.rs`, `tools/src/tool_executor.rs`.
- **Explicitly *not* verified (would need a run):** actual wall-clock overlap of DSH parallel-safe
  calls; the ~100 ms Codex hard-abort path under a wedged tool; `tokio::sync::RwLock` write-preference
  as it affects a concrete call batch (library-documented, not asserted in-repo); whether any
  non-core caller binds `timeoutMs` externally; Codex behaviour when a `Fatal` tool error occurs in a
  release build's `drain_in_flight` (the log-only path is read, not exercised).
- **No files in either repository were modified.** The only write performed was this report.
