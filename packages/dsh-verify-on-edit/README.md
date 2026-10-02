# @l33tdawg/dsh-verify-on-edit

Run a project's own check after the agent edits a file, and tell it what the edit broke while the file is still open.

## Why

An agent that breaks a type and finds out twenty turns later has already built three more changes on top of it. Neither DSH nor Codex closes that loop today: both leave verification to the model's discretion, so it happens when the model remembers, and not otherwise.

This plugin makes it mechanical. The check runs because a file changed, not because the model decided to look.

## What it does

After a successful `edit`, `write`, `apply_patch`, or `str_replace_editor` call, it runs the project's own check and, if the check now fails on a file the agent touched, appends the failure to the next request:

```
[verify-on-edit] typecheck fails on 1 problem in a file you edited.

  src/app.ts:12  TS2322: Type 'string' is not assignable to type 'number'.

Fix these before moving on, or say why they are expected. Leave failures in files you have
not edited alone: they predate your change.
```

The edit still counts as a success. The check rides along as context for the next request.

## The three properties that keep it from becoming noise

**Attribution.** Only diagnostics naming a file this session edited are reported. A check that was already red for unrelated reasons stays out of the conversation. That filter is the point of the plugin: an agent handed a pre-existing compiler error will go and fix it, which is precisely what it was told not to do.

**Advisory by default.** Verification should not be an obstacle, so the default is a note, not a failure. Set `blocking: true` if you want a broken check to fail the edit that caused it; that suits a tight edit-and-check loop and fights a multi-file refactor, which is legitimately red between steps.

**Bounded.** One check per debounce window, a hard timeout, output capped per file, and anything thrown inside the plugin is swallowed and logged. A verification plugin must never be the reason a tool call fails, and there is a test that asserts exactly that.

## What it leaves in the log

Silence used to be this plugin's only record, and silence is ambiguous. It says nothing when the check passes, when no check was detected, and when the check could not run at all — so reading a session afterwards, "no problem was reported" could not be told apart from "this plugin never engaged here". A count of reports could not be turned into a rate, because there was no denominator.

Every check attempt now appends one bounded `verify-on-edit/check` session event:

```json
{ "outcome": "clean", "label": "typecheck", "reported": 0 }
```

| `outcome` | Meaning |
|---|---|
| `clean` | The check ran and passed. |
| `failed` | The check ran, failed, and named at least one edited file. |
| `unrelated` | The check ran and failed, but named only files this session did not edit. |
| `unparsed` | The check ran and failed, and printed nothing that parsed as a diagnostic. |
| `no-check` | No check could be detected for this project. |
| `unrunnable` | The check could not be started, or started and did not exit normally. |

Two of these exist to separate cases that were previously identical. `unparsed` matters because a check that fails and prints something this parser cannot read is not a passing check, and reporting it as one would recreate the ambiguity the record removes. `no-check` is what makes an inert plugin visible: a session whose only records are `no-check` is one where detection found nothing, which is a different problem from a session where every check passed.

The record is not the report. The report goes to the agent and exists only when there is something to report; the record goes to the session log and exists every time the plugin decided to check. It is bounded by the same gate as the check, so a read-only tool call writes nothing at all. Writing one is best-effort — a session that refuses the append must not fail the agent's tool call, and there is a test for exactly that.

Observed live on 2026-10-02 in `session-ee71145b`: the first successful edit after this code was committed produced

```json
{ "outcome": "clean", "label": "typecheck", "reported": 0 }
```

at seq 978, written between the `tool/call` that caused it and that call's `tool/result`. That is the whole change in one line: the session previously showed nothing at all at this point, and now it records that the check ran and passed.

## Configuration

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Register the hook at all. Disabled registers nothing. |
| `timeoutMs` | `number` | `60000` | Hard limit for one check. |
| `debounceMs` | `number` | `3000` | Minimum gap between checks. |
| `allowSlow` | `boolean` | `false` | Whether `npm test` may be selected. |
| `blocking` | `boolean` | `false` | Whether a broken check fails the edit. |
| `maxPerFile` | `number` | `5` | Diagnostics shown per file. |

## How it picks a command

It reads only what the project already declares, in this order:

1. `package.json` → `typecheck`, then `check:types`, then `lint`
2. `package.json` → `test`, only when `allowSlow` is on
3. `tsconfig.json` → `npx --no-install tsc --noEmit --pretty false`
4. `Cargo.toml` → `cargo check --message-format short --quiet`
5. `go.mod` → `go build ./...`
6. `pyproject.toml` or `ruff.toml` → `ruff check --output-format concise .`

A project that declares none of these gets no check. Inventing a command would produce failures the project never agreed to, and the agent would learn to ignore the signal.

## Output it can read

| Checker | Shape |
|---|---|
| tsc | `src/app.ts(12,5): error TS2322: ...` |
| cargo | `src/main.rs:12:5: error[E0308]: ...` |
| ruff, go | `app/handlers.py:41:9: F841 ...` |
| pyright | `src/util.py:8:1 - error: ...` |

Diagnostic codes are preserved, since `TS2322` and `E0308` are identifiers the agent can look up.

## Install

```json
{
  "dependencies": {
    "@l33tdawg/dsh-verify-on-edit": "link:/path/to/packages/dsh-verify-on-edit"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@l33tdawg/dsh-verify-on-edit"
      ]
    }
  }
}
```

The check runs through `ctx.shell`, so it inherits the session's sandbox and its timeout handling.

## Tests

```sh
npm test
```

105 tests. The parser cases come from the real checkers' output, not from imagination. The gate tests cover the debounce and the attribution filter, including the case that matters most: an error in a file the agent never touched must produce no message. `tests/hook.e2e.ts` drives the real plugin against the actual DSH packages with a fake shell, so the event name, the decision shape, the six outcomes, and the never-break-a-tool-call guarantee are all covered.

That file is named `.e2e.ts` rather than `.test.ts`, and until now the test glob only matched `tests/*.test.ts`, so none of it had ever run under `npm test` — it passed when run directly, which is how the gap stayed invisible. The script now matches both patterns.

## Known limitations

- **Detection uses local filesystem access**, not `ctx.fs`. That is fine for local sessions and wrong for a remote-backend session, where detection returns nothing and the plugin stays quiet instead of reporting against the wrong tree.
- **The check is per session, not per file.** Editing `a.ts` runs a project-wide typecheck. Incremental checking would be cheaper and is not attempted.
- **No baseline diff.** Attribution is by edited path, so a file the agent edited that was already broken will report its pre-existing errors. Recording a baseline before the first edit would fix that and is not done.
- **The record only exists when the gate opens.** A run debounced away, or a call to a tool that does not modify files, writes nothing. That is deliberate — the hook fires on every tool call and recording each one would fill the log — but it means a session with no records is still ambiguous between "nothing was edited" and "the plugin is not mounted". Only the presence of records proves engagement.
