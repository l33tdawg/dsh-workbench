# The case, and the number

## Current reliability census

`node tools/reliability-census.mjs --json` reads standard session records and reports explicit
verification outcomes, pending-work signals, approvals and duplicate compaction reminders. It
does not infer a pass from silence. Use fresh sessions and the protocol in
[`research/RELIABILITY-EVAL.md`](../research/RELIABILITY-EVAL.md) for comparisons; the historical
observations below use a different, broader read-after-edit heuristic.

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

The guidance pack added for this work used to carry that exact rule in its `editing` block, which
made the prediction specific and falsifiable: **installing the pack should cut `read-after-edit`
substantially**, and that cut should be visible in this number and in nothing else.

**Measured on 2026-10-02, and the rule has now been removed.** The split is not an activation time
anyone recorded but the first edit result the plugin itself wrote: session `e7ad4e0f` seq 332 at
`2026-10-02 16:47:33` local, which is eight minutes *earlier* than the "~16:55" this file used to
give. Sixteen sessions that started before it hold 3,192 calls and 44 `read-after-edit` events, a
rate of **1.4 per 100 calls**; thirteen that started after hold 3,455 calls and 23, or **0.7**.
`rework` was 19 in both windows and `repeat-call` and `retry-after-fail` were 0 in both, which is
the "and in nothing else" half of the prediction holding too.

So the mechanical fix does the work and the prompt line was redundant, which is why the pack no
longer carries it — the quote above lives in this file and in `dsh-edit-feedback`'s README, not in
the prompt. The hedge worth stating: 23 events across 13 sessions is a thin corpus, and this tool
has already shown that one session can carry a whole measurement, so treat the halving as
suggestive rather than settled. Re-run it after a comparable stretch before leaning on the size of
the effect.

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

## Repairing a log the harness refuses

Reading the logs is how the numbers above exist, and it is also how a session can stop opening. The
harness reads a session back through `@deepseek-ai/dsh-session-persistence`, which refuses a log
containing an event type outside its own vocabulary unless that record carries `ignorable: true` —
and `Session.append()` takes only `type` and `data`, so a plugin cannot set that marker. A plugin
that writes its own event type therefore produces sessions that load until something reads them
back, and then:

```
session "session-6579e01f-..." contains event type "verify-on-edit/check" (seq 7764) unknown to
this harness and not marked ignorable; refusing to interpret the log
```

`tools/repair-ignorable-events.mjs` marks those records. It is a dry run by default, it re-reads its
own output through the harness's frame scanner before replacing anything, and it backs up every
original first:

```sh
node tools/repair-ignorable-events.mjs                        # every session it would change
node tools/repair-ignorable-events.mjs --apply --backup-dir /tmp/dsh-backups
```

Two things about it are worth knowing before it is needed again. **The backup directory is a flag,
not a default**, because a sandbox that allows writing a session's own file can still refuse to
create a directory beside it — and a backup step that fails after the point of no return is worse
than no backup step. And **it rewrites frames, not text**: a session file is a concatenation of
independently compressed frames, and `tools/session-audit.mjs` finds them by walking the frame and
block structure, the way the harness does. An earlier version of that walk searched for the zstd
magic instead and decoded from every hit, which corrupted a 23 MB log during a dry run: the magic
appears inside compressed payloads, the decode from there succeeds and yields plausible text, and
the frame count still comes out right. `tools/session-frames.test.mjs` holds a case with an
incompressible payload containing the magic, which fails on the magic-scanning version.

## Reading a log back with check_claims

Verifying a claim about the corpus means decompressing a session and counting inside it, which is
what `check_claims` is for. It has a bound worth knowing before you trust an empty result.

**`check_claims` examines no file of 2,000,000 bytes or more.** Pinned by bisect on 2026-10-02:
1,999,999 bytes was examined and 2,000,001 was not. A decompressed `session.v4.jsonl.zstd` passes
that in an ordinary working session — the one behind this section was 4.7 MB.

It fails safe, which is the part to lean on: above the bound it reports *"examined no files at this
path, so there is nothing to count"* as **undecided**, never as zero. An `[UNKNOWN]` verdict means
the bound, not an absence.

That held only while the oversized file was the *only* candidate, which is why the first version of
this section was wrong. Scanning a directory, the oversized file was skipped and the scan still
called itself complete, so a small neighbour made `expect: 0` **pass** while the pattern sat in the
file nobody had read. Fixed on 2026-10-02: a size skip now sets `incomplete` and names the skipped
files in the reason, so the verdict is `UNKNOWN`. An `[UNKNOWN]` is always safe to read as the bound;
a `PASS` never covers a file over the bound, so check what the scan actually read. Slice first
regardless:

```sh
tail -n 300 session.jsonl > tail.jsonl    # 1.5 MB, scanned normally
```

Two more traps live in the same tool, both hit while writing this. `^` anchors to the start of the
*file* rather than each line unless you pass `flags: "m"`, so a line-anchored pattern silently
matches at most one record. And a bare search for a marker is not a count: grepping a live log for a
plugin's event name returned 37 hits, nearly all of them the conversation *discussing* the event
rather than records of it. Anchor the record itself — `^\{"type":"tool/call"` with `flags: "m"` —
and keep a second pattern in the same call that must match many lines, so a zero cannot be mistaken
for a working search.

**A log is evidence about DSH sessions, not about the tree.** This checkout is also edited by tools
that keep no DSH session log, the user's own Codex sessions among them, so an empty search for a
write supports "no DSH session made it" and nothing more. On 2026-10-03 a live profile edit looked
unattributable for exactly that reason before its author turned out to be a Codex session.

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

## The second question these logs answer

`tools/skill-catalog-census.mjs` counts a different durable record in the same corpus: the synthetic
`skill-catalog` user message the harness writes when it tells the model which skills exist. It groups
sessions by their recorded agent preset, because the defect it measures is preset-shaped — `cordis`
sessions carry none, `standard` sessions carry one each.

```
$ node tools/skill-catalog-census.mjs
  preset                sessions  with catalog  catalogs
  standard                    42            42        47
  cordis                      16             0         0
  (no preset recorded)         6             3         3
```

A catalog that is missing is invisible from inside the session, so this is the measure that decides
whether a fix worked; `--since` splits the corpus at a fix time, `--preset` narrows to one preset,
and `--verbose` prints the skill names each session was told about. The mechanism behind the zeros,
and the profile-layer fix, are in
[`../patches/FINDING-cordis-skill-catalog.md`](../patches/FINDING-cordis-skill-catalog.md).

## What a profile edit does to a running session

`tools/session-reload-census.mjs` measures the third durable record in the same corpus: the
`request/header` a session writes once per turn, which carries the tool list the harness sent. Two
consecutive headers whose tool sets differ are a live tool-surface change, and the harness labels the
second one `reason=change`.

```
$ node tools/session-reload-census.mjs
  sessions analysed:        19
  sessions with a change:   9
    additive only           3
    at least one removal    6

  session-c6397e7b-f69d-446b-8896-02cdac2a7d81  preset=standard  /Users/l33tdawg/nodejs-projects/tii-sage
    2026-10-02T08:26:21.278Z   67 tools  reason=change
      + check_claims
```

The count is the evidence for the boundary discussion #8635 asks about: a profile write that changes
what the root composition mounts reaches a running session in seconds, while a write to a preset's own
definition is not consumed until the agent is mounted again. The finding, the measured instants and
the two corrections it makes to the filed report are in
[`../patches/FINDING-profile-reload-boundary.md`](../patches/FINDING-profile-reload-boundary.md).

## Next step

The pack is installed. The prompt-level lever did not visibly move the number, so the mechanical one
was built: [`dsh-edit-feedback`](../packages/dsh-edit-feedback) returns the diff DSH computes to the
model instead of only to the UI, which removes the reason to read a file back after editing it.

That is a sharper prediction than the guidance pack's, because it changes what the tool result
*contains* rather than what the model is asked to do:

> **`read-after-edit` falls, and the other three counters do not move.**

Work normally for a comparable stretch, then re-run. If `read-after-edit` does not move, cut the
plugin rather than keeping it because it looks thorough.
