# How close are we? A scorecard against the original ask

The ask: **take the best of Codex into DSH so DSH becomes better at coding.** The stated pain is
concrete: the agent misses things, and produces bugs where it should produce clean fixes.

Short answer: **not close, and skewed toward the easy half.** Roughly 5 of 22 identified Codex
advantages are addressed, and the ones left are the mechanical ones that actually cause the
mistakes.

Worse, and worth saying plainly: **nothing built so far has been measured.** I shipped prompt text
and an editing tool and wrote a lot of analysis. There is no evidence any of it reduces mistakes,
because I never defined what a mistake looks like or counted one.

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
| Breaks a type or a test | Running the check and reporting it back | No | **No** |
| Edit lands somewhere unexpected | Showing the diff in the tool result | Partly (patch echo) | **No** |
| Forgets the task list mid-session | Re-injecting state after compaction | Partly | **No** |
| Stops half-done | Prompt persistence | Yes | **Prompt only** |
| Hallucinates an API | Reading the real source first | Prompt | Prompt only |
| Over-claims success | Prompt discipline | Yes | **Prompt only** |

The first three rows are mechanical. They do not depend on the model behaving well. They are also
exactly the rows behind "misses things" and "makes bugs instead of clean fixes". None of them are
built.

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

1. **A verification loop.** Hook `tools/post-execute`, notice when an edit breaks a check, and report
   it while the agent still has the file open. Report only errors the agent's own edit introduced, so
   pre-existing breakage does not send it off fixing unrelated things. This attacks rows 1 and 3
   directly and is the single largest lever available.
2. **Edit feedback.** A post-execute hook can replace the result the model reads. The `edit` tool
   currently says "updated successfully" and nothing else, with the computed diff going to the UI
   only. The model cannot see where its edit landed.
3. **Task state that survives compaction.** Compaction drops the todo list, and there is no read-back
   tool, so the agent loses its plan mid-session. That is "misses things" by construction.
4. **Then measure.** Count the three undo-class events in a before/after session pair. Until that
   number exists, everything above is opinion.

Steps 1 through 3 are all plugin-reachable. Step 1 uses `PostToolDecision`, which can replace the
result content and attach context for the next request.
