# Reliability checks and measurement

The goal is to improve DSH's ability to finish authorized coding work, preserve its task across
compaction and report what was verified. A plugin loading successfully does not establish any of
those outcomes. This iteration has two evidence surfaces: deterministic hook regressions and a
read-only census of actual session records.

## Fixed regression scenarios

Run the verification, completion and continuity suites from the repository root:

```sh
node --test --experimental-strip-types --test-force-exit \
  packages/dsh-verify-on-edit/tests/*.test.ts \
  packages/dsh-verify-on-edit/tests/*.e2e.ts \
  packages/dsh-compaction-todo/tests/*.test.ts
node --test tools/reliability-census.test.mjs
```

The scenarios are intentionally small, so a passing total cannot hide a missing final edit:

| Scenario | Observable requirement |
|---|---|
| Edit A, check passes, edit B inside debounce, finish | B remains pending and is checked at the completion boundary. |
| Edit A, then B inside debounce, later edit C triggers a check | An error in B reaches the model even though B's own check was suppressed. |
| Change an exported interface; an unchanged consumer breaks | The consumer's error is reported; it is not declared pre-existing merely because its path was not edited. |
| A checker fails without recognizable diagnostics, times out or cannot run | The notice distinguishes the outcome from a pass. |
| Several edits arrive during a slow check | Checks remain serialized, and the latest pending revision gets one follow-up check. |
| The user explicitly requests no tests or checks | Automatic verification respects that limit during edits and completion. |
| Use the editor's view command | A read does not dirty the workspace or count as an edit. |
| Try to finish with unresolved current-turn work | At most one corrective continuation; a blocker may be reported rather than an endless retry. |
| Cancel, reach a limit or explicitly request a stop/report | The completion guard does not restart the task. |
| Compact, deliver a reminder, reload and take another step | The existing durable reminder suppresses duplicates. |
| Compact again or change/clear the saved state | The newest state wins; old cleared work does not return. |

These tests exercise plugin mechanics. They do not establish that a particular model now makes
fewer coding mistakes, or that DSH matches another harness overall.

## Session census

```sh
node tools/reliability-census.mjs --json > /tmp/dsh-before.json
# After activating the new plugins, start fresh benchmark sessions.
node tools/reliability-census.mjs --since 2026-10-03T08:00:00Z --json > /tmp/dsh-after.json
```

Replace the example timestamp with the actual activation time. `--since` and `--until` select whole
sessions by their creation time. A session that straddles an upgrade cannot serve as a clean
before/after sample. `--session` restricts the report to a session id; `--root` permits an isolated
benchmark home. Output contains aggregate counts, not message bodies, commands or credentials.

The report distinguishes:

- successful and failed edit calls;
- exact-path reads after successful edits;
- recorded automatic-check outcomes: passed, failed, timed-out, unavailable, no-check, unparsed
  and cancelled;
- normal completed turns that edited files but have no outcome record, or edited again after
  their last recorded check;
- current-turn todos left open at completion;
- approval requests and decisions, which include automatic answerers;
- completion continuations and repeated identical reminders within a compaction boundary.

Only plugin-originated `user/message` notices count as verification or continuity delivery. A
README read containing example output, a model quoting a report, and a tool's arbitrary text do
not count. Standard session records remain readable by the stock harness; no custom session event
type is introduced.

Silence is unknown. Historical versions recorded only some failures, so a historical turn without
a check notice does not prove that checks never ran. Similarly, pending todos and a non-passed
check are review signals, not proof of a false completion claim. Manual checks, semantic correctness,
human interruptions and missed requirements need separate scoring. Check record order also cannot
prove exactly which filesystem revision a concurrent command observed.

## Repeated coding tasks

Use fresh copies of the same small fixtures, model, reasoning setting, plugins and test commands.
Do not change the prompt or acceptance criteria between variants. Run at least these tasks in
both configurations:

1. Change a two-file public function signature and update every consumer; the full test suite must
   pass and an untouched consumer error must remain visible until fixed.
2. Fix a bug whose final edit breaks syntax in a second file; completion must include a check of
   that final revision or clearly state why verification is unavailable.
3. Perform a constrained refactor, compact halfway through and resume; retain the original
   constraint and remaining acceptance checks without repeated reminders.
4. Encounter a deliberately unavailable checker; the final report must identify the limitation
   and avoid claiming that tests passed.

Score the resulting patch against the fixture's tests and required changes, then inspect the final
answer for unsupported claims. Record missed requirements, incorrect patches, unsupported success
claims and actual human interventions separately from the census. A completed todo is not evidence
that a requirement was met. Report the number of tasks and repetitions, elapsed time and model/tool
costs alongside the scores. No model-quality improvement is claimed until that comparison is run.

## Baseline captured before this iteration

At 2026-10-03 07:59:08 UTC (15:59 Malaysia time), the local census read 72 sessions with zero unreadable
files: 18,008 tool calls, 1,864 successful edits, 258 failed edit calls, 239 exact-path readbacks,
193 approval requests and 23 compaction reminders. Twenty reminders duplicated an earlier message
within the same compaction boundary. Five legacy verification notices were present; none carried
the new outcome marker. All 223 completed turns containing edits therefore have **unknown automatic
verification coverage under this instrument**. These are baseline observations, not failure counts
and not a controlled coding-task comparison.
