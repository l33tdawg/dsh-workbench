# `@l33tdawg/dsh-compaction-todo`

Recover recorded task state after compaction, once per boundary. Version 0.2.0
uses the delivered message in the session log to avoid repeated reminders after
reload, resume, or fork.

## What it does

Before the next model step, the plugin reads the newest `todo/write` and
`compaction/end`. If compaction removed a nonempty list from context, it returns
a reminder through the supported `agent/pre-step` message hook. The harness
persists that message as an ordinary `user/message`.

The reminder records its compaction boundary and the revisions it delivered in
`source.continuity`. The next step checks that receipt and stays quiet. A later
compaction makes the state eligible again. A newer todo write supersedes the
old one; an empty write clears it. Failed or cancelled compaction attempts are
not new boundaries. Delivery is not marked in process memory, so
an interrupted contribution that never reached the log can be retried.

The log is authoritative. Both the `eventAt(index)` session API and the installed
`events` snapshot API are supported. No custom session event type is written.

## Optional workflow context

The standalone default remains todo-only. Set `workflowContext: true` to expose
`workflow_context` and recover an existing goal's recorded objective and phase.
The plugin does not create, resume, or complete goals.

```yaml
- id: compaction-todo
  config:
    workflowContext: true
```

`workflow_context` replaces a small explicit snapshot:

```json
{
  "objective": "Repair the parser without changing its public API",
  "constraints": ["Preserve existing input compatibility"],
  "decisions": ["Extend the existing parser"],
  "remainingVerification": ["Run parser regressions"]
}
```

All four fields are required. The objective is at most 1,000 characters; each
list holds at most eight entries of at most 400 characters each. The full
snapshot must fit within 6,000 JSON characters. An empty objective and three empty
lists clear the snapshot. Invalid or failed calls leave the last successful
snapshot intact.

The snapshot is model-authored working context. It is never treated as a human
instruction, approval, or verified fact. Recalled text states this explicitly,
uses `form: recall`, and remains subordinate to current instructions. There is
no parsing of free-form conversation to guess constraints, decisions, or goals.
The existing goal record remains a separate source, including paused, blocked,
and complete phases.

The tool's normal result carries the snapshot both as JSON text and as supported
`tool/result.meta`. Replay requires a successful canonical result, matching
rendered content, and its earlier `workflow_context` call with matching
arguments. A user message quoting a checkpoint, unrelated tool metadata, or a
failed call does not count. Both the Desktop's flat tool-result message and the
installed library's nested `tool-result` content block are recognized, with the
same success, call identity, metadata, and exact-text checks.

## Delivery and limits

Every reminder is a known `user/message` with:

```json
{
  "kind": "compaction-todo",
  "form": "recall",
  "continuity": {
    "version": 1,
    "compactedAt": 195,
    "todoRevision": 142,
    "workflowRevision": null,
    "goalRevision": null
  }
}
```

Revision values are event sequence numbers; `null` means that source was not
included. Only delivered parts are acknowledged. Legacy reminders with the old
source kind are recognized by their position after the boundary, so upgrading
an existing session does not repeat an already-delivered todo reminder.

Todo recalls include at most 32 entries and 400 characters per entry, and goal
objectives at most 1,000 characters. The complete rendered recall is capped at
12,000 characters after escaping. Truncation is stated, and the durable records
retain the full state. This is a compact recovery aid, not a second transcript.

## Install

Install this package as a normal DSH bundle. Its row is independently configurable:

```yaml
- insert:
    - id: compaction-todo
      name: '@l33tdawg/dsh-compaction-todo'
      config: {}
```

The uplift bundle can enable the optional workflow tool on the same row. Avoid
inserting a second row for a package already mounted by the bundle.

## Verification

```sh
npm test
```

Tests exercise log selection plus the actual Cordis loader, tool registry,
immutable message constructors, session writer, and seeded session replay.
Both root development dependencies and the installed `dsh-base` dependency
family are exercised, covering their different session and message layouts.
They cover thirteen steps producing one reminder, another compaction producing
a second, reload/resume/fork, undelivered contributions, later and empty todo
writes, checkpoint replacement/clearing, bounds, malformed metadata, source
identity, and existing goal phases. All plugin output uses known event types.

The older implementation was observed delivering thirteen durable reminders
between one compaction and the next todo update in a live session on 2026-10-02.
That observation established that pre-step messages survive on disk. Version
0.2.0 fixes the resulting repetition; its new behavior is integration-tested,
but has not yet been verified in a running desktop session.
