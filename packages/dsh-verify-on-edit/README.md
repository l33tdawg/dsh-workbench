# @l33tdawg/dsh-verify-on-edit

Run a project check after an edit and keep the final edit from escaping verification.

The plugin observes successful `edit`, `write`, `apply_patch`, and mutating
`str_replace_editor` commands (`create`, `str_replace`, `insert`). Editor views
remain read-only. It remembers every changed path even when it delays a
check during a burst of edits. Before a normal turn ends, it checks any edits still
outstanding. Successful checks, failures, timeouts, and unavailable checks each leave
a distinct notice in the model context.

## Install

Install the package as a DSH bundle, or use `@l33tdawg/dsh-uplift`.

```yaml
- insert:
    - id: verify-on-edit
      name: '@l33tdawg/dsh-verify-on-edit'
      config:
        enabled: true
        timeoutMs: 60000
        debounceMs: 3000
        allowSlow: false
        blocking: false
        maxPerFile: 5
```

The plugin requires `tools` and `shell`. Checks use the current session workspace,
resolved session sandbox policy, cancellation signal, and shell executor. They do
not request wider permissions. A confined executor without a session policy is
reported as unavailable. Older executors that discard the requested policy,
cancellation, deadline, or output bound are also refused before execution.

## Choose the check

A profile can specify the project's command explicitly:

```yaml
- id: verify-on-edit
  config:
    command: 'pnpm --filter web typecheck'
    label: 'web typecheck'
```

Without `command`, detection checks the workspace root for an npm `typecheck`,
`check:types`, or `lint` script, followed by TypeScript, Cargo, Go, and Python config
markers. A `test` script is eligible only with `allowSlow: true`. Detection runs again
on each check attempt, so editing the project configuration cannot leave a cached
command active forever. Detection is a convenience; use an explicit command when the
repository's actual verification differs.

## What the model receives

Each attempted check has a bounded outcome notice. Its source is
`kind: verify-on-edit`, with a stable `summary: "verify-on-edit: <status>"`.

| Status | Meaning |
| --- | --- |
| `passed` | The configured or detected command exited zero. |
| `failed` | The command failed and reported recognized diagnostic locations. |
| `unparsed` | The command did not pass, but no recognized error locations were found; bounded output is included. |
| `timed-out` | The shell's deadline stopped the check. |
| `unavailable` | The checker, shell, workspace, or session policy prevented completion. |
| `no-check` | No command was configured or detected. |

An explicit current-turn user request to skip tests or checks prevents automatic
execution after edits as well as at completion. The skipped notice states that
verification is unavailable at the user's request; edited paths remain outstanding
if the user later explicitly requests checks. Queued checks re-read that restriction
before starting.

Cancellation stops the check and keeps verification outstanding; it does not inject
a failure notice or request more work after the user has stopped the turn.

Errors in files the agent edited are listed first. Errors in untouched consumers
remain visible because an edited interface can break them. **There is no pre-edit
baseline:** reports explicitly avoid claiming that a failure was introduced by the
edit, or that untouched-file failures are pre-existing. The agent must investigate
relevance without expanding the task into unrelated repairs.

Reports cap diagnostics per file, show at most eight files, and cap the notice at
about 4 KB. Unparsed output has a smaller excerpt. `blocking: false` leaves the edit
successful and adds context; `blocking: true` blocks on failed or unparsed checks.

## Finishing a turn

The completion guard flushes pending edits at a normal completion boundary. It can
request **one corrective continuation per turn** when verification is unresolved or
that turn's todo list still has pending work. A repeated stop checks new edits but
cannot request another continuation. It respects cancellation, explicit stop/pause or
report-only instructions, approval boundaries, and abnormal turn endings. A reported
blocker or verification gap ends the turn without an automatic retry.

The guard writes a supported `user/message` notice for a newly flushed result. Its
one-continuation marker survives a plugin reload in the session log. After a plugin reload, the checker reconstructs successful file-tool edits from the
current turn's ordinary tool call/result records and conservatively checks them
again. Both Session log access APIs are supported. Shell/script edits outside the
observed file tools remain outside this verification ledger. A successful checker exit also cannot establish correctness
beyond what that command tests.

## Configuration

| Field | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Install the verification and completion hooks. |
| `command` | unset | Explicit project verification command. |
| `label` | `project check` | Name used with an explicit command. |
| `timeoutMs` | `60000` | Shell deadline; expiry kills the check. |
| `debounceMs` | `3000` | Minimum interval between edit-triggered checks; final pending edits still flush at completion. |
| `allowSlow` | `false` | Allow detection to select an npm test script. |
| `blocking` | `false` | Block on failed or unparsed checks instead of adding advisory context. |
| `maxPerFile` | `5` | Maximum diagnostics displayed for one file. |

## Tests

```sh
npm test
```

Tests drive the real plugin hooks with a controlled shell and session-shaped durable
log, including a debounced last edit, a later edit to a different file, untouched
consumers, unparsed failures, cancellation, policy propagation, and the bounded
completion guard. They do not require an LLM request or a live desktop restart.

The plugin never creates custom session event types. An earlier attempt to append
`verify-on-edit/check` events produced logs the host refused to reopen; outcome
notices now use the host's existing message vocabulary.
