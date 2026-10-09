# A Host killed by a signal is reported as a clean stop, and its last stderr line as the cause

**Component:** `apps/desktop` — Host exit reporting in `src/host-process.ts`, the fatal dialog and the crash report it writes
**Version:** `0.2.0-rc.2` · **Platform:** macOS arm64, Desktop app (bundled Node `24.18.1`, Electron `44.0.0`)

## Summary

The shell reports a Host that was killed exactly as it reports one that stopped. The `close` event
carries the terminating signal, the handler takes only the exit code, and a signal death arrives as
`code === null`, so it lands on the same branch as a clean exit:

```ts
child.once('close', (code) => {
  const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
  if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
  else this.fail(new Error(`dsh desktop host stopped${suffix}`))
  resolve()
})
```

Two Host deaths on 2026-10-09 were reported that way, and the message was actively misleading rather
than merely incomplete. The child's last stderr output is appended after a colon, which reads as the
reason for the stop. What the operator saw was:

```
dsh desktop host stopped: (node:87788) [DEP0180] DeprecationWarning: fs.Stats constructor is deprecated.
(Use `DeepSeek Harness --trace-deprecation ...` to show where the warning was created)
```

Nothing was deprecated into a crash. The Host had been killed by `SIGTRAP`, which only the macOS
report written beside the diagnostics file records: the process is `DeepSeek Harness` (the Host runs
as the app binary with `ELECTRON_RUN_AS_NODE=1`), the exception is `EXC_BREAKPOINT`, the termination
reason is `Trace/BPT trap: 5`, and the faulting thread is `com.apple.main-thread`. The DSH-side
diagnostic does not mention the signal anywhere, and the dialog cannot: the only input it has is the
message built above.

A `DEP0180` warning is emitted at most once per process, so it sits in the retained tail until the
child writes 64 KiB more. In both incidents nothing else was written after it, which is what made it
read as the cause: the failure itself printed nothing.

## What the Host was doing

The kills were not random. Both landed about 3 s into the same tool call — a plugin's directory scan
that read files through `node:fs` and checked their size afterwards. The scan reached a 2.6 GB model
file, and on the runtime the Desktop ships that read does not return an error:

| File size | `readFileSync(path, 'utf8')` on the shipped runtime | system Node `v22.22.0` |
|---|---|---|
| 500 MiB | returns a string | returns a string |
| 600 MiB | throws `ERR_STRING_TOO_LONG` | throws `ERR_STRING_TOO_LONG` |
| 1 GiB | throws `ERR_STRING_TOO_LONG` | throws `ERR_STRING_TOO_LONG` |
| 2 GiB − 1 | **SIGTRAP, exit 133, empty stderr** | throws `ERR_STRING_TOO_LONG` |
| 2 GiB | **SIGTRAP, exit 133, empty stderr** | throws `ERR_STRING_TOO_LONG` |
| 2.6 GiB | **SIGTRAP, exit 133, empty stderr** | throws `ERR_STRING_TOO_LONG` |

Measured 2026-10-09 with all-zero sparse files under `ELECTRON_RUN_AS_NODE=1` on the app binary, and
against the same files under `node` `v22.22.0`. Without an encoding the shipped runtime throws
`ERR_FS_FILE_TOO_LARGE` for the 2.6 GiB file, so the difference is in the string path rather than the
read. The trap reproduces the production frame exactly: the same `EXC_BREAKPOINT`, and the same
faulting frames at Electron Framework offset `0x5a698e0` as both Host deaths.

The runtime trap is Electron's or Node's to fix and is not the subject of this report. It is here
because it is the trigger, and because it shows what the lost signal costs: a crash that writes
nothing, in a process whose last stderr line is unrelated, is exactly the case the signal exists to
distinguish.

An in-tree pattern for the reading side already exists: `dsh-fs-local` refuses an oversized read
before opening the file (`readWholeBytes`: `info.size > maxBytes` throws `FS_TOO_LARGE`). Plugins
that use `node:fs` directly get no such guard, and the failure mode is not a failed tool call but the
end of the Host process. The plugin involved here (a third-party `check_claims` tool) now measures
before reading; the Host-side diagnostic is what this report asks to fix.

## Reproduction

The diagnostic defect needs no large file. Any Host killed by a signal produces it:

1. Make a child exit through a signal rather than an exit code. In `apps/desktop/tests/host-process.spec.ts`
   the fixture already covers the exit-code case (`/crash` → `process.exit(7)`); the same shape with
   `process.kill(process.pid, 'SIGKILL')` reaches `close` as `code === null, signal === 'SIGKILL'`.
2. Observe that the failure reported is `dsh desktop host stopped`, identical to a Host that exited
   zero, with the child's stderr appended as if it were the cause.
3. Observe that the signal appears nowhere in the message, the fatal dialog, or the crash report
   file, although it is the only fact that distinguishes the two cases.

For the real incident, the report beside the crash log is the only place the signal survives:
`DeepSeek Harness-2026-10-09-154123.ips` and `…-160619.ips` in `~/Library/Logs/DiagnosticReports`,
matching `crash-2026-10-09T07-41-22-424Z-host.log` and `crash-2026-10-09T08-06-18-213Z-host.log`.

## Patch

Commit [`7b59971f7f`](https://github.com/l33tdawg/deepseek-harness/commit/7b59971f7f) on the fork's
`fix/host-exit-signal` branch, based on upstream `master` `5badb15009`.

- `apps/desktop/src/host-process.ts`: takes the `signal` from `close` and reports it —
  `dsh desktop host was killed by SIGTRAP` — and labels the appended stderr tail for what it is
  (`; last output on stderr: …`) rather than presenting it as the cause. The exit-code and clean-stop
  messages keep their conditions, so nothing else changes.
- `apps/desktop/tests/host-process.spec.ts`: adds a `/killed` fixture route and a test that a
  signalled child is named by its signal; the existing exit-code test now asserts the labelled tail.

`SIGKILL` is used in the test rather than the `SIGTRAP` from the incident, because a trapping child
makes macOS write a crash report on every test run.

Evidence, in a fork clone at `5badb15009` with the patch applied:

- `vitest run apps/desktop/tests/host-process.spec.ts` — 22 tests, all passing.
- Reverted to the unpatched `host-process.ts` and rerun — 2 failed, 20 passed, and the two are
  exactly the changed behavior: the exit-code message and the new signal case.
- `tsc -b apps/desktop/tsconfig.host.json` — exit 0.

## Options considered

Reporting the tail is still worth doing, and only its framing changes. Dropping it was rejected: for
a Host that exits with a real code it is often the whole explanation (`exited with 7; last output on
stderr: plugin crashed`), and it is bounded at 64 KiB. Reporting the signal *instead* of the tail
would trade one partial answer for another.

Adding the signal to the crash report as a separate field was rejected as redundant: the message is
what the dialog renders, and the report file already renders the error with its message, so the
signal reaches both once it is in the message.
