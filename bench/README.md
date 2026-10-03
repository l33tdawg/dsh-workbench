# The controlled comparison

`research/RELIABILITY-EVAL.md` asks for the one thing this repository has never produced: a
comparison that can say whether the reliability work changed anything. Its "Repeated coding tasks"
section specifies it — the same small fixtures, model and reasoning setting, run against two
configurations that differ only in which plugins are mounted, with the patch scored against the
fixture's own tests — and closes with *"No model-quality improvement is claimed until that
comparison is run."*

This directory is that comparison, as a command.

```sh
node bench/run.mjs  --fixture signature-change --variant off --permission-mode danger-full-access
node bench/run.mjs  --fixture signature-change --variant on  --permission-mode danger-full-access
node bench/score.mjs --run .scratch/bench-runs/signature-change/off/rep-1
```

## What each piece is for

| File | Job |
|---|---|
| `run.mjs` | Fresh fixture copy, isolated harness home, one variant, capture the patch and the stream |
| `score.mjs` | Restore the fixture's own tests, run them against the agent's patch, audit the session |
| `variants.mjs` | The two configurations, as a `--patch` overlay |
| `fixtures/*/task.md` | The prompt the agent receives |

**The configuration is a patch overlay, not an installed profile.** The overlay is applied by the
same loader path a bundle uses, so the plugins are mounted the way they are mounted for real, and
the "off" arm is the shipped profile rather than a hand-stripped copy of it. Nothing is installed
and no package manager runs. Verified, not assumed: the "on" arm's prompt is 2k tokens larger than
the "off" arm's at the same step count, which is the guidance pack's section arriving.

**The harness home is isolated.** Runs use `$DSH_HOME` under the output directory, never `~/.dsh`,
so benchmark sessions land in their own corpus and cannot be mistaken for real usage. Credentials
are the one thing copied in, because a new home has none.

**The scorer restores `test/` and `package.json` before running the suite.** Without that, "make the
tests pass" has a cheaper solution than fixing the code, and a run that deleted an assertion would
score as a clean pass. The agent's source changes are left exactly as it made them.

## Containment: settled with a container

DSH's macOS confinement applies seatbelt through `sandbox-exec`, and **`sandbox-exec` cannot be
applied from inside another sandbox**. Launched from a confined shell — which is how an agent runs a
benchmark — the inner sandbox fails closed:

```
sandbox-exec: sandbox_apply: Operation not permitted
```

It then refuses to run the command unconfined, so the agent has **no working shell at all** and
cannot run the fixture's tests. The first pair of runs taken here did exactly that: both arms
produced a patch, neither ever executed the suite, and the acceptance criterion "the full test
suite must pass" was never exercised. Those runs were discarded.

DSH's own sandbox cannot be the boundary for a benchmark, so the container is:

```sh
docker build -t dsh-bench:0.2.0-rc.2 bench/container
export DOCKER_CONFIG="$PWD/.scratch/docker-config"   # buildx otherwise writes outside the sandbox
node bench/run.mjs --fixture signature-change --variant on --container
```

`--container` runs the harness in `bench/container/Dockerfile` with `DSH_PERMISSION_MODE` defaulted
to `danger-full-access` — inside a container that is correct rather than a compromise, because the
container is what contains the run. Verified, not assumed: the agent was asked to run
`echo container-bash-ok` and returned exactly that, and a full fixture run scored 10 of 10 with the
suite actually executing.

Two things had to be right for that to work, and both failed first:

- **The mounted plugins could not resolve the harness's own packages.** Node resolves by walking up
  from the importing file, and a file under `/repo/packages/...` never reaches the global install.
  The plugins that import a package for its *value* fail to load — `dsh-compaction-todo` needs
  `createUserMessage` from `@deepseek-ai/dsh-llm` — while the type-only imports are erased and load
  fine, so the arm silently mounts a subset of what it claims to. A runner prelude now links the
  container's dependency tree in, and the failure is gone.
- **The runner was discarding the evidence.** `execFileSync` lets a child's stderr inherit the
  terminal and returns only stdout, so that import failure printed to the screen, was never
  recorded, and left a run that exited 0 looking clean. It uses `spawnSync` now and keeps both
  streams.

## What has and has not been shown

Both fixtures are proven solvable, the harness runs end to end on the host and in a container, and
the scorer produces a verdict that survives sabotage. **No comparison has been run.** Single runs
score 10 of 10 in both arms; at one repetition per arm that is a smoke test, not a result, and
nothing should be concluded from it. A real comparison needs repetitions on both arms of every
fixture.

### A blind spot in the instrument this reads

The scorer audits each run with `tools/session-audit.mjs`, and that audit cannot see
`apply_patch`. Its `WRITE_TOOLS` holds `edit`, `write` and `str_replace_editor`; `apply_patch` is
absent, and `pathOf` reads `args.file_path ?? args.path` while an `apply_patch` call carries
`{ patch }` instead. Across the 78 real sessions on this machine:

```
edit                 1194
write                 415
apply_patch           722   <- unseen by the audit
str_replace_editor      0

1609 counted, 722 invisible => 31.0% of write calls are unseen
```

That is this repository's own plugin, mounted in the desktop profile and in the benchmark's "on"
arm. Every `filesEdited` the census reports is therefore a floor, and `read-after-edit` and
`rework` inherit the same gap, because both key off the set of edited paths. Fixing it means
teaching `pathOf` to read every target out of a multi-file patch, which changes what the counters
mean and invalidates the numbers currently quoted in `tools/README.md` — so it is recorded here
rather than patched at the end of a session.


## Fixture status

| Fixture | State |
|---|---|
| `signature-change` | **Done.** Verified in three states: as shipped 5 of 10 pass, correct migration 10 of 10, one consumer missed 9 of 10 with exactly the right test failing. |
| `bug-fix` | **Done.** Verified as shipped 7 of 11, reference fix 11 of 11. |
| *unavailable checker* | Not built. |
| *constrained refactor across a compaction* | Not built. `compaction-basic` exposes `thresholdRatio` and `auto`, so a low threshold can force compaction deterministically rather than hoping for it — but nothing here uses that yet. |

Both existing fixtures state the same constraint in `task.md`: do not change the tests. That is
enforced by the scorer rather than trusted, because it is the one instruction whose violation would
silently inflate every score.
