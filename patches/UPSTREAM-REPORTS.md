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
| [9246](https://github.com/deepseek-ai/deepseek-harness/discussions/9246) | A Host killed by a signal is reported as a clean stop, and its last stderr line as the cause | medium | yes |

Each report has a copy in this directory, byte-identical to what was posted.

8649 was found while verifying the `cordis` preset in a real session. The preset's two tool rows
work, which is what made the broken third row worth chasing. The workaround that restores the four
skills in this profile is [`enable-cordis-skills.md`](enable-cordis-skills.md); it was superseded on
2026-10-03 by the repair of the preset's own row in
[`FINDING-cordis-skill-catalog.md`](FINDING-cordis-skill-catalog.md), which retires the row that
workaround inserted. Catalog and skills are verified live in a `cordis` session as of 2026-10-03.

9246 came out of two Desktop Host deaths on 2026-10-09 that were reported as `dsh desktop host
stopped: (node:87788) [DEP0180] DeprecationWarning: fs.Stats constructor is deprecated.` The warning
was the child's last stderr line, not the cause: both processes were killed by `SIGTRAP`, which the
shell drops even though `close` supplies it, so the signal survived only in the macOS report written
beside the crash log. The report carries the trigger measurement (the shipped runtime's
`readFileSync(path, 'utf8')` returns for 500 MiB, throws `ERR_STRING_TOO_LONG` at 600 MiB and 1 GiB,
and ends the process with `SIGTRAP` at 2 GiB - 1 and above, where system Node `v22.22.0` throws), and
the fix is on the fork branch `fix/host-exit-signal`
([`7b59971f7f`](https://github.com/l33tdawg/deepseek-harness/commit/7b59971f7f)).

## Proposals filed

Feature work goes to `Ideas` rather than `General`, because `General` is the defect channel.

| # | Proposal | Filed |
|---|---|---|
| [8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720) | Reuse a server-declared tool catalog across an MCP reconnect. The change is two lines of intent against the SDK's existing response cache; its open questions are whether a server that declares no cache lifetime should get a client-side fallback, and whether a rebuild after an unknown-tool failure belongs in the change. The invalidation conditions are stated in the post | yes |

The copy is [`../research/upstream/PROPOSAL-mcp-catalog-reuse.md`](../research/upstream/PROPOSAL-mcp-catalog-reuse.md),
verified byte-identical to the posted body. The analysis and evidence behind it are in
[`FINDING-mcp-catalog-reuse.md`](FINDING-mcp-catalog-reuse.md).

The body was edited in place on 2026-10-04 to add the invalidation contract (see
[comment 18745138](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18745138)),
so the proposal states what drops a cached catalog rather than leaving a reader to infer it from a
comment. The edit added three blocks and removed nothing; the copy
here is byte-identical to the current body.

## Comments filed

| Discussion | Comment | Filed |
|---|---|---|
| [8630](https://github.com/deepseek-ai/deepseek-harness/discussions/8630#discussioncomment-18727962) | Answer to a comment proposing a `tools/pre-execute` permission gate for the same exfil path: a gate classifies what the agent asks for while the sandbox denies what the process does, so the two are layers rather than substitutes — and the read-protection half of that plugin addresses something this report does not | yes |
| [8635](https://github.com/deepseek-ai/deepseek-harness/discussions/8635#discussioncomment-18726817) | The reload boundary, from the shipped `dsh-hmr` watches plus the session logs: root-composition writes land in a running session in seconds, a preset's own definition waits for the next mount; corrects the third event's "manifest-only" attribution and narrows what strands agents | yes |
| [8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18713176) | The same archive path also suppresses the model-facing skill catalog, because the watcher's `stat` throws before discovery runs; adds the `standard` vs `cordis` measurement | yes |
| [8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18715981) | Answer to a comment that attributed the loss to a written `includeDefaultRoots: false`; the field is not written and its schema default is already `true`, so the symptom cannot establish the value | yes |
| [8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18716221) | The absence list swallows `ENOTDIR`, so the archive root cannot be what ends the read; watch and read are two different failures and only the read one produces the registry's "skipped" line; offers a `watch: false` mount as the experiment that separates them | yes |
| [8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18726436) | The catalog half, answered by intervention: replacing the archive root in the preset's own row restores it, which names the completeness gate at `dsh-tool-skill:216`; carries the throwing expression and rules the watcher out | yes |
| [8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18745138) | Addendum to the catalog-reuse proposal answering a reviewer's four asks: the three invalidation conditions, two of which are already structural in the pinned SDK (`list_changed` eviction, and the server identity as the cache key); the cache API names with the two concrete lines; and the baseline re-checked at `dsh-v0.2.1-alpha.1`, where the wiring is still absent | yes |
| [8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18754123) | The reviewer's cheaper third condition, checked against the source: the eviction is a published store method (`ResponseCacheStore.evict('tools/list')`); a missing tool reaches the caller as a generic `ProtocolError` with `-32602` and server-authored text, so it cannot be a typed trigger; and an eviction on its own does not re-list, so the in-place heal needs the error branch to re-sync as well — never a retry, so the failed call is still never re-run | yes |
| [8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18754547) | Confirmation of the catch site a reader supplied, with the boundary the code draws: the catch is per provider, so one throwing provider loses only its own output, and what makes the loss total is the completeness gate returning before the catalog is built; the uncached incomplete snapshot is what makes the repeated `skipped` warning a usable signal | yes |
| [8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18754781) | The reviewer's option table split into the three shapes it conflates — no hook, eviction only, eviction plus re-sync — because healing at the next reconnect requires the eviction and the eviction is code; and the concurrency objection to the re-sync answered from the supervisor, where one serialized sync queue and a generation guard already bound it | yes |

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

The last 8649 comment is a reader handing over the front half of that gate, and the reply confirms it
while drawing the boundary the code actually draws: the catch is inside the per-provider loop
(`dsh-skill/lib/index.js:346-356`), so a throwing provider loses only its own output, and the loss
becomes total one layer up, because the completeness gate returns before the catalog message is
built. The other half of the observation is kept as the diagnostic it is: an incomplete snapshot is
never cached, so the same `skipped` warning repeating means the provider is still throwing. Body at
[`COMMENT-8649-catch-scope-and-uncached-snapshot.md`](COMMENT-8649-catch-scope-and-uncached-snapshot.md).

The 8720 addendum is
[`COMMENT-8720-invalidation-conditions-and-api.md`](COMMENT-8720-invalidation-conditions-and-api.md).
[PerryLink's comment](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18744426)
read the proposal as unconditional catalog reuse and asked for the invalidation conditions to be
written down before a maintainer could accept it. Two of the three it named need no code, which the
comment shows from the shipped library: the SDK evicts `tools/list` on the inbound `list_changed`
notification itself, and an entry's storage partition *is* the server's declared identity, so a
changed `serverInfo.name@version` cannot reach the previous generation's listing. The third,
rebuilding after an unknown-tool failure, cannot be a typed check — the reference server returns
`InvalidParams` for a missing tool and for bad arguments alike, and surfaces a handler's own failure
as an `isError` result — so the comment offers it as its own change and leaves that choice with the
maintainers.

The baseline question was settled by content hash rather than by reading. `src/tools.ts` and
`src/connection.ts` are the same blobs at `3e6ed5f11f` and at `dsh-v0.2.1-alpha.1`, so the wiring is
still absent at the newer revision, and the published `@deepseek-ai/dsh-mcp-client@0.2.1-alpha.1`
tarball mentions neither `responseCacheStore` nor `defaultCacheTtlMs` anywhere. One correction went
back the other way: the reviewer's "`latest` is `0.2.0-rc.2`" is true of `@deepseek-ai/dsh` but not of
the mcp-client package, whose dist-tags are `latest: 0.0.1-rc.1`, `next: 0.2.0-rc.2`,
`alpha: 0.2.1-alpha.1`. The three conditions were then folded into the post body itself, edited in
place the same day, so the proposal carries its own invalidation contract instead of relying on a
reader opening the comments.

The reviewer's follow-up proposed the cheaper form of the third condition — evict the entry and fail
the call, with no transparent retry — and asked what the failure actually looks like on the wire.
Both were answerable from the pinned library, and checking them corrected the proposal rather than
confirming it. The eviction is one published method, `ResponseCacheStore.evict('tools/list')`,
documented on the interface for exactly that use, so the client-private partition key never has to
be reconstructed. The failure is not typed: the reference server answers a missing tool with
`-32602` and the message `Tool <name> not found` (`@modelcontextprotocol/server` 2.0.0
`dist/mcp-DXXb3Vv3.mjs:1396`), `ProtocolError.fromError` specialises only four shapes and a tool
miss is none of them, so the caller catches a plain `ProtocolError` whose code it shares with "bad
arguments" and whose message is server-authored. And the eviction does not re-list by itself: the
registered definition is captured at sync time, `tools/call` is not a cacheable verb, and
`syncTools` is reached only from a connect or a `list_changed`, so an eviction-only hook heals at
the next reconnect rather than the next call. The reply names evict-plus-re-sync as the shape that
heals in place while keeping the reviewer's property — the failed call is never re-run, so a call
that may have executed is never executed twice. It closes by recording where the idiom already
ships: `callTool`'s header-mismatch branch evicts `tools/list`, re-lists and retries once, gated on
`-32020` and on the caller not having supplied a `toolDefinition` — which DSH always does.
Its body is
[`COMMENT-8720-eviction-primitive-and-error-shape.md`](COMMENT-8720-eviction-primitive-and-error-shape.md).

The reviewer accepted both of those and proposed finalizing with the shape that costs no code, on the
grounds that the in-place re-list would raise "when to re-list, and what concurrency" all over again.
That option table conflates two shapes: healing at the next reconnect is a property of the eviction,
and the eviction is three lines on the same `-32602` branch, so the honest ladder is no hook,
eviction only, and eviction plus re-sync — with the middle row being the smallest version that makes
the documented limitation true by construction. The concurrency objection does not survive reading
the supervisor: every sync already chains through one `syncChain` with an `isCurrent` generation
guard (`src/connection.ts:200-209`), and the `list_changed` handler re-enters that same path
(`:330-338`), so the re-sync adds one `tools/list`, not a new hazard — and it never re-runs the
failed call, which is the property the eviction was chosen for. Body at
[`COMMENT-8720-eviction-cost-ladder.md`](COMMENT-8720-eviction-cost-ladder.md).

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
nothing is wanted, or whether reuse should be strictly server-declared. The thread now carries the
invalidation contract as well — stated in
[comment 18745138](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18745138)
and folded into the post body the same day — so the fallback question and whether the unknown-tool
self-heal belongs in the change are both still with the maintainers. The second reply narrowed that
second question to a choice between two shapes and asked for one of them: evict only, which heals at
the next reconnect, or evict plus the supervisor's re-sync, which heals on the next call and still
never retries the failed one.
