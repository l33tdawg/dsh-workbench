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

### Re-measured, after the reliability pack went live

The pack was mounted in the desktop profile on **2026-10-02 14:19**. Re-running over the whole
corpus gives **46 sessions and 9,450 tool calls, 319 undo-class events, 3.4 per 100**, with
`read-after-edit` at 189 of the 319 (59%).

Splitting by when each session *started*, against that install time:

| | sessions | calls | read-after-edit | sessions with none |
|---|---|---|---|---|
| before | 32 | 4,380 | 1.3 / 100 | 21 of 32 |
| straddling (started before, written after) | 4 | 4,108 | 2.6 / 100 | 0 of 4 |
| after | 10 | 962 | 2.5 / 100 | **9 of 10** |

The four straddling sessions are excluded rather than assigned, because a session that started
before the install ran most of its calls under the old harness.

**This does not settle whether the guidance pack works, and it should not be read as if it did.**
The rate is worse after the install, but nine of the ten post-install sessions recorded no
`read-after-edit` at all, and every one of the 24 events in that bucket came from a single 408-call
session in another workspace. One session carried the entire signal, which is why the split alone
supported only the weaker claim that the prompt-level rule was not visibly doing the work on its
own.

### The same split, run by the tool instead of by hand

`--since` now performs that split, and the report always prints the per-session distribution, so the
"one session carried it" question is answered in the output rather than discovered afterwards.

```
$ node tools/session-audit.mjs --since '2026-10-02 14:19'
sessions analysed: 17
tool calls:        2368
  total                38

pooled rate: 1.6 undo-class events per 100 tool calls

per-session distribution
  sessions with none          11 of 17
  median session              0.0 per 100 calls
  p90 session                 3.7 per 100 calls
  worst session               6.1 per 100 calls  session-c42b18c0
    it holds 25 of 38 events (65.8% of the corpus)
```

Two things follow, and they point in opposite directions from the hand split.

The pooled rate after the install is **1.6 per 100**, below the 3.5 baseline, where the hand split
above had it at 2.5 and rising. The hand split filtered on when a session *started* and had to
exclude four straddling sessions because a session that began before the install ran most of its
calls under the old harness; `--since` applies that rule directly.

That number still cannot be read as an improvement, because **one session holds 65.8% of the
events**. A pooled rate that one session dominates is not evidence about the harness. The
distribution is what makes that visible, and its absence is why the earlier numbers moved between
runs without anyone being able to say why.

So the honest statement is narrower than either reading: the post-install corpus is quiet (11 of 17
sessions at zero) and dominated by one session, and the measurement needed to separate those two
facts did not exist until now.

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

# only sessions that started at or after an install
node tools/session-audit.mjs --since '2026-10-02 14:19'

# per session, worst first
node tools/session-audit.mjs --verbose

# machine-readable, for a comparison
node tools/session-audit.mjs --json > before.json
```

Run it before installing the pack. Run it again after a comparable stretch of work. Compare the
pooled rate, the `read-after-edit` share, **and the distribution**: if one session holds most of the
events, the comparison is between that session and everything else, not between two harnesses.

## Reading a log back with check_claims

Verifying a claim about the corpus means decompressing a session and counting inside it, which is
what `check_claims` is for. It has a bound worth knowing before you trust an empty result.

**`check_claims` examines no file of 2,000,000 bytes or more.** Pinned by bisect on 2026-10-02:
1,999,999 bytes was examined and 2,000,001 was not. A decompressed `session.v4.jsonl.zstd` passes
that in an ordinary working session — the one behind this section was 4.7 MB.

It fails safe, which is the part to lean on: above the bound it reports *"examined no files at this
path, so there is nothing to count"* as **undecided**, never as zero. An `[UNKNOWN]` verdict means
the bound, not an absence. Slice first:

```sh
tail -n 300 session.jsonl > tail.jsonl    # 1.5 MB, scanned normally
```

Two more traps live in the same tool, both hit while writing this. `^` anchors to the start of the
*file* rather than each line unless you pass `flags: "m"`, so a line-anchored pattern silently
matches at most one record. And a bare search for a marker is not a count: grepping a live log for
`verify-on-edit/check` returned 37 hits, nearly all of them the conversation *discussing* the event
rather than records of it. Anchor the record itself — `^\{"type":"verify-on-edit/check"` with
`flags: "m"` — and keep a second pattern in the same call that must match many lines, so a zero
cannot be mistaken for a working search.

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
- **No control was run.** The baseline is the harness as shipped. The post-install reading above is
  the same corpus split by time, not a controlled comparison: the workload differs between the two
  halves, and the post-install side is ten sessions.
- **The metric was broken once.** The retry counter read a call id that was never recorded, so it
  silently duplicated the repeat counter. It reported 3; the true value is 0. That is exactly the
  kind of quiet wrongness the whole project is about, and it is why the counters now have tests that
  pin each one to a distinct situation.

## Next step

The pack is installed. The prompt-level lever did not visibly move the number, so the mechanical one
was built: [`dsh-edit-feedback`](../packages/dsh-edit-feedback) returns the diff DSH computes to the
model instead of only to the UI, which removes the reason to read a file back after editing it.

That is a sharper prediction than the guidance pack's, because it changes what the tool result
*contains* rather than what the model is asked to do:

> **`read-after-edit` falls, and the other three counters do not move.**

Work normally for a comparable stretch, then re-run. If `read-after-edit` does not move, cut the
plugin rather than keeping it because it looks thorough.
