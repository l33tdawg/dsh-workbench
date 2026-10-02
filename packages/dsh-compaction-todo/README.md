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
the log. The reminder repeats on each step until the agent writes again. That
repeat began as a hedge: whether a message contributed at `agent/pre-step` is
durable or single-step was not documented, and a reminder that survives one step
is close to useless. The first live run settled it in favour of durability (see
[Verification](#verification)). The repeat is kept anyway, because it costs one
bounded block per step and leaves the plugin not depending on that finding.

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

The tests cover the log-reading half only. The listener imports the harness's
message constructor, which resolves only inside an installation, so delivery is
not reachable from a unit test.

## Delivery, measured

**The reminder has been delivered by a running DSH.** First live run
2026-10-02, in session `session-ee71145b`, on a `/compact` issued as
`cmd-9aa96fc7-1`. From the session log alone:

| record | seq |
| --- | --- |
| `compaction/start` | 191 |
| `compaction/summary` | 193 |
| `compaction/end` | 195 |
| newest `todo/write` (4 items) | 142 |
| `step/start`, the first after the compaction | 199 |
| durable reminder for that step | 202 |
| `step/start`, the next step | 212 |
| durable reminder for that step | 213 |

Each reminder is a `user/message` whose `data.source.kind` is `compaction-todo`
and whose `surfaceOp` is `append`, carrying text byte-identical to what
`renderReminder` produces.

The run then continued, and the repeat behaved as designed in both directions.
The compaction stayed at seq 195 while the newest write stayed at seq 142, so the
condition kept holding and **13 reminders were written, one per step, for the 13
steps between the compaction and the next write** (seq 202 through 289). A
`todo_write` at seq 292 then moved the list, and the reminders stopped: 23 further
steps ran in that session and not one carried a reminder, so no reminder has a
seq above 292. Re-injecting until the list moves is therefore the measured live
behaviour and not only a hedge — it repeats while the compaction is newer than the
list, and goes quiet the moment the list moves.

This also settles the assumption the plugin was written to avoid depending on:
**a message a plugin contributes at `agent/pre-step` is durable in the session
log**, not single-step. That is a property of the harness rather than of this
plugin, so it is worth knowing for any future injection at the same seam.

One earlier claim in this file was wrong and is withdrawn. A firing does not
leave "a log line, not a visible marker": the plugin does log
`compaction-todo: re-injected N todo(s) after compaction at seq X`, but host
logger output is not written anywhere a live session can be inspected for it —
there is no log file and no log record type in the session log containing it.
The trace that does exist is the durable message, which is stronger evidence
than the log line would have been: it proves delivery, not merely the decision.
