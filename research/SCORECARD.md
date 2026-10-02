# How close are we? A scorecard against the original ask

The ask: **take the best of Codex into DSH so DSH becomes better at coding.** The stated pain is
concrete: the agent misses things, and produces bugs where it should produce clean fixes.

Short answer: **not close, and skewed toward the easy half.** Roughly 5 of 22 identified Codex
advantages are addressed, and the ones left are the mechanical ones that actually cause the
mistakes.

Worse, and worth saying plainly: **nothing built so far has been shown to reduce mistakes.** A
mistake is now defined and counted, and the count has not moved in the direction the work predicted;
see [Re-measured](../tools/README.md). The three mechanical items below were built after this page
was written, so the rows that said "No" now describe a plugin that is mounted and running in the
desktop profile rather than nothing at all. What is still missing is the comparison that would let
anyone say whether they help.

---

## What Codex is actually better at, and where each stands

| # | Codex advantage | Status |
|---|---|---|
| 1 | Engineered behavioural prompt (~7.6k tokens) | **Partial.** Guidance pack adds 1.76k tokens. |
| 2 | Deferred tool loading + `tool_search` | Not addressed. |
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
| 13 | Approval memory (prefix grants) | Not addressed. |
| 14 | Same-turn escalation retry | Not addressed. |
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

## The part that matters more than the list

Feature parity is the wrong target. Codex is not reliable because it has 22 features. It is reliable
because a mistake becomes **visible to the agent** while the agent can still fix it.

Walk through how an agent actually fails:

| Failure | What would catch it | Codex | DSH today |
|---|---|---|---|
| Breaks a type or a test | Running the check and reporting it back | No | Built: `dsh-verify-on-edit`, mounted |
| Edit lands somewhere unexpected | Showing the diff in the tool result | Partly (patch echo) | Built: `dsh-edit-feedback`, mounted |
| Forgets the task list mid-session | Re-injecting state after compaction | Partly | Built and mounted: `dsh-compaction-todo`, untriggered |
| Stops half-done | Prompt persistence | Yes | **Prompt only** |
| Hallucinates an API | Reading the real source first | Prompt | Prompt only |
| Over-claims success | Prompt discipline | Yes | **Prompt only** |

The first three rows are mechanical. They do not depend on the model behaving well. They are also
exactly the rows behind "misses things" and "makes bugs instead of clean fixes". All three are
built and mounted as of 2026-10-02, with `include:compaction-todo` and the two compaction rows
`active` in the live tree. The third is the one to be sceptical about: it has never been triggered,
because until today nothing in this profile could compact. "Built" is not "effective" — the
undo-class rate has not been shown to fall, and a single session holds most of the post-install
events.

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
   for it. Its effect is still unmeasured, and now testable: `include:compaction-basic` and
   `include:command-compact` were enabled so compaction can happen at all, which means `/compact`
   is the trigger and the first real firing is the experiment. One reminder has never been
   delivered.
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
