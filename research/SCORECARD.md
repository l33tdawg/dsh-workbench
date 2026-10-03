# How close are we? A scorecard against the original ask

The ask: **take the best of Codex into DSH so DSH becomes better at coding.** The stated pain is
concrete: the agent misses things, and produces bugs where it should produce clean fixes.

Short answer: **not close, and skewed toward the easy half.** Roughly 5 of 22 identified Codex
advantages are addressed, and the ones left are the mechanical ones that actually cause the
mistakes.

Worse, and worth saying plainly: **nothing built so far has been shown to reduce mistakes.** A
mistake is now defined and counted, and the count has not moved in the direction the work predicted;
see [Re-measured](../tools/README.md). The sharpest version of that, measured 2026-10-03: the one
counter with a named plugin behind it — `read-after-edit`, which `dsh-edit-feedback` was built to cut
— shows **no detectable change** once the events are normalised by the files a session edited,
−5% with an interval that includes no change. The counter that did fall, `rework` at −36%, is one
nothing was built for. The earlier reading that looked like a halving was mostly the denominator:
the post-install sessions were simply less edit-heavy per call. The three mechanical items below were
built after this page was written, so the rows that said "No" now describe a plugin that is mounted
and running in the desktop profile rather than nothing at all. What is still missing is the
comparison that would let anyone say whether they help.

---

## What Codex is actually better at, and where each stands

| # | Codex advantage | Status |
|---|---|---|
| 1 | Engineered behavioural prompt (~7.6k tokens) | **Partial.** Guidance pack adds 1.76k tokens. |
| 2 | Deferred tool loading + `tool_search` | **Measured, then dropped.** 14.2k tokens on every call, but 4.5% of a real request and 1.4% of the window. See [Item 2](#item-2-measured-before-it-was-built-and-dropped). |
| 3 | Freeform/grammar-constrained tools | Not addressed. |
| 4 | `apply_patch` multi-file editing | **Addressed.** |
| 5 | Network isolation in the sandbox | **Addressed.** |
| 6 | Guardian automatic approval review | **Addressed** (enablement documented). |
| 7 | Shell tools marked concurrency-safe | Not addressed. |
| 8 | Stream-time tool dispatch | Not addressed. |
| 9 | 12 lifecycle hooks, argument rewrite, trust gate | Not addressed. |
| 10 | MCP OAuth and dynamic headers | Not addressed. |
| 11 | Automatic memory pipeline | Not addressed. |
| 12 | Execpolicy command rules | Not addressed. |
| 13 | Approval memory (prefix grants) | **Addressed.** [`dsh-approval-memory`](../packages/dsh-approval-memory) answers the approval waterfall from command-prefix rules. |
| 14 | Same-turn escalation retry | **Measured, then dropped.** 1 denial in 18,660 tool calls, recovered in the same turn the runtime's own hint. See [Item 14](#item-14-measured-then-dropped). |
| 15 | LSP diagnostics fed into the edit loop | Not addressed. |
| 16 | `request_permissions` with a full profile | Not addressed. |
| 17 | `get_context_remaining`, `new_context_window` | Not addressed. |
| 18 | Feature flags with a lifecycle stage | Not addressed. |
| 19 | Plugin marketplace | Not addressed. |
| 20 | Built-in skills | Not addressed. |
| 21 | `memories.*` tools | Not addressed. |
| 22 | Multi-environment routing | Not addressed. |

Five of twenty-two. Weighted by how much each affects day-to-day coding quality, it is maybe 30%,
because #1 and #4 are among the bigger ones. But the distribution is wrong: what got built is the
part that was convenient to build.

## Item 2, measured before it was built, and dropped

Deferred tool loading is the one row on that table whose cost is a number, so the number was taken
before anything was written. `tools/tool-budget.mjs` reads the tool array back out of the recorded
request header, so these are bytes that were actually sent rather than an estimate. Corpus as of
2026-10-02, every recorded session on this machine:

```
sessions 63, model calls 12,450, context window 1,000,000 tokens (recorded per session)

tool block, as sent     median  59,597 chars over 65 tools   (~14,182 tokens)
                        largest 65,826 chars over 70 tools
  mcp__* share of the block        60.5%   (35 SAGE tools alone: 37,302 chars)
  share of the preamble            78.9%   (tools against tools + system prompt)
  share of the context window       1.4%

share of a real request p10 0.8%   median 4.5%   p90 16.0%
  (tools + system + conversation so far, measured at each of the 12,450 calls)
```

The corpus grows while the machine is used, so the counts move between runs; the command
re-derives them.

**Dropped, and the number is what dropped it.** The 78.9% is the figure that made this item look
worth building, and it is a share of the wrong denominator: the preamble is what a request carries
before anyone has said anything, and every real request carries a conversation with it. At the
median call the tool block is 4.5% of the request and 1.4% of a context window this corpus never
fills — the median session's *last* call is 195,870 prompt tokens of 1,000,000. The count is not
what misleads here: 35 of 65 tools really are 60.5% of the block's bytes. What misleads is treating
the block as the request.

Two SDK findings belong with the number, because they are what a revisit would need.
`deferLoading` is real and consumed: the route this profile runs on (`deepseek-official`, baseURL
`https://api.deepseek.com/anthropic`) maps it to `defer_loading`, sends the
`mid-conversation-tool-changes-2026-07-01` beta header with tool updates, and already declares a
`__pi_deferred_placeholder__` on the first request to keep Anthropic's hidden tool-search scaffolding
inside the cached prefix. The generic route throws
`LlmError("Deferred tool loading is not supported yet", "UNSUPPORTED_CONTENT")` if any tool sets the
field. And `dsh-mcp-client` builds its tool definitions from `{name, rawName, description,
inputSchema, outputSchema, taskRequired, call}`, so the 60.5% of the block that arrives over MCP
cannot carry the flag at all; `defineTool()` preserves it, but only for a plugin's own tools. Every
literal `deferLoading: true` in the shipped bundle is either the projection code that derives
deferred declarations from tool history, the placeholder, or prose describing them — none is a tool
declaration.

So this is not a build that a plugin in this repository can perform. The largest recoverable piece
has no seam a plugin can reach, and if it did, the saving is under 1% of the window. If upstream ever
lets MCP definitions be declared deferred, re-run `node tools/tool-budget.mjs` first: the number, not
the feature, is what should reopen it.

## Item 14, measured then dropped

Same disposition as item 2, reached the same way. [R2](raw/06-safety-approvals.md) claims "a denial
costs one extra model turn *and* one prompt, per denial". One of those is countable, so it was
counted with `node tools/escalation-census.mjs` before anything was finished:

```
sessions            75
tool calls          18660
sandbox denials     1   in 1 session(s)
  re-issued         1   a later same-tool call asked to widen
  turns to re-issue {"0":1}
escalation asks     172 with no denial recorded before them
```

**The turn is not there.** Across 18,660 tool calls there is exactly one denial, and it cost no
extra turn: it was answered in the same turn, one step later. The runtime had already told the model
what to do — the denied result carries `[sandbox: escalation available — retry this exact command
once with sandbox_permissions ...]` — so the recovery is guided rather than guessed.

Two further findings close the implementation rather than the idea:

- **The trigger is wrong even if the feature were wanted.** Of the 173 escalation asks, 11 followed
  a raw `EPERM: operation not permitted` from the sandbox and only 1 followed the
  `[sandbox: file access denied under <mode> mode]` marker a plugin can detect. Keying on the marker
  finds roughly one refusal in twelve.
- **The seam is off-contract.** `tools/execute` is the only re-callable wrapper point, but its
  README states that wrappers "may replace only the operational signal", and `ToolDispatchExecution`
  leaves `arguments` readonly. A retry with different arguments is not something a plugin is offered.

What the same run does surface is worth more than the item: **172 of 173 escalation asks had no
denial before them.** The models asked to widen the sandbox pre-emptively, all of them to
`danger-full-access` and never to the narrow rung (148 `bash`, 24 `edit`, 1 `write`), because the
work genuinely needed to leave the workspace. The recurring cost here is approval friction on work
that leaves the workspace — not recovery from a refusal. `dsh-approval-memory`'s session grant
already absorbs the `bash` half; the 25 `edit`/`write` asks are uncovered.

## The part that matters more than the list

Feature parity is the wrong target. Codex is not reliable because it has 22 features. It is reliable
because a mistake becomes **visible to the agent** while the agent can still fix it.

Walk through how an agent actually fails:

| Failure | What would catch it | Codex | DSH today |
|---|---|---|---|
| Breaks a type or a test | Running the check and reporting it back | No | Built: `dsh-verify-on-edit`, mounted |
| Edit lands somewhere unexpected | Showing the diff in the tool result | Partly (patch echo) | Built: `dsh-edit-feedback`, mounted |
| Forgets the task list mid-session | Re-injecting state after compaction | Partly | Built: `dsh-compaction-todo`, delivered 13x in `session-ee71145b` |
| Stops half-done | Prompt persistence | Yes | **Prompt only** |
| Hallucinates an API | Reading the real source first | Prompt | Prompt only |
| Over-claims success | Prompt discipline | Yes | **Prompt only** |

The first three rows are mechanical. They do not depend on the model behaving well. They are also
exactly the rows behind "misses things" and "makes bugs instead of clean fixes". All three are
built and mounted as of 2026-10-02, with `include:compaction-todo` and the two compaction rows
`active` in the live tree. The third has since fired for real: `/compact` in `session-ee71145b` put
`compaction/start` at seq 191 and `compaction/end` at seq 195, and the list came back as 13
reminders from seq 202 to 289, each a `user/message` carrying `source.kind: compaction-todo`,
stopping at the next `todo/write` at seq 292. Delivery is settled by that; effect is not. "Built" is
not "effective" — the undo-class rate has not been shown to fall, and the post-install corpus is
still uneven: one session holds 30.1% of its events, down from 65.8% but not spread.

Note the fourth column carefully. Three rows say *prompt only*. That means I have so far answered a
reliability problem with encouragement. Prompt text is the weakest available lever: it raises the
odds the model does the right thing, and does nothing when it does not.

## What I should have done first

Define the failure, then count it.

A usable definition: in a recording of a real session, a **mistake** is a tool call or turn whose
output the agent had to undo, redo, or correct within the same session. Edits reverted. Tests run
twice because the first attempt broke something. Files re-read because an edit went somewhere else.
Those are countable from a session transcript, which is already on disk.

I have not counted any of that. So the claim "DSH is better now" is unfounded, and the claim "DSH is
still worse than Codex at coding" is equally unfounded. Both are guesses.

## Plan, in order

1. **A verification loop.** Built: `packages/dsh-verify-on-edit`, live in the desktop profile. It
   hooks `tools/post-execute`, notices when an edit breaks a check, and reports only errors the
   agent's own edit introduced. Four firings recorded across the session corpus.
2. **Edit feedback.** Built: `packages/dsh-edit-feedback`, live in the desktop profile. The `edit`
   result now carries the diff the UI already had.
3. **Task state that survives compaction.** Built and mounted: `packages/dsh-compaction-todo`,
   17 unit tests, `fiberPhase: active`. `compaction/end` turns out to be a durable session event
   rather than a Cordis event, so the plugin reads the log at `agent/pre-step` instead of listening
   for it. `include:compaction-basic` and `include:command-compact` were enabled so compaction can
   happen at all, and the first real firing delivered 13 reminders; the full record is in
   [`packages/dsh-compaction-todo/README.md`](../packages/dsh-compaction-todo/README.md). What that
   settles is delivery, which was the assumption the plugin was written to avoid depending on.
   Whether re-injecting the list changes what the agent does is still unmeasured.
4. **Then measure.** The instrument now exists and the first reading from it is not the reading the
   hand split produced. `tools/session-audit.mjs` gained `--since` and always reports the
   per-session distribution, with 15 tests over both. Split at the reliability pack's install time
   it reports a pooled rate of **1.6 per 100** — below the 3.5 baseline, where the hand split had
   2.5 and rising — while **one session holds 65.8% of the events**. So the post-install corpus is
   quiet and dominated by a single session at the same time, and neither "DSH is better now" nor
   "DSH is still worse than Codex" follows from it. See [`tools/README.md`](../tools/README.md) for
   the split, and the usage block at the top of `tools/session-audit.mjs` for the flags.

Steps 1 through 3 are all plugin-reachable. Step 1 uses `PostToolDecision`, which can replace the
result content and attach context for the next request.
