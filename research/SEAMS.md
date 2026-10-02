# Every heuristic is a missing seam

The observation was that a misfiring heuristic is a sign something underneath is wrong. That is
right, and it is worth being precise about *what* is wrong, because the six heuristics I wrote split
into two very different categories. Two of them were my failure to read the API I was already
holding. Three point at genuine gaps in DSH. One is unsolved everywhere.

Getting that split right matters. If everything is "DSH is broken", the fix is a fork and a rewrite.
If half of it is "the seam exists and nobody finds it", the fix is much cheaper, and a fork would
have reproduced the same problem.

---

## The six, classified

| Heuristic | Why it existed | Verdict |
|---|---|---|
| Regex-parsing patch text for file paths | To learn which files a patch touched | **My failure.** `result.value` has it structured. Fixed. |
| Keying session state on agent object identity | To keep per-session state | **My failure.** `agent.session.id` is a stable branded id. |
| Regex-parsing compiler output | To learn what broke | **Real gap.** No structured diagnostics channel exists. |
| Guessing the project's check command | To know how to verify | **Real gap,** and unsolved in Codex too. |
| Wall-clock debounce | To avoid re-checking constantly | **Real gap.** No mid-turn "what changed" query. |
| Suffix-matching paths across two sources | To connect a checker's path to an edit's path | **Real gap,** partial. Canonical identity exists but is not shared. |

---

## The two that were mine

`ToolExecutionResult` carries `value: JsonValue`, documented as the "execution-local canonical
value" (`packages/core/tools/src/index.ts:575`). The `edit` tool's value is
`{ path, before, after }` (`packages/fs/tool-fs/src/edit.ts:99-101`). My `apply_patch` reports
`{ files: [{ path, target }] }`.

So the tool that made the change already knows exactly which files it touched, and reports it in a
typed shape. I wrote a regular expression over patch text instead, and then had to defend against
URLs and paths containing colons and section headers with trailing whitespace. All of that
complexity existed because I did not read the result type.

This is now fixed, and it made the code smaller. The argument-scraping path survives only as a
fallback for a tool that reports no structured value, and there is a test asserting the structured
value wins when both are present.

The identity one is weaker, and it is worth not overstating. `SessionId` is a branded type on
`session.id` (`packages/core/session/src/types.ts:101`). I keyed a `WeakMap` on the agent object
instead. That is not wrong, and it is what `repeat-tool-reminder` does, so it is the established
idiom: the agent instance is stable for the life of a session, and a `WeakMap` releases the state
without an explicit cleanup path.

What it cost me was a silent failure instead of a loud one. My test built a fresh agent object per
call, so every call looked like a new session, the debounce never engaged, and the test failed three
times before I worked out that the plugin was right and the fixture was wrong. Keyed on
`session.id`, that mistake is not available: the id is visible in the test, so a wrong one is a wrong
one, not an identity nobody can inspect.

Weak complaint, then. Worth noting only because it is the kind of thing that makes a plugin author
distrust their own code instead of their fixture.

---

## The three real gaps

### 1. There is no structured diagnostics channel

This is the big one, and it is the reason the plugin has a parser at all.

DSH ships a real LSP client. It speaks four navigation operations, and it throws away the channel
that carries diagnostics. From `packages/lsp/lsp-stdio/src/connection.ts:248`:

```
// A server→client notification (e.g. diagnostics, logs): ignored by this MVP host.
return
```

Any server-to-client notification is dropped, and `textDocument/publishDiagnostics` is a
notification. The package README names the exclusion twice and defers it: diagnostics "need separate
freshness and accumulation rules".

So a harness that can ask a language server for a definition cannot ask it what is broken. Every
verification attempt therefore has to spawn a compiler and parse human-readable text, which is
inherently fragile: formats drift, severities move, and continuation lines look exactly like
diagnostics. My parser handles four output shapes and will break on the fifth.

The substrate to fix this is already in place. `tools/post-execute` can inject context, queries are
already being made to the server, and the only missing pieces are the freshness and accumulation
semantics the README says are undecided.

### 2. Nothing knows how to verify a project

Neither harness has a concept of "the command that tells you this project is still correct". Codex's
prompt says to consider running tests. DSH says nothing at all. So both push the decision onto the
model, which means it happens when the model remembers.

My plugin guesses from six markers in a fixed order. That is a reasonable guess and it is still a
guess. A repository has a better answer available: its own `AGENTS.md` already tells agents how to
build and test. DSH reads that file (`packages/context/agent-instructions`) and injects it as text,
then declines to act on it. A declared check target in the project config would turn all of this into
a lookup.

### 3. There is no mid-turn query for what changed

I reached for `Date.now()` because there was nothing better. There is a `ctx.workspaceChanges`
service that knows precisely which files a turn changed, with line counts, from git snapshots plus
whole-file captures around file-tool edits. It is the right source and it cannot answer my question.

It records at turn granularity. `ctx.workspaceChanges.summary(sessionId, seq)` returns the summary
"announced by one `workspace/changes` event" (`recorder.ts:206`), and that event is appended when the
turn's record is finalized (`recorder.ts:354`). A check running *during* a turn has no summary to
read, so the only options are to watch tool arguments as they go by, or to poll with a timer.

Worse, the summary omits shell edits by design, so even a turn-end check built on it would miss
changes made through `bash`. The change-tracking layer is the natural home for this and it does not
expose a live view.

---

## Which seams persist what

Measured 2026-10-02, because plugins here depend on the answer and one of them was written
specifically to avoid needing it.

| Seam | Does a plugin's contribution reach the durable log? |
|---|---|
| `agent/pre-step` | **Yes.** A contributed message is appended as a `user/message` carrying the plugin's own `source.kind`. |
| `tools/post-execute` | **Yes.** A replaced `content` is the value that gets appended as the `tool/result`. |
| `tools/post-execute` + `additionalContexts` | **Yes, by a third path.** Spliced into the inbox as `agent/inbox/spliced` (`target: "next-step"`) and landed as a durable `user/message`. |
| `agent/post-step` | **Does not exist.** |

`agent/pre-step` messages are admitted as the user-message batch the loop appends on the first
attempt, which is why they survive a resume or a fork instead of living for one step. Measured in
`session-ee71145b`: a compaction at seq 195, then 13 steps before the next `todo_write` and exactly
13 reminder records at seq 202–289, one per step. The `todo_write` at seq 292 moved the list and 23
further steps ran with no reminder at all.

`tools/post-execute` is the same story one layer down: `postExecute` runs before
`finishScheduledExecution` returns the authoritative result, and that value is what
`appendToolResult` writes to the log (`dsh-tools/lib/index.js:3368`,
`dsh-agent-loop/lib/index.js:697`). The `edit` tool's own output is a single sentence —
`formatEditOutput` returns nothing else (`dsh-tool-fs/lib/index.js:660`) — and the durable record for
an `edit` in that same session carries that sentence *plus* a unified-diff block that only
`edit-feedback` produces. The diff is in the log, not merely on screen.

Attached context takes a third route again: `additionalContexts` on a post-execute decision are
spliced into the agent's inbox and land as a durable `user/message`. That is how `verify-on-edit`'s
report reaches the model, and both of its corpus firings are in the log that way.

The absent one is the useful negative. There is no `agent/post-step` to hook anywhere: zero
occurrences of `post-step` under any spelling or case across the installed `@deepseek-ai/dsh` tree
(288 packages) and inside the 116 MB Electron `app.asar`, against positive controls that find
`pre-step` in 75 files and `tools/post-execute` in 28, and 153 and 50 occurrences in the bundle.
Anyone reaching for an "after the step" seam wants `tools/post-execute` for tool results, or
`step/end` as a log event, not an agent hook.

---

## What this means for the fork question

The pattern in the three real gaps is the same, and it is not "DSH is broken". It is that **the seams
exist and stop one step short of useful**:

- The LSP client connects and discards the answer.
- The instruction file is read and not acted on.
- The change tracker knows everything and only reports at the end.

Those are finish-the-job problems, not architecture problems. A fork would inherit all three, because
they sit in the same interfaces a fork would keep, and the fork would then own them.

The other signal is that two of my six were self-inflicted. That says the API surface is larger and
better than a plugin author discovers by reading around. `result.value` is the canonical result and
it took me a full implementation to find it. That is a documentation and discoverability problem, and DSH
already generates a tool catalog (`docs/tool-catalog.md`), so the material exists.

## Recommended order

1. **Diagnostics through the existing LSP client.** Highest value by a distance, because it removes
   the fragile parsing every verification plugin currently needs, and the client is already talking
   to the server. The open question is the one the README names: when a diagnostic is fresh, and how
   they accumulate.
2. **A declared check target.** Cheapest of the three. A project says how to check itself, once, and
   every plugin stops guessing.
3. **A live change query.** Have `ctx.workspaceChanges` answer "what has changed since sequence N"
   during a turn, including shell edits. That turns my timer into a fact and fixes attribution for
   bash-driven changes.

Until 1 lands, the parser stays, and the honest framing is that it is a workaround with a known
expiry date, not a design.
