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

Nothing. The plugin writes no session events, and that is a constraint rather than a design choice.

Between 2026-10-02 and 2026-10-03 this plugin appended one bounded `verify-on-edit/check` event per check attempt, carrying an outcome (`clean`, `failed`, `unrelated`, `unparsed`, `no-check`, `unrunnable`) so that its silence afterwards could be read as a result instead of a gap. It worked at write time and broke the sessions at read time: the persistence read path refuses any session containing an event type outside the harness's own vocabulary unless the record carries the envelope's `ignorable` marker, and `Session.append()` takes only `type` and `data`, so a plugin has no way to set it. Nine sessions across four projects stopped loading with

```
contains event type "verify-on-edit/check" (seq 7764) unknown to this harness and
not marked ignorable; refusing to interpret the log
```

There is no supported way out from the plugin side. `@deepseek-ai/dsh-session`'s public `append` compiles a plugin-defined event type (the type map is merge-extensible) but the runtime read path validates against a fixed vocabulary and names plugin registration as deferred work. So the record was removed, and the outcomes went with it; `tests/hook.e2e.ts` now asserts the plugin neither appends nor names an event type.

The consequence to know about: a session where every check passed and a session where no check was ever detected still look identical in the log. The message the agent receives remains the only signal, and it exists only when something broke.

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

92 tests. The parser cases come from the real checkers' output, not from imagination. The gate tests cover the debounce and the attribution filter, including the case that matters most: an error in a file the agent never touched must produce no message. `tests/hook.e2e.ts` drives the real plugin against the actual DSH packages with a fake shell, so the event name, the decision shape, and the never-break-a-tool-call guarantee are all covered — and so is the absence of a session append, by behaviour and by inspecting the source, because a reintroduced one only fails later, in a different process, when that session is read back.

That file is named `.e2e.ts` rather than `.test.ts`, and until now the test glob only matched `tests/*.test.ts`, so none of it had ever run under `npm test` — it passed when run directly, which is how the gap stayed invisible. The script now matches both patterns.

## Known limitations

- **Detection uses local filesystem access**, not `ctx.fs`. That is fine for local sessions and wrong for a remote-backend session, where detection returns nothing and the plugin stays quiet instead of reporting against the wrong tree.
- **The check is per session, not per file.** Editing `a.ts` runs a project-wide typecheck. Incremental checking would be cheaper and is not attempted.
- **No baseline diff.** Attribution is by edited path, so a file the agent edited that was already broken will report its pre-existing errors. Recording a baseline before the first edit would fix that and is not done.
- **The record only exists when the gate opens.** A run debounced away, or a call to a tool that does not modify files, writes nothing. That is deliberate — the hook fires on every tool call and recording each one would fill the log — but it means a session with no records is still ambiguous between "nothing was edited" and "the plugin is not mounted". Only the presence of records proves engagement.
