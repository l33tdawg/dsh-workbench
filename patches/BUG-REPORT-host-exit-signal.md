# A Host killed by a signal is reported as a clean stop, and its last stderr line as the cause

**Component:** `apps/desktop`, Host exit reporting in `src/host-process.ts`
**Version:** `0.2.0-rc.2` · **Platform:** macOS arm64, Desktop app (bundled Node `24.18.1`, Electron `44.0.0`)

## Summary

The shell reports a killed Host the same way it reports one that stopped. `close` carries the
terminating signal, the handler takes only the exit code, and a signal death arrives as
`code === null`, so it lands on the same branch as a clean exit:

```ts
child.once('close', (code) => {
  const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
  if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
  else this.fail(new Error(`dsh desktop host stopped${suffix}`))
  resolve()
})
```

Two Host deaths on 2026-10-09 arrived like this:

```
dsh desktop host stopped: (node:87788) [DEP0180] DeprecationWarning: fs.Stats constructor is deprecated.
(Use `DeepSeek Harness --trace-deprecation ...` to show where the warning was created)
```

The child's last stderr output is appended after a colon, so it reads as the reason for the stop. It
wasn't. Both processes were killed by `SIGTRAP`, and the signal survives only in the macOS report
written beside the diagnostics file: process `DeepSeek Harness` (the Host runs as the app binary with
`ELECTRON_RUN_AS_NODE=1`), exception `EXC_BREAKPOINT`, termination reason `Trace/BPT trap: 5`,
faulting thread `com.apple.main-thread`. Nothing in the DSH diagnostic says so, and the dialog can't,
because the message above is all it has.

Node emits a `DEP0180` warning at most once per process, so it sits in the retained 64 KiB of stderr
until the child writes that much more. In both incidents nothing was written after it, which is why
it read as the cause; the failure itself printed nothing. That warning sent me looking for `fs.Stats`
constructors.

## What the Host was doing

Both deaths landed about 3 s into the same tool call: a plugin's directory scan that read files
through `node:fs` and checked their size afterwards. The scan reached a 2.6 GB model file, and on the
runtime the Desktop ships that read does not return an error:

| File size | `readFileSync(path, 'utf8')` on the shipped runtime | system Node `v22.22.0` |
|---|---|---|
| 500 MiB | returns a string | returns a string |
| 600 MiB | throws `ERR_STRING_TOO_LONG` | throws `ERR_STRING_TOO_LONG` |
| 1 GiB | throws `ERR_STRING_TOO_LONG` | throws `ERR_STRING_TOO_LONG` |
| 2 GiB - 1 | SIGTRAP, exit 133, empty stderr | throws `ERR_STRING_TOO_LONG` |
| 2 GiB | SIGTRAP, exit 133, empty stderr | throws `ERR_STRING_TOO_LONG` |
| 2.6 GiB | SIGTRAP, exit 133, empty stderr | throws `ERR_STRING_TOO_LONG` |

Every row was measured on 2026-10-09 against all-zero sparse files, the app binary under
`ELECTRON_RUN_AS_NODE=1` and `node` `v22.22.0`. Without an encoding the shipped runtime throws
`ERR_FS_FILE_TOO_LARGE` for the 2.6 GiB file, so the difference is in the string path, not the read.
The trap matches the production crash frame for frame: same `EXC_BREAKPOINT`, same faulting frames at
Electron Framework offset `0x5a698e0`.

That trap is Electron's or Node's to fix, not DSH's, and it is here because it is what exposes the
lost signal. A crash that writes nothing, in a process whose last stderr line is unrelated, is the
case the signal exists to name.

The reading side already has a pattern in-tree: `dsh-fs-local` refuses an oversized read before
opening the file (`readWholeBytes`: `info.size > maxBytes` throws `FS_TOO_LARGE`). Plugins that call
`node:fs` directly get no such guard, and their failure mode is the end of the Host process rather
than a failed tool call. The plugin here was a third-party `check_claims` tool, which now measures
before reading. The Host-side message is what this report asks to fix.

## Reproduction

No large file is needed for the diagnostic defect. Any Host killed by a signal produces it:

1. Make a child exit through a signal rather than a code. The fixture in
   `apps/desktop/tests/host-process.spec.ts` covers the exit-code case already (`/crash` calls
   `process.exit(7)`); the same route with `process.kill(process.pid, 'SIGKILL')` reaches `close` as
   `code === null, signal === 'SIGKILL'`.
2. The reported failure is `dsh desktop host stopped`, the same message a Host that exited zero gets,
   with the child's stderr attached as if it explained the stop.
3. The signal appears in neither the message, the fatal dialog, nor the crash report file, though it
   is the only thing that separates the two cases.

For the real incident, one file still has it: `DeepSeek Harness-2026-10-09-154123.ips` and
`-160619.ips` in `~/Library/Logs/DiagnosticReports`, matching
`crash-2026-10-09T07-41-22-424Z-host.log` and `crash-2026-10-09T08-06-18-213Z-host.log`.

## Patch

Commit [`7b59971f7f`](https://github.com/l33tdawg/deepseek-harness/commit/7b59971f7f) on the fork's
`fix/host-exit-signal` branch, based on upstream `master` `5badb15009`.

`apps/desktop/src/host-process.ts` takes the `signal` from `close` and reports it (`dsh desktop host
was killed by SIGTRAP`), and labels the appended stderr as the last output rather than the cause. The
exit-code and clean-stop branches keep their conditions. The spec gains a `/killed` fixture route and
a test that a signalled child is named by its signal; the existing exit-code test now asserts the
labelled tail. The test uses `SIGKILL` rather than the incident's `SIGTRAP`, because a trapping child
makes macOS write a crash report on every test run.

Evidence, in a fork clone at `5badb15009` with the patch applied:

- `vitest run apps/desktop/tests/host-process.spec.ts`: 22 passed.
- Reverted to the unpatched `host-process.ts` and rerun: 2 failed, 20 passed. The two are the
  exit-code message and the new signal case.
- `tsc -b apps/desktop/tsconfig.host.json`: exit 0.

## Options considered

The stderr tail stays. When a Host exits with a real code it is often the whole explanation (`exited
with 7; last output on stderr: plugin crashed`), and it is capped at 64 KiB; dropping it would trade
one partial answer for another. A separate signal field in the crash report was rejected as
redundant, since the dialog renders the message and the report file renders the error with its
message.
