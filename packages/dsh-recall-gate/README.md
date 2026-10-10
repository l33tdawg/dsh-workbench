# @l33tdawg/dsh-recall-gate

Refuse the first file-mutating tool call of a turn until that turn has recalled its memory.

The plugin is a `tools/pre-execute` policy. A write in a turn whose recall has not completed is
denied with a reason naming the recall tool, and the model retries the call after recalling.

## Why it exists

Reported from a session that edited a `git worktree` five times before calling `sage_turn`. The
recall that ran at the end of that turn returned a committed memory recording that a **different
concurrent session owned source edits to that exact worktree**, and that the branch had been
superseded. Nothing was clobbered only because the tree happened to be clean.

That is the one failure mode here with a destructive outcome, and it is not detectable from the
pending call: nothing about `edit src/app.py` says a memory names that tree. The only available
signal is ordering, and until this plugin existed nothing enforced it. `sage_turn` was instructed
every turn; instructions are not a gate.

## Install

Install the package as a DSH bundle.

```yaml
- insert:
    - id: recall-gate
      name: '@l33tdawg/dsh-recall-gate'
      config:
        enabled: true
        recallTools: [sage_turn]
        writeTools: [edit, write, apply_patch, str_replace_editor]
```

Requires no services. A profile that mounts no memory tool should leave `enabled: false`, because
the gate would otherwise refuse every write with no way to open it.

## What it gates

| Call | Gated |
| --- | --- |
| `edit`, `write`, `apply_patch` | yes |
| `str_replace_editor` with `create`, `str_replace`, or `insert` | yes |
| `str_replace_editor` with `view` or `undo_edit` | no |
| `read`, `grep`, `glob`, `bash`, and every other tool | no |
| `mcp__fs__apply_patch` | yes, on the `apply_patch` segment |

A tool name is matched whole or by any `__`-separated segment, so the default works for a native
tool (`sage_turn`), an MCP-imported one (`mcp__sage__sage_turn`), and one inside a namespace of its
own (`mcp__fs__apply_patch`).

## What opens it

A **completed, non-error** recall in the current turn. Specifically:

- The turn boundary is the newest `turn/start` event, so a recall in an earlier turn does not
  license writes in this one. The relevant memory is the one that exists now.
- The recall call must have a matching result. An attempt still in flight reads nothing.
- That result must not be an error, however the log records the id: `message.toolCallId` first,
  `callId` second, since the durable format writes one or the other.
- A call with no id can never be paired with a result, so it cannot satisfy the gate.

## Design notes

**Why `tools/pre-execute`.** It is the only seam that can stop a call. `PreToolDecision` offers
`allow`, `deny`, `cancel`, and `ask`, while input rewriting is deliberately excluded there because
arguments are already logged and presented. `tools/execute` is not a substitute: a wrapper there
may change only `exec.signal`, and `ToolExecution.arguments` is readonly. A gate that cannot deny
is not a gate, which is why this is a pre-execute policy rather than a notice appended to the
result.

**Why a deny rather than a warning.** Attaching a warning to an allowed edit does not close the
reported failure mode: the destructive write still happens. The cost is one round-trip on a turn
whose first action is an edit.

**An unreadable log denies.** If the session log cannot be read, the turn is treated as
unrecollected. That is the conservative direction: allowing a mutation on no evidence is the
outcome this plugin exists to prevent.

**A refusal already reached stands.** The listener calls `next()` first and returns without
changing anything unless the pipeline reached `allow`. A sandbox denial or an approval that never
came is not softened into a permit.

## Configuration

| Field | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Install the pre-execute policy. |
| `recallTools` | `[sage_turn]` | Tool names that satisfy the gate for the turn. |
| `writeTools` | `[edit, write, apply_patch, str_replace_editor]` | Tool names that trigger it. |

An empty list is rejected rather than defaulted: `recallTools: []` would deny every write forever
and `writeTools: []` would never deny anything, and both are more likely a profile mistake than an
intention.

## Tests

```sh
npm test
```

Tests drive the real hook through a session-shaped durable log: the first write of a turn denied, a
completed recall opening it, the gate closing again on the next turn, a failed or in-flight recall
not counting, a recall in a previous turn not counting, reads never gated, the mutating
`str_replace_editor` commands split from its read-only ones, and the pipeline's own denial left
alone. Neither an LLM request nor a live restart is required.
