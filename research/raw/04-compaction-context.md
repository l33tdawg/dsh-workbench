# 04 — Context Window Management, History Retention & Compaction

**Axis:** context windows, history retention, compaction.
**Subjects:** DSH `639ed015397290b3745d163aafe02ffee4aa3f84` (tag `dsh-v0.2.0-rc.2`) at `/Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src`; Codex `2abb02bc004fe2847d1f99f47610c92d1744b22d` at `/Users/l33tdawg/nodejs-projects/codex`.
**Method:** read-only source inspection. Nothing was modified.
**Legend:** `[V]` = VERIFIED by reading the cited line(s). `[I]` = INFERRED from cited code, not directly asserted by it. Paths are repo-relative; DSH paths are relative to the DSH root, Codex paths to `codex-rs/`.

---

## 0. Two architectures in one paragraph

Codex mutates a **linear `ContextManager` history** (`core/src/context_manager/history.rs:47-70`) and, on compaction, *replaces* it with a synthesized short history (`core/src/compact.rs:359`, `core/src/session/mod.rs:3614`). DSH keeps an **append-only session log plus a folded "surface"** (`core/session/src/surface.ts:600`, `foldSurface`); compaction never deletes log events — it appends a replacement `user/message` whose `surfaceOp` shadows a span of surface positions (`compaction/compaction-basic/src/region.ts:506-509`). Codex asks a model to write a handoff note; DSH asks a model to write a structured checkpoint that is then *wrapped in a fixed preamble*. Both are lossy at the message level; DSH retains a verbatim recent tail including tool results, Codex's default paths do not. `[V]`

---

## 1. Side-by-side

| Dimension | DSH | Codex |
|---|---|---|
| **Trigger — automatic** | `agent/pre-step` listener on every step; pressure only (`compaction-basic/src/index.ts:158-176`). Also fires during compaction-enabled flows with `auto: true` default (`config.ts:108`). | Post-sampling, **mid-turn only**, and only when the turn will continue: `should_roll_over = needs_follow_up && (new_context_requested \|\| token_limit_reached)` (`core/src/session/turn.rs:460-461`). Pre-turn compaction only on model switch / comp-hash change (`turn.rs:1100-1193`). |
| **Trigger — threshold** | `thresholdTokens = floor(min(0.8 * contextWindow, contextWindow - reservedOutput - 65536))` (`compaction-basic/src/config.ts:191-194`). | `auto_compact_token_limit = min(config, contextWindow * 9/10)` (`protocol/src/openai_models.rs:499-510`); hard cap `contextWindow * effective_context_window_percent/100` (default 95) (`protocol/src/openai_models.rs:377-379`, `core/src/session/context_window.rs:83-85`). |
| **Trigger — error** | `agent/request-error` with `CONTEXT_WINDOW_EXCEEDED_CODE`, bounded by `maxOverflowRetries` (default 1) (`compaction-basic/src/index.ts:190-234`). | No overflow-triggered compaction of the *main* turn: `ContextWindowExceeded` sets tokens-full and **fails the turn** (`core/src/session/turn.rs:1425-1429`). Overflow *during compaction* is handled by dropping the oldest history item (`compact.rs:314-323`). |
| **Trigger — human** | `/compact` command → `ctx.compaction.compactNow` (`compaction/command-compact/src/index.ts:67`). | `/compact` slash command → `CompactTask` (`tui/src/chatwidget/slash_dispatch.rs:264-274`, `core/src/tasks/compact.rs:22-83`). |
| **Trigger — model** | **None.** No tool can invoke compaction; `compactNow` has exactly one caller, the human command `[V]`. | **Yes**: `new_context` tool, `ToolExposure::DirectModelOnly` (`core/src/tools/handlers/new_context_window_spec.rs:6-19`, registered `core/src/tools/spec_plan.rs:1199`), handled at `new_context_window.rs:38` → `request_new_context_window()` → `should_roll_over` (`turn.rs:461`). |
| **Algorithm** | Deterministic range selection (retain `retainTokens` from the tail, walk back to a tool-pairing-balanced cut — `region.ts:117-155`), optional model-free middle-prune pass first (`index.ts:323-327`), then one LLM one-shot summarization that **replays the conversation's own prefix** to reuse the KV cache (`summarizer.ts:120-181`). | LLM summarization with a fixed prompt, then a synthesized replacement history: recent **user messages only** (local) or user/developer/assistant/agent messages (remote v2), plus the summary. |
| **Retention of recent context** | Verbatim tail of `floor((W - reservedOutput) * 0.16)` tokens (`config.ts:23`, `195-197`) — assistant messages, tool calls **and tool results** all survive inside the tail. | Local: only the most recent user messages, capped at `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` (`compact.rs:62`, `657-688`) — assistant text, tool calls and tool results are **dropped**. Remote v2: messages only, `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000` (`compact_remote_v2.rs:77`), with `should_keep_compacted_history_item` returning `false` for every call/output/reasoning item (`compact_remote.rs:372-399`). |
| **Lossy?** | Summary replaces a span (lossy at message level) but (a) the log retains every original event, and (b) the retained tail is verbatim. | Replacement history is a *new* object; the rollout still contains the pre-compaction items on disk, but replay stops at the last `CompactedItem` with `replacement_history` (`rollout/src/model_context.rs:24-62`). |
| **Model-invocable** | No. | Yes (`new_context`), plus user `/compact`. |
| **Post-compaction briefing** | Fixed preamble + `<compacted-summary>` with eight mandated sections incl. **Current Work** and **Next Step** (`summarizer.ts:32-71`). | Fixed `SUMMARY_PREFIX` ("Another language model started to solve this problem…") + free-form summary (`prompts/templates/compact/summary_prefix.md`, `compact.rs:356`; prompt at `prompts/templates/compact/prompt.md`). |
| **Post-compaction warning** | None. | Explicit user-visible warning: "Heads up: Long threads and multiple compactions can cause the model to be less accurate…" (`compact.rs:394-397`). |
| **Image handling** | No compaction-time image logic. Reactive only: on `IMAGE_OFFLOAD_REQUIRED`, permanently mark the *oldest* retained images `offloaded` (`compaction-image-offload/src/index.ts:26-40`, `image-offload.ts:16-45`). | Remote v2 has a real image budget: retained messages are truncated from the tail with images kept **atomic** (`compact_remote_v2_images.rs:29-90`), gated by `Feature::CompactionImageBudget` (default on — `features/src/lib.rs:1661-1666`). |
| **Large tool results** | Spill to a private file with a locator + retrieval hint (default on, `maxInlineTokens: 12500` — `bundle/base/cordis.patch.yml:407-410`), *plus* a middle-pruner at 8192 chars (`bundle/base/cordis.patch.yml:418-423`). | Truncated **destructively at record time**: `truncate_function_output_payload(output, policy * 1.2, …)` (`context_manager/history.rs:207-213`); model metadata declares `{mode: tokens, limit: 10000}` for current models (`models-manager/models.json:15-18`). |

---

## 2. "What was I doing / next steps" — does DSH preserve the brief?

**Codex's prompt** — `prompts/templates/compact/prompt.md` (verbatim, 9 lines) `[V]`:

```
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

**Codex's summary prefix** — `prompts/templates/compact/summary_prefix.md` (verbatim, one line) `[V]`:

```
Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
```

Injected as `summary_text = format!("{SUMMARY_PREFIX}\n{summary_suffix}")` (`compact.rs:356`) and recognized on later passes by a raw string prefix test (`compact.rs:572-574`). Users may override the prompt via `config.compact_prompt` (`compact.rs:123-128`, `tasks/compact.rs:65-69`).

**DSH's equivalent** — there are two pieces, both in `compaction/compaction-basic/src/summarizer.ts`. `[V]`

The wrapping preamble (`summarizer.ts:70-71`):

```
This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.
```

And the summarization directive (`summarizer.ts:32-67`), quoted with its section list intact:

```
You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
## Key Technical Concepts
## Files and Code
## Errors and Fixes
## Pending Jobs
## Current Work
## Next Step
## Critical Context

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.
```

The result is framed by `frameSummary` into `CHECKPOINT_PREAMBLE\n\n<compacted-summary>` … `</compacted-summary>` (`summarizer.ts:188-194`).

**Verdict.** Yes — and on paper *better specified than Codex's*: DSH mandates `## Current Work` and `## Next Step`, forbids dropping sections, and explicitly instructs the model how to merge a prior checkpoint on repeated compaction. Codex's prompt asks for the same content but as three loose bullets with no schema and no recursion guidance. The trade-off is the opposite of what one might assume: DSH's brief is more structured but arrives *before* the retained tail (the checkpoint is inserted at the position of the shadowed span, `region.ts:506-509`), whereas Codex deliberately puts the summary **last** so the model reads it as the newest item (`compact.rs:64-79`).

### 2b. What DSH does **not** re-inject: todo state

DSH's todo list is exposed to the model *only* through the `todo_write` tool (`todo/tool-todo/src/index.ts:136`); there is no `todo_read`, and no package registers a `ctx.systemPrompt.section(...)` for the todo list (verified by enumerating all `systemPrompt.section` registrations across `packages/`). `[V]`

Consequence: if the `todo_write` call/result for the current list falls inside a compacted span and the summary's `## Pending Jobs` bullet is thin, the model loses its task list and has no tool to read it back. Plan mode and goal state are safer: plan mode renders into the **system prompt** as a section (`plan/plan-mode/src/index.ts:217-224`), which node 0 protects from replacement (`core/session/src/surface.ts:499-511`). `[V]` `[I]` for the loss consequence.

---

## 3. Very large individual tool results

### Codex — destructive middle-truncation at record time

```rust
// core/src/context_manager/history.rs:207-213
if let ResponseItem::FunctionCallOutput { output, .. }
| ResponseItem::CustomToolCallOutput { output, .. } = &mut processed.item
{
    let policy = metadata
        .and_then(|metadata| metadata.fallback_token_limit_override)
        .map(TruncationPolicy::Tokens)
        .unwrap_or(policy * 1.2);
    truncate_function_output_payload(output, policy, estimate_audio_token_count);
}
```

`policy` is `turn_context.model_info().truncation_policy`; current models declare `{"mode":"tokens","limit":10000}` (`models-manager/models.json:15-18`), so a tool result is capped at ~12 000 tokens *as it enters history*. The cut is a middle elision with the marker `…{removed_count} tokens truncated…` (`utils/string/src/truncate.rs:127-133`). The removed text is **gone** — nothing spills to disk, no locator is offered, no recovery path exists. `[V]`

Codex's second mechanism is a *retroactive* rewrite used only inside the compaction request path: `trim_function_call_history_to_fit_context_window` walks history newest→oldest and replaces tool outputs with the sentinel `"Output exceeded the available model context and was truncated"` (`compact_remote.rs:401-459`, `518-522`; callers `compact_remote_request.rs:35`, `compact_remote_v2_attempt.rs:44`). The call/result pairing is preserved. `[V]`

### DSH — spill to disk, then a second, lossy prune layer

**Layer 1 — spill (default on).** `spill-policy` measures retained text+images against `maxInlineTokens` (`bundle/base/cordis.patch.yml:407-410` ships `12500`). Over budget, it writes the **complete** result to a private file and keeps ordered head/tail plus a notice (`spill/spill-policy/src/index.ts:91-131`):

```ts
const ref: SpillRef = await spillStore.saveText({
  owner: { sessionId: owner }, source: { kind: 'tool', toolName, callId, label },
  suggestedName: `${toolName}.txt`, content: fullText(content),
})
```

The notice text (`spill/spill-policy/src/notice.ts:7`, `21-24`) is:

```
(<N> bytes omitted[ Omitted <M> images.]) Full formatted result stored at: <locator>. <retrievalHint>
```

and the local backend's hint is `'Use read with offset/limit, or grep this path to search within it.'` (`spill/spill-local/src/index.ts:159`). Files land at `<root>/session-<sha256(sessionId)[0:12]>/<12 hex>-<encodedName>`, written `open(path, 'wx', 0o600)` under a `0700` directory (`spill/spill-local/src/store.ts:110`, `spill-local/src/index.ts:56-70`). Retention: one best-effort startup sweep deletes files older than `cleanupPeriodDays` (default 30; `0` disables) (`spill-local/src/index.ts:68`, `126-129`). Failure is best-effort and never turns a successful call into an error (`spill-policy/src/index.ts:126-129`). `[V]`

**Layer 2 — middle prune (default on, and lossy).** `compaction-tool-result-pruner` rewrites each over-budget `tool/result` **on the durable surface** to `head(4096) + marker + tail(1024)` when the text exceeds `thresholdChars: 8192` (`compaction-tool-result-pruner/src/config.ts:7-15`, `src/index.ts:136-176`):

```ts
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
export const DEFAULTS: ResolvedConfig = deepFreeze({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
```

This second layer is genuinely lossy and **window-independent**: on a 372 k-token model it still prunes a 12 KB file read, and the removed middle is not written anywhere. It logs a `compaction/prune` shadow-price event and replaces the node (`index.ts:160-174`). Note the exemption: `read` results skip layer 1 to avoid a read/spill loop (`spill-policy/src/index.ts:135`). `[V]`

**Summary.** Codex truncates hard at ~10 k tokens and keeps no copy. DSH spills a full recoverable copy *and then* independently destroys the middle at 8 KB. The two layers are not coordinated: layer 2's budget is a fixed character count, so DSH's theoretical advantage is partially undone by its own pruner.

---

## 4. Token accounting

### DSH — heuristic fold anchored on provider usage

Estimator (`llm/token-meter/src/estimate.ts:13-16`): `CHARS_PER_TOKEN = 4`, `BLOCK_OVERHEAD = 4`, `ROLE_OVERHEAD = 4`. Text/reasoning price `ceil(len/4) + 4`; tool calls price name+arguments; images take a structural JSON price unless the route declares image pricing (`route-pricing.ts:44-76`). There is **no BPE/tiktoken tokenizer anywhere** in the repo for local counting `[V]`.

Measurement is a replay fold over the durable log (`token-meter/src/index.ts:101`, `146-190`):

```ts
// token-meter/src/index.ts:168-171
baseline = usage !== undefined && usageTokens(usage) >= estimatedAnchorTokens
  ? { kind: 'usage', tokens: usageTokens(usage), usage }
  : { kind: 'estimated', tokens: estimatedAnchorTokens }
surfaceDeltaTokens = surface.surfaceTokens - anchorSurfaceTokens
// :187
totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
```

So: when the last successful call reported provider usage under a matching request header, the baseline **is** reported usage (input + cache read + cache write + output, `:57-59`); otherwise it is the full heuristic. On top, the *signed* heuristic delta of the current surface versus the anchor's node snapshot is applied, repriced under the current route. `[V]`

Coverage: the system prompt is surface node 0 and priced by `estimateSystemMessage`; tool schemas by `estimateToolsTokens(header)`; attachments by route pricing; the output reservation is **not** added to `totalTokens` but *is* subtracted when computing the pressure budget (`compaction-basic/src/config.ts:172`, `181`). Everything DSH's context plugins inject is a surface event, therefore counted (`time-context/src/index.ts:185-231`, `agent-instructions/src/index.ts:315-350`, `plan/plan-mode/src/index.ts:197-215`). `[V]`

Decision: `measurement.totalTokens < spec.thresholdTokens → no compaction` (`compaction-basic/src/index.ts:319`), re-measured after the prune pass (`:327`).

### Codex — provider usage anchored, heuristic for the tail

```rust
// core/src/context_manager/history.rs:439-454
pub(crate) fn get_total_token_usage(&self, server_reasoning_included: bool) -> i64 {
    let last_tokens = self.token_info.as_ref().map(|info| info.last_token_usage.total_tokens).unwrap_or(0);
    let items_after_last_model_generated_tokens = self.items_after_last_model_generated_item()
        .map(estimate_item_token_count).fold(0i64, i64::saturating_add);
    …
}
```

`estimate_item_token_count` = serialized JSON bytes / 4, ceiling (`history.rs:573-576`, `utils/string/src/truncate.rs:4`, `80-83`), with a special-case `RESIZED_IMAGE_BYTES_ESTIMATE = 7373` bytes ≈ 1844 tokens per image and a 32 px patch model for `detail: original` (`history.rs:582-598`). The comment is candid: *"Estimate token usage using byte-based heuristics from the truncation helpers. This is a coarse lower bound, not a tokenizer-accurate count."* (`history.rs:262-264`). After a compaction Codex **re-anchors** by recomputing the whole history heuristically and writing it into `last_token_usage` (`core/src/session/mod.rs:4226-4263`). `[V]`

### Comparison

* Both are hybrid: provider-reported anchor + local 4-chars-per-token delta. DSH's fold is finer-grained (per-node, route-repriced, signed) and its system prompt/tools are explicitly priced; Codex relies on the provider's number having already included them and only estimates items appended after the last model output.
* DSH's surface nodes and Codex's history items are priced with the *same* crude 4:1 heuristic — neither has a real tokenizer.
* **The thresholds are not comparable in spirit.** Codex compacts at 90 % of the raw window (falling back to 95 % as a hard cap). DSH compacts at `min(80 %, W − reservedOutput − 65536)`.
* DSH's default `headroomTokens = 65536` (`config.ts:75`) dominates the ratio for every realistic window: the ratio binds only when `W ≥ 5·(reservedOutput + 65536)`, i.e. **W ≥ ~369 k with an 8 k output reservation**. For `W = 128 000, R = 8 000`: `messageBudget = 120 000`, `pressureBudget = 54 464`, `threshold = min(102 400, 54 464) = 54 464` — **42.6 % of the window**. For `W = 272 000, R = 10 000`: threshold = 196 464 (72 %). `[V]` arithmetic, `[I]` for the "dominates" generalization.
* Below `W ≈ 73 536 + R`, `pressureBudget ≤ 0` and `resolveCompactSpec` **throws** `TargetPressureConfigError` (`config.ts:182-190`). On a 32 k or 64 k model, automatic pressure compaction is therefore impossible under shipped defaults. `[V]`

---

## 5. Hard context overflow

### Codex

* **Main turn:** `CodexErrorDetails::ContextWindowExceeded` → `sess.set_total_tokens_full(...)` and the error is returned (`core/src/session/turn.rs:1425-1429`). The turn fails; there is no in-turn retry with a reduced prompt. Because the trigger check runs *after* sampling and requires `needs_follow_up`, a turn whose first request overflows is not rescued by auto-compaction. `[V]` `[I]` for the "first request" case.
* **During compaction:** graceful. Inside the compact loop, on overflow it drops the oldest item and retries with `retries = 0`:

```rust
// core/src/compact.rs:314-323
Err(e) if matches!(e.details(), CodexErrorDetails::ContextWindowExceeded) => {
    if turn_input_len > 1 {
        // Trim from the beginning to preserve cache (prefix-based) and keep recent messages intact.
        error!("Context window exceeded while compacting; removing oldest history item. Error: {e}");
        history.remove_first_item();
        retries = 0;
        continue;
    }
    sess.set_total_tokens_full(turn_context.as_ref()).await;
    …
}
```

`remove_first_item` also removes the paired counterpart and clears the world-state baseline (`history.rs:293-305`, `normalize.rs:227`). The loop has **no attempt cap** — the comment at `turn.rs:469` says "as long as compaction works well in getting us way below the token limit, we shouldn't worry about being in an infinite loop." `[V]`

### DSH

```ts
// compaction-basic/src/index.ts:190-200
ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
  if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
  this.overflowAgents.set(agent.session, agent)
  const target = routedTarget(agent.session)
  if (target === undefined) return next()
  const policy = resolveTargetPolicy(this.config, target)
  const retries = this.overflowRetries.get(agent) ?? 0
  if (retries >= policy.maxOverflowRetries) return next()
```

Recovery is a **durable surface repair, not a provider retry**, and it returns `{ kind: 'retry' }` (`:218`, `:233`). The overflow branch of `compactIfNeeded` bypasses the normal threshold and retained-tail policy: it prunes first, then selects a range with `retainTokens = 0` (`:294-302`), which reduces the tail to the last tool-pairing-balanced cut. The retry budget is reset on `agent/status === 'idle'` and on any `assistant/message` (`:178-188`). Cancellation always wins; if the summary fails *after* a durable prune advanced the surface generation, DSH still retries from the repaired surface (`:206-227`) — a thoughtful detail. `[V]`

Gracefulness: **DSH recovers; Codex does not** (for the main turn). But DSH's recovery has a hole: the summarization request itself replays the shadowed region (`region.ts:544-563`) and is issued through the same `ctx.llm.stream()`. If that request also overflows, `recover` is the `compaction/summary-error` waterfall, and **the only registered listener is image-offload** (`compaction-image-offload/src/index.ts:33-41`); nothing trims the summarization input. The error then propagates, `compactionSurfaceRegion` records a failed `compaction/end` and rethrows (`region.ts:240-251`), and the handler either retries once (if a prune landed) or **preserves the original request error** (`index.ts:219-227`). There is no oldest-item-drop equivalent to `compact.rs:320`. `[V]`

---

## 6. Regression risks on long coding sessions (DSH)

1. **Compaction that cannot compact its own input.** `[V]` for the mechanism, `[I]` for frequency. As above: no input-reduction fallback exists for a summarization request that itself overflows. On a session dominated by large *user* messages or assistant text (which the pruner cannot touch — it only rewrites `tool/result` nodes, `compaction-tool-result-pruner/src/index.ts:136-143`), overflow recovery can fail permanently and the turn dies with the original error.
2. **Auto-compaction is unreachable on ≤ ~73 k windows under shipped defaults.** `headroomTokens: 65536` is absolute, not a ratio; `resolveCompactSpec` throws rather than degrading (`config.ts:182-190`), and the pressure listener downgrades that throw to a once-per-target warning and continues the turn (`index.ts:166-173`). Net effect on such models: no proactive compaction at all, and a hard overflow is the first signal.
3. **Compaction fires very early on 128 k-class models (≈ 42 % of window).** More compaction events per session mean more summarization passes, more latency, and more cumulative fidelity loss — the exact failure mode Codex warns the user about (`compact.rs:394-397`), which DSH does not surface.
4. **The pruner is a silent, window-independent information destroyer.** `thresholdChars: 8192` with an 8 KB→4 KB+marker+1 KB rewrite (`config.ts:10-15`) applies at every step on every model, and the removed middle is unrecoverable. Because it runs on *every* pressure evaluation (`index.ts:324`) rather than only when compaction actually proceeds, repeated near-threshold steps progressively shred the oldest tool outputs.
5. **Todo state is not re-injected.** Section 2b. The model can lose its plan mid-session with no read-back tool.
6. **Later in-history `system/message` nodes are compactable.** Only surface node 0 is protected:

   ```ts
   // core/session/src/surface.ts:494-497
   * Protect the system prompt at surface node 0. A replacement covering node 0
   * while that node is a `system/message` must itself be a `system/message` over
   * exactly that node; later system nodes carry no protection and a compaction
   * range may shadow them.
   ```

   `selectCompactableRange` likewise exempts only node 0 (`region.ts:131`). On routes where the effective prompt is an appended `system/message` (`core/agent-loop/src/runtime-context.ts:88-104`), a compacted span can shadow it. The system-prompt projection self-heals by appending a fresh node on the next pre-step (`runtime-context.ts:104-106`), so this is a transient, not permanent — but it is a real ordering hazard and is documented as unprotected. `[V]` mechanism, `[I]` severity.
7. **No summary-quality feedback loop.** If the model emits a compliant-but-useless checkpoint, nothing detects it beyond the mechanical `framedSummaryTokenCount >= shadowedRouteTokenCount` shrink test (`region.ts:417-422`). A summary of "(none)" in every section passes.
8. **Cost accounting:** `measure()` re-prices the whole surface on every call (`token-meter/src/index.ts:151`, `priceSurface` maps every node), and `compactIfNeeded` calls it up to `2 + compactionRetries` times (`index.ts:277`, `297`, `325`, `339`). On a long session this is O(surface × attempts) on the hot pre-step path. `[V]` mechanism, `[I]` for materiality.

---

## 7. Prioritized Recommendations

### R1 — Add a model-invocable compaction tool (parity with Codex `new_context`)
**Impact: M · Effort: M**
DSH has a strong model-facing reason to self-compact ("I am about to do a large read") and no way to express it. Expose the existing seam.
*Files/functions:* `packages/compaction/compaction/src/index.ts` — extend `CompactionTrigger` (line 38) with `'model-request'`; `packages/compaction/compaction-basic/src/index.ts` — handle the new trigger in `compactIfNeeded` (line 269) with an open-turn owner; new package `packages/compaction/tool-compact/` registering a tool via `ctx.tools`; wire it in `packages/bundle/base/cordis.patch.yml` next to `command-compact` (line ~345).

### R2 — Make compaction survive its own overflow (input-reduction fallback)
**Impact: H · Effort: M**
Port Codex's `remove_first_item` retry loop (`codex-rs/core/src/compact.rs:314-323`) into the DSH recovery path.
*Files/functions:* `packages/compaction/compaction-basic/src/region.ts` — in `summarizeCompaction` (lines 387-409), on an overflow-coded error, shrink the selected span (drop the oldest N% of `shadowedSeqs`) and re-prepare before retrying; and/or register a second `compaction/summary-error` listener in `packages/compaction/compaction-tool-result-pruner/src/index.ts` that applies a progressively tighter `thresholdChars` to the selected seqs and returns `true`.

### R3 — Fix the pressure budget so small/medium windows can compact
**Impact: H · Effort: L**
*Files/functions:* `packages/compaction/compaction-basic/src/config.ts` — `resolveConfig` (lines 75-76) and `resolveCompactSpec` (lines 181-194). Clamp headroom so the ratio can govern: `effectiveHeadroom = min(headroomTokens, max(0, messageBudgetTokens - floor(contextWindow * thresholdRatio)))`, and degrade with a warning instead of throwing `TargetPressureConfigError` when `pressureBudget <= 0`. Add a regression test beside `compaction-basic/tests/compaction-basic.spec.ts:446-455`.

### R4 — Re-inject durable task state after compaction
**Impact: M · Effort: M**
*Files/functions:* `packages/todo/tool-todo/src/index.ts` — register a `ctx.on('compaction/end', …)` (or an `agent/pre-step` observer keyed off `compaction/end`) that appends a fresh `user/message` rendering the current list; alternatively add a `todo_read` tool. Mirrors Codex's `InitialContextInjection::BeforeLastUserMessage` re-injection (`compact.rs:91-114`, `586-642`).

### R5 — Derive the pruner budget from the routed model instead of a fixed 8192 chars
**Impact: M · Effort: L**
*Files/functions:* `packages/compaction/compaction-tool-result-pruner/src/config.ts` (`DEFAULTS`, lines 10-15) and `src/index.ts` `pruneSession` (line 136) — accept an optional token/char budget and compute it in `compaction-basic/src/index.ts` (lines 296, 324) from `resolveCompactSpec(...).retainTokens`; log each prune at INFO with `charsBefore/charsAfter` (already returned in `PruneResult`).

### R6 — Give the image path a proportional policy
**Impact: M · Effort: M**
*Files/functions:* `packages/compaction/compaction-image-offload/src/image-offload.ts` — `offloadOldestImages` (line 16) currently offloads exactly `failure.offloadImages`; change to `max(count, ceil(retained × fraction))` so repeated failures converge; add a proactive oldest-image prune in `compaction-basic/src/index.ts` before the summary call. Codex's reference implementation: `compact_remote_v2_images.rs:29-90` + `RetainedImageBudget` (`compact_remote_v2.rs:70-77`, `489-515`).

### R7 — Never let a compacted span shadow a `system/message` node
**Impact: L · Effort: L**
*Files/functions:* `packages/compaction/compaction-basic/src/region.ts` — `selectCompactableRange` (lines 117-155): extend the `firstIdx` rule (line 131) to also refuse to end the range on/past the last surviving `system/message`; or extend `assertSystemHeadRewrite` in `packages/core/session/src/surface.ts:499-511` to protect the newest system node as well.

### R8 — Observability: always log the compaction decision inputs
**Impact: L · Effort: L**
*Files/functions:* `packages/compaction/compaction-basic/src/index.ts` — the `agent/pre-step` listener (lines 158-176). Log `{provider, model, contextWindow, thresholdTokens, retainTokens, totalTokens, baselineKind}` at debug on every evaluation and at info when the threshold is crossed, so "why did/didn't it compact" is answerable without reading `token-meter` internals.

### R9 — Surface the repeated-compaction caution
**Impact: L · Effort: L**
*Files/functions:* `packages/compaction/compaction-basic/src/index.ts` — after `logResult` (lines 150-156), emit a session-visible notice once the session's cumulative compaction count exceeds a threshold. Codex's text: `compact.rs:394-397`.

---

## Appendix — file map used

**DSH:** `packages/compaction/compaction/src/{index,types,checkpoint,tool-pairing,invariant}.ts`; `packages/compaction/compaction-basic/src/{index,region,config,summarizer,types}.ts`; `packages/compaction/compaction-tool-result-pruner/src/{index,config}.ts`; `packages/compaction/compaction-image-offload/src/{index,image-offload,projection,project-message}.ts`; `packages/compaction/command-compact/src/index.ts`; `packages/spill/{spill,spill-policy,spill-local}/src/*`; `packages/llm/token-meter/src/{index,estimate,route-pricing,surface-fold,types}.ts`; `packages/core/session/src/{surface,index,tool-history,request-header}.ts`; `packages/core/agent-loop/src/runtime-context.ts`; `packages/bundle/base/cordis.patch.yml`; `packages/todo/tool-todo/src/index.ts`; `packages/plan/plan-mode/src/index.ts`; `packages/context/{time-context,agent-instructions}/src/index.ts`; `docs/subsystems/compaction.md`.

**Codex:** `core/src/compact.rs`; `core/src/compact_token_budget.rs`; `core/src/compact_remote.rs`; `core/src/compact_remote_v2.rs`; `core/src/compact_remote_v2_images.rs`; `core/src/compact_remote_history.rs`; `core/src/compact_remote_request.rs`; `core/src/context_manager/{history,normalize}.rs`; `core/src/session/{turn,context_window,token_budget,mod}.rs`; `core/src/tasks/compact.rs`; `core/src/tools/handlers/new_context_window{,_spec}.rs`; `core/src/context/compaction_summary.rs`; `core/src/context/token_budget_context.rs`; `prompts/templates/compact/{prompt,summary_prefix}.md`; `prompts/src/compact.rs`; `protocol/src/openai_models.rs`; `utils/string/src/truncate.rs`; `utils/output-truncation/src/lib.rs`; `rollout/src/model_context.rs`; `history/src/lib.rs`; `features/src/lib.rs`; `models-manager/models.json`.

**Absent in this Codex checkout (do not cite):** `core/src/message_history.rs`, `core/src/truncate.rs` — neither exists; truncation lives in `utils/string` + `utils/output-truncation`. `codex-rs/history/` exists but is the `ResponseItemEnvelope`/`CompactedItem` type crate, not an input-history feature. `[V]`
