# `@l33tdawg/dsh-compaction-todo`

Put the todo list back into the model's context after a compaction.

## What breaks

`todo_write` keeps its list in the durable session log: the tool appends
`todo/write` and registers a `todos` session projection, so the plan survives on
disk. Compaction then replaces the model's context window with a summary, and the
summary does not carry the list. The tool result the model was working from is
gone, no read-back tool exists, and the agent continues without its plan. That is
"the agent misses things" by construction rather than by model failure, and it is
the last unbuilt item of the four in [`research/SCORECARD.md`](../../research/SCORECARD.md).

## What this does

Two listeners, no new tool:

- `session/event` mirrors the newest `todo/write` per session. A todo list is one
  record whose later writes replace earlier ones, so the newest write is the
  whole list.
- `agent/pre-step` notices when the newest `compaction/end` is newer than the
  newest `todo/write`, and appends a `<system-reminder>` carrying the list.

The log is the authority, not plugin memory. The mirror is only a cache, so a
write this process missed cannot make the injection wrong: the next step re-reads
the log. The reminder repeats on each step until the agent writes again, because
whether a message contributed at `agent/pre-step` is durable or single-step is not
documented, and a reminder that survives one step is close to useless.

Four properties keep it honest:

- **It never invents a plan.** The list is replayed verbatim from the newest
  `todo/write`, or nothing is injected.
- **The newest write wins, including an empty one.** An agent that clears its
  list has finished; reminding it about nothing is noise.
- **A compaction older than the newest write is not a reason to remind.** The
  agent has written its plan since, so that plan is already in context.
- **Todo text cannot forge the frame.** `<` and `>` are escaped, so a todo
  containing `</system-reminder>` cannot close the block early.

## Install

```sh
# from a session with Full access, or with approval
plugin_manager install_bundle /absolute/path/to/packages/dsh-compaction-todo
```

Or add the row by hand in a profile patch layer:

```yaml
- insert:
    - id: compaction-todo
      name: '@l33tdawg/dsh-compaction-todo'
      config: {}
```

## Verification

```
node --test --experimental-strip-types --test-force-exit "tests/*.test.ts"
```

17 tests over the log-reading half: which write wins, what an unreadable record
does, when a reminder is owed, and how the list renders. Two of them exist
because the first draft failed them: a todo carrying `</system-reminder>` could
close the frame, and ordinary text containing `<` was being left unescaped.

Not verified here, and the distinction matters:

- **The reminder has never been delivered by a running DSH.** The listener
  imports the harness's message constructor, which resolves only inside an
  installation, so the delivery half is not covered by these tests. What has
  been confirmed live is the mount: `include:compaction-todo` is
  `enabled: true`, `fiberPhase: active`, with the package symlinked from this
  directory.
- **The first live run needs a compaction.** The profile now has
  `include:compaction-basic` and `include:command-compact` enabled and the
  `compaction` Host Service resolving, so `/compact` in a session is the
  trigger. The check is: hold a todo list, compact, and confirm the reminder
  arrives carrying the same items. If it does not, the next check is whether
  `agent/pre-step` messages contributed by a plugin reach the model at all —
  the one assumption this plugin was written to avoid depending on.
- **A firing leaves a log line, not a visible marker.** When the reminder is
  injected the plugin logs `compaction-todo: re-injected N todo(s) after
  compaction at seq X`. That records the decision, not delivery: it proves the
  listener saw a compaction past the newest write, not that the model read the
  text.
