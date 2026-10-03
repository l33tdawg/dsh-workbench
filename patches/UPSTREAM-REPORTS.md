# Upstream reports

DSH's [`CONTRIBUTING.md`](https://github.com/deepseek-ai/deepseek-harness/blob/main/CONTRIBUTING.md)
declines external pull requests and names **GitHub Discussions** as the channel. Issues are disabled
on the repository, so everything below is a discussion. The `General` category is the de-facto bug
channel; four of the five most recent discussions there are defect reports.

## Filed

| # | Report | Severity | Filed |
|---|---|---|---|
| [8630](https://github.com/deepseek-ai/deepseek-harness/discussions/8630) | Sandbox modes named read-only / workspace-write do not restrict network egress | security | yes |
| [8635](https://github.com/deepseek-ai/deepseek-harness/discussions/8635) | Editing a profile while DSH runs drops preset-scoped tools from live sessions | high | yes |
| [8636](https://github.com/deepseek-ai/deepseek-harness/discussions/8636) | Unknown tool arguments are accepted and silently dropped | medium | yes |
| [8637](https://github.com/deepseek-ai/deepseek-harness/discussions/8637) | Three prompt sections render for agents without the tools they describe | low | yes |
| [8638](https://github.com/deepseek-ai/deepseek-harness/discussions/8638) | `isConcurrencySafe` is unset on the shell tools | low | yes |
| [8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649) | The `cordis` preset loses every filesystem skill in Desktop, because its only skill provider points inside `app.asar` | high | yes |

Each report has a copy in this directory, byte-identical to what was posted.

8649 was found while verifying the `cordis` preset in a real session. The preset's two tool rows
work, which is what made the broken third row worth chasing. The workaround that restores the four
skills in this profile is [`enable-cordis-skills.md`](enable-cordis-skills.md); it was superseded on
2026-10-03 by the repair of the preset's own row in
[`FINDING-cordis-skill-catalog.md`](FINDING-cordis-skill-catalog.md), which retires the row that
workaround inserted. Catalog and skills are verified live in a `cordis` session as of 2026-10-03.

## Proposals filed

Feature work goes to `Ideas` rather than `General`, because `General` is the defect channel.

| # | Proposal | Filed |
|---|---|---|
| [8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720) | Reuse a server-declared tool catalog across an MCP reconnect. The change is two lines of intent against the SDK's existing response cache; the open question is whether a server that declares no cache lifetime should get a client-side fallback | yes |

The copy is [`../research/upstream/PROPOSAL-mcp-catalog-reuse.md`](../research/upstream/PROPOSAL-mcp-catalog-reuse.md),
verified byte-identical to the posted body. The analysis and evidence behind it are in
[`FINDING-mcp-catalog-reuse.md`](FINDING-mcp-catalog-reuse.md).

## Comments filed

| Discussion | Comment | Filed |
|---|---|---|
| [8630](https://github.com/deepseek-ai/deepseek-harness/discussions/8630#discussioncomment-18727962) | Answer to a comment proposing a `tools/pre-execute` permission gate for the same exfil path: a gate classifies what the agent asks for while the sandbox denies what the process does, so the two are layers rather than substitutes — and the read-protection half of that plugin addresses something this report does not | yes |
| [8635](https://github.com/deepseek-ai/deepseek-harness/discussions/8635#discussioncomment-18726817) | The reload boundary, from the shipped `dsh-hmr` watches plus the session logs: root-composition writes land in a running session in seconds, a preset's own definition waits for the next mount; corrects the third event's "manifest-only" attribution and narrows what strands agents | yes |
| [8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18713176) | The same archive path also suppresses the model-facing skill catalog, because the watcher's `stat` throws before discovery runs; adds the `standard` vs `cordis` measurement | yes |
| [8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18715981) | Answer to a comment that attributed the loss to a written `includeDefaultRoots: false`; the field is not written and its schema default is already `true`, so the symptom cannot establish the value | yes |
| [8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18716221) | The absence list swallows `ENOTDIR`, so the archive root cannot be what ends the read; watch and read are two different failures and only the read one produces the registry's "skipped" line; offers a `watch: false` mount as the experiment that separates them | yes |
| [8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18726436) | The catalog half, answered by intervention: replacing the archive root in the preset's own row restores it, which names the completeness gate at `dsh-tool-skill:216`; carries the throwing expression and rules the watcher out | yes |

The bodies are [`BUG-REPORT-asar-skill-roots-ADDENDUM.md`](BUG-REPORT-asar-skill-roots-ADDENDUM.md),
[`COMMENT-8649-includeDefaultRoots-default.md`](COMMENT-8649-includeDefaultRoots-default.md),
[`COMMENT-8649-absent-errors-and-two-paths.md`](COMMENT-8649-absent-errors-and-two-paths.md) and
[`COMMENT-8649-gate2-live-confirmation.md`](COMMENT-8649-gate2-live-confirmation.md),
posted with [`post-discussion-comment.mjs`](post-discussion-comment.mjs). The first refines 8649
rather than replacing it: the report's `discoverRoot` guard is still wanted, and the comment covers
the watch path plus the publisher's refusal to publish an incomplete snapshot. The second answers
[xiaoshenming's comment](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18715750),
which read the failure as isolation to a single root and inferred from the symptom that the row
wrote `includeDefaultRoots: false`. It did not: the field is absent from both presets and the schema
default is `true`, so the isolation framing is right while the inference from the symptom is not —
the reason a written `false` and an absent field look identical here is that rank 300 is scanned
before ranks 100, 200, 400 and 500, and its throw ends the provider's `list()`.

Answering it meant reading the shipped code rather than the npm copy. The Desktop bundle is inside
`app.asar`, and the archive is a plain file: parse the header at `16`, then read each entry's bytes
at `16 + headerSize + 2 + offset`, where `headerSize` is the `UInt32LE` at byte 12. The `+ 2` is the
part that misleads, because the wrong constant still yields a file of exactly the recorded size, one
that merely starts mid-JSON. `patches/cordis-skills-sync.mjs` derives that offset from the pickle
header it reads (`8 + headerSize`) and never used the `16 + jsonLength` form its own doc comment
warns about, so nothing already vendored moved. What the constant is checked against here is the
archive's per-file `integrity.hash`: the four library bundles compare byte for byte with their
`node_modules` copies, both presets hash clean, and all 17 files under the preset's `skills/`
directory hash clean and match `patches/cordis-skills/` exactly.

## Corrections made after filing

Everything below was found by re-checking the reports against the source and the session logs
*after* posting. Each is either corrected upstream or, where the correction is a narrowing that a
maintainer should see, noted in a comment on the same discussion.

### 8649's second comment collapsed two different failures into one

Found while answering a reader on 2026-10-02, and corrected in
[comment 18716221](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18716221).
The addendum says the watcher is what marks the observation incomplete. The code cannot support that
as the only mechanism, because the two paths fail differently and only one of them is visible in the
registry's log:

| Where | Code | Effect |
|---|---|---|
| Watch | `skill-filesystem` `:97`, `observeRoots` in a `try`/`catch` | catch sets `complete = false`; `list()` returns `{ candidates, complete: false }`, no throw reaches the registry |
| Read | `:103`, the unguarded `discoverRoot` loop | rejection ends `list()` and the provider is skipped, which is the only case that logs `skill provider "filesystem" skipped:` |

The distinction was hiding in the reader's own comment, which pointed at
`isAbsentSkillPathError` (`:573`, `:576`): the absence class includes `ENOTDIR`, `ENOENT`,
`FS_NOT_FOUND` and `FS_NOT_DIRECTORY`, and both root-entry readers return `[]` on it (`:624` for the
file-service path, `:648` for the Node path). A plain Node `ENOTDIR` on the archive root is therefore
swallowed and the loop continues to ranks 400 and 500. What ends the read is the `TypeError`
(`Cannot mix BigInt and other types`) this repository measured on the host file service, which is not
an absence and does propagate.

So the report's discovery-side chain stands and its attribution does not. Which path is at fault is
now an open question with a named experiment rather than an assertion: mount the provider again with
`watch: false` (schema default `true` at `:37`, consumed at `:494`) and see whether the throw
survives. Watching off plus a throw means the read owns it; watching off and no throw means the
watcher does.

Answered on 2026-10-03 by
[comment 18726436](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18726436),
without needing that mount. `resolveRootWatchMode` swallows the absence class and returns the
nearest existing ancestor, so `observeRoots` never throws on the archive root and `complete` is
still `true` when the read loop starts. Replacing that one root with a readable directory then
restored the catalog, which no `cordis` session had carried in the two days before it. The read
owns it, and the two symptoms have one cause: the skipped provider is what flips `complete`, which
is the gate that suppresses the catalog.

### 8635 overstated the blast radius

It claimed the session loses "every preset-scoped tool". It does not. Comparing `request/header`
records either side of the event: **65 tools become 41, so 25 are lost**, and the survivors are the
35 `mcp__sage__*` tools plus `apply_patch` and four other top-level contributors.

The corrected version lists both sets exactly. The finding is sharper than the original claim: the
session keeps its MCP servers and loses `read`, `write`, `bash`, `edit`, `grep` and `glob`. It is not
degraded, it is useless.

`subagent` surviving while `subagent_fork`, `list_agents`, `send_message` and `interrupt_agent`
vanish is flagged in the report as unexplained. All five come from the same preset rows, so a plain
scope teardown does not account for it.

### 8635 had an uncontrolled confound

Both occurrences followed a sandbox escalation, which I had not separated from the profile edit. A
later session provided the control: four escalated commands (git remote, commit, push, rm) with the
tool count holding at 66 throughout. Escalation is ruled out. That control is now in the report,
because a cause I had not excluded is the first thing a reader should ask about.

### 8635's reload boundary, and its third event's attribution

Settled on 2026-10-03 from the shipped `dsh-hmr` source and the session logs, without writing to the
profile. A patch-file write always recomposes the **root** composition, and that reaches a running
session 2.5-3.0 s later; a manifest write only matters through the ordered `dsh.profile.bundles`
list; and nothing on that path re-mounts an agent, so a change to a preset's own definition waits for
the next mount. The two observations that looked contradictory are the two halves of that rule: four
running sessions gained `check_claims` 2.5 s to 3.9 min after a 2026-10-02 install, and the
`preset-cordis` repair on 2026-10-03 produced no tool-surface change at all and no `cordis` skill
catalog until the app was relaunched 3 h later.

Two corrections follow. The third event's "editing only `package.json`" is not what happened: that
install wrote both files 3 ms apart, the manifest path alone is gated on the bundle list, and the one
genuinely manifest-only install in the same profile mounted nothing because its bundle contributes no
tool. And the loss itself is not a property of the patch layer: the same file, written twice in two
hours, took 25 tools from four sessions once and added one cleanly the other time. What separates the
two is the shape of the entry - the destructive write introduced a **new** profile-layer override of
an existing host-plane row, which the Loader has to dispose and re-create - and that stays a
hypothesis, recorded as such.

The measurement is [`FINDING-profile-reload-boundary.md`](FINDING-profile-reload-boundary.md) and is
reproducible with [`../tools/session-reload-census.mjs`](../tools/session-reload-census.mjs). The
comment body is [`COMMENT-8635-reload-boundary.md`](COMMENT-8635-reload-boundary.md), posted as
[comment 18726817](https://github.com/deepseek-ai/deepseek-harness/discussions/8635#discussioncomment-18726817).

### 8637 undercounted by six

It said three prompt sections render unguarded. Parsing every `ctx.systemPrompt.section({...})`
object literal under `packages/` gives **21 registrations, 16 of them tool sections, 7 guarded and 9
not**. Added: `tool:bash`, `tool:pwsh`, `tool:pty`, `tool:lsp`, `tool:session-query` and
`tool:workflow`.

The original also cited `packages/dsh-apply-patch` as an example of the guard, which is a plugin in
*this* repository, not theirs. A maintainer searching for it would find nothing. Replaced with the
seven shipped files that actually do it.

### 8636 was checked and held

The filed example was re-tested against the path the runtime uses, `defineTool` at
`packages/core/tools/src/schema.ts:578-599`, which is
`validateJsonSchemaValue(parameterSchemaSpecToJsonSchema(spec), args, '')`. The report now cites that
call site and notes that the extra key is *passed through* to the tool body rather than stripped.

### 8637 undercounted a second time, and the tool we built caught it

The "21 registrations, seven guarded, nine unguarded" figure above was itself wrong. It came from
searching for `ctx.systemPrompt.section({`, which silently misses every registration made through a
different receiver. Nine use another name:

```
promptCtx  scope  inner  scoped  childCtx  runtimeCtx
```

Corrected to **30 registrations, eight guarded, ten unguarded tool sections**.

How it was found is the part worth keeping. `check_claims` was pointed at the claim "`packages/`
contains 21 of these" and returned 85, because it searched the whole tree including tests and
matched any receiver. Narrowing to shipped source gave 30. The tool found, in its first hour, an
error that two rounds of manual review had missed, and it missed it in the direction that made the
defect look smaller, which is the direction a hand search fails in.

## Checked and rejected

Two findings from the earlier analysis did not survive verification. Recording them here so they are
not re-filed later.

### Compaction headroom is not a bug

`resolveCompactSpec` throws `TargetPressureConfigError` when
`(contextWindow − reservedCompletion) − headroomTokens` is not positive
(`packages/compaction/compaction-basic/src/config.ts:181-194`). With the shipped `headroomTokens:
65536`, any context window below roughly 73.5k has no auto compaction, which looked like a defect.

It is not. The error carries an actionable message naming all three remedies:

> reduce the effective request maxTokens or compaction headroomTokens, or configure a larger adapter
> model contextWindow

And it does not bite on the default model: `deepseek-flash` declares
`contextWindow: 1_000_000` (`packages/llm/llm-deepseek/src/defaults.ts:6`), where the 0.8 ratio
binds for any completion reserve under ~134k. Failing loudly with the fix named is the right
behaviour for a misconfiguration. Filing this would have been noise.

### The unknown-argument example was wrong

The earlier draft claimed:

```
edit { file_path: "a.ts", old_str: "x", new_string: "y" }   # old_str ignored; old_string missing
```

That call is **rejected**. `old_string` is required, so omitting it trips `required` and the model
gets `missing required property "value.file_path"`. The real defect is narrower, and only shows up
when the misspelled parameter is optional or undeclared:

```js
const schema = parameterSchemaSpecToJsonSchema({
  file_path: { type: 'string', required: true },
  replace_all: { type: 'boolean' },
})
validateJsonSchemaValue(schema, { file_path: 'a', replace_alll: true })  // []  <- typo discarded
validateJsonSchemaValue(schema, { file_path: 'a', wat: 1 })              // []  <- unknown discarded
```

The filed report uses the corrected example. Worth the correction: a report whose first
reproduction does not reproduce gets closed on that basis, whatever else it says.

### The LSP diagnostics request is already filed, and better than ours would have been

Task `423df7d2` proposed feeding LSP diagnostics into the edit loop, and the follow-up task proposed
filing it upstream. **Neither was filed, because the search for a duplicate found the report already
there.** [Discussion 781](https://github.com/deepseek-ai/deepseek-harness/discussions/781) takes the
`ctx.lsp` seam from four navigation operations to seven by adding `diagnostics`, `formatDocument` and
`completion` — with a committed fork branch, a patch file, an `onNotification` path that stops
discarding `publishDiagnostics`, and a bounded settle window for push-only servers. A consumer plugin
(`dsh-lsp-actions`) works against the current seam today. Ours would have been a strictly worse
duplicate, and posting it would have added noise to a thread waiting on maintainers.

The second candidate died the same way. Measured this session: `ctx.logger` output from a plugin
leaves no durable trace anywhere — no log file under `~/.dsh`, no log-shaped record type in the
session log — which makes a plugin's warning unreadable after the fact. That is
[2905](https://github.com/deepseek-ai/deepseek-harness/discussions/2905), whose title is literally
"`ctx.logger` has no sink in any shipped profile", and
[5138](https://github.com/deepseek-ai/deepseek-harness/discussions/5138), "dsh silently drops
warnings today".

One correction to an earlier draft of this entry, kept because the mistake is the instructive part.
It said the three LSP packages were "absent". They are not: `@deepseek-ai/dsh-lsp` 0.0.1-rc.1,
`dsh-lsp-stdio` 0.0.1-rc.5 and `dsh-tool-lsp` 0.0.1-rc.1 are all published, and none is *mounted* in
this profile — which is a row to add, not a package to write. The first check appeared to confirm
absence and was void: `npm view` returned nothing for `dsh-tools` too, and that one is installed. A
control that fails is worth more than the result it was guarding.

**What is worth keeping is the demand-side number**, because neither existing thread has it. Across
56 sessions and 1,508 edit-class tool calls, the failure this would catch — an edit that breaks the
project check — occurred **twice**, and the existing compile-based checker caught both. So the value
of the seam extension is latency and precision, not coverage. That measurement is recorded in
[`../research/SEAMS.md`](../research/SEAMS.md) §1b. It was deliberately **not** posted as a comment
on 781: arguing down someone else's proposal, on their thread, is their call and not ours to make
unasked.

## Still open

Nothing from the original analysis is unfiled. The remaining gaps in
[`../research/SCORECARD.md`](../research/SCORECARD.md) are feature work, not defects, and belong in
the repository we control rather than upstream.

The one proposal, [discussion 8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720)
(Tier 3.8), is filed. Its open policy question is recorded in the post itself, so the thread carries
the decision rather than this file: whether a client-side fallback lifetime for servers that declare
nothing is wanted, or whether reuse should be strictly server-declared.
