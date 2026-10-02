# The case, and the number

## The claim

A harness decides how capable a model looks. Two agents running the same weights can differ by more
than two agents running different weights, because one is told when it broke something and the other
is not.

If that is true, then a user who tries DSH, watches it ship a broken edit, and concludes the model
is weak has drawn the wrong conclusion from a real observation. The observation is right. The
attribution is wrong. That matters commercially as much as technically, and it is why this work is
worth doing properly, not patching around.

## The measurement

The claim is testable, so it was tested instead of asserted. `tools/session-audit.mjs` reads the
durable session logs and counts four things that all mean the agent had to revisit work it had
already done:

| Signal | Meaning |
|---|---|
| `rework` | a file edited three or more times in one session |
| `read-after-edit` | a file read after this session already edited it |
| `repeat-call` | an identical tool call issued back to back |
| `retry-after-fail` | an errored call retried with unchanged arguments |

### Baseline, across 36 recorded sessions

```
tool calls:        6,855

  rework              107   a file edited 3+ times
  read-after-edit     127   read after this session edited it
  repeat-call           3   identical call back to back
  retry-after-fail      0   unchanged retry
  ----------------------------------------
  total               237

rate: 3.5 undo-class events per 100 tool calls
```

**3.5 per 100 tool calls.** That is the number to move.

## What the breakdown says

`read-after-edit` is the largest single category, at 127. That is not a model failure. It is the
agent checking whether its own edit landed, because nothing in a default DSH session tells it that
a bad edit fails loudly instead of applying somewhere unexpected. The behaviour is rational given the
information available.

Codex's prompt forbids this explicitly: *"Do not waste tokens by re-reading files after calling
`apply_patch` on them. The tool call will fail if it didn't work."* DSH says nothing.

The guidance pack added for this work carries that exact rule, in its `editing` block:

> After a successful edit, do not re-read the file to confirm it. The call fails if it did not
> apply, so re-reading only spends context.

So the prediction is specific and falsifiable: **installing the pack should cut `read-after-edit`
substantially**, and that cut should be visible in this number and in nothing else.

## How to use it

```sh
# baseline
node tools/session-audit.mjs

# per session, worst first
node tools/session-audit.mjs --verbose

# machine-readable, for a comparison
node tools/session-audit.mjs --json > before.json
```

Run it before installing the pack. Run it again after a comparable stretch of work. Compare the rate
and the `read-after-edit` share.

## Why these four and not something else

Each is read from the durable log, so it needs no instrumentation and cannot be gamed by the agent
reporting on itself. None of them depends on a model judging its own output.

The counters are deliberately conservative. `rework` fires once at the third edit, not on
every edit after, so a file churned six times counts once. A phase where three identical edits
appear is counted as both rework and repetition, which looks like double counting and is not: they
are three calls with one identity, and both statements are true.

And these are proxies, not verdicts. A file edited three times may be a legitimate refactor. What
they measure is *rework*, and a harness that tells the agent what it broke should reduce it. Treat
the number as a comparison between two harnesses on the same corpus. It is not a score.

## The honest caveats

- **One user, 36 sessions, one workflow.** This is not a benchmark and should not be quoted as one.
- **No control was run.** The baseline is the harness as shipped. The post-install number does not
  exist yet, because the pack is not installed.
- **The metric was broken once.** The retry counter read a call id that was never recorded, so it
  silently duplicated the repeat counter. It reported 3; the true value is 0. That is exactly the
  kind of quiet wrongness the whole project is about, and it is why the counters now have tests that
  pin each one to a distinct situation.

## Next step

Install the pack, work normally for a comparable stretch, and re-run. If `read-after-edit` does not
move, the guidance pack is not pulling its weight. Cut it, instead of keeping it because it looks
thorough.
