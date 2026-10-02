# Editing a profile while DSH is running strips the agent's tools from live sessions

**Severity:** high. The session stays alive but can no longer read, write, or run anything.

## What happens

Editing a config file in the active profile directory while `dsh` is running removes most of the session's tools. The session keeps running, and every call to a removed tool returns `Error: unknown tool "<name>"`. Nothing in the transcript says why.

Restarting restores everything, which is what makes it expensive to diagnose: it looks like the profile is broken, so the natural move is to revert the config change rather than restart.

## Exactly what is lost

From the session log, comparing the `request/header` before and after. 65 tools become 41.

**Lost (25):**

```
ask_user_question  bash          create_goal    edit           exit_plan_mode
get_goal           glob          grep           interrupt_agent job_kill
job_list           job_output    list_agents    present        read
read_image         send_message  skill          subagent_fork  todo_write
update_goal        web_fetch     web_search     workflow       write
```

**Survived (41):** 35 `mcp__sage__*` tools, plus `apply_patch`, `read_mcp_resource`, `list_mcp_resources`, `list_mcp_resource_templates`, `load_workspace_dependencies`, `subagent`.

The split is not random. The survivors are the tools contributed by profile rows mounted outside the agent preset. Everything the preset contributes goes, including the tools the agent cannot work without.

The practical effect: the session can still talk to its MCP servers, but it cannot `read` a file, `write` one, or run `bash`. It is not a degraded session, it is a useless one.

`subagent` surviving while `subagent_fork`, `list_agents`, `send_message` and `interrupt_agent` all vanish is unexplained. All five come from `tool-subagent` rows in the same preset (`packages/bundle/base/cordis.patch.yml:364-376`), so a plain scope teardown does not account for it.

## Reproduction

1. Start `dsh`, confirm `bash` and `read` work.
2. In another terminal, edit a config file under `~/.dsh/profiles/<name>/`. Appending a row to `cordis.patch.yml` and rewriting `package.json` both trigger it.
3. Call `bash` in the running session.

Expected: the edit has no effect until restart, or the reload completes and tools remain.

Actual: 25 tools gone for the rest of the session.

## A control I ran

Both times this happened, I had also just used a sandbox escalation, so escalation was a candidate cause. It is not: I ran four escalated commands later in a healthy session (adding a git remote, committing, pushing, removing scratch files) and the tool count stayed at 66 throughout. The profile edit is the trigger.

## Evidence

Reproduced twice on the same profile, with the tool counts above as the record.

The first time, I had just installed three plugins and rewritten `package.json` plus appended a row to `cordis.patch.yml`. I assumed the install was at fault, had the user revert it, and restarted. The revert was unnecessary: later, with the plugins still installed and no revert, a restart came up with all 66 tools.

The second time, the only change was one value in `cordis.patch.yml`. Same result.

`--dump-config` composes correctly in both states, and booting a throwaway copy of the same profile activates every entry, so composition is fine and the damage happens only in the live reconcile.

## Mechanism

Traced. `packages/boot/hmr/src/index.ts` watches the profile's patch files and, on a change, calls
`reconcileProfilePatches`:

```ts
const patches = readProfilePatches('dsh', profile)
const warnings = await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh')
```

`reconcileProfilePatches` resolves the **root** Include entry, the one that mounts the whole
application (`bootstrapIncludes.set(ctx, entry)` where `entry = loader.resolve(includeId)`), and
re-applies it:

```ts
await entry.update({ config: { ...includeConfig, patches: prepared } })
```

Updating the root entry's config rebuilds the plugin tree beneath it. Plugins mounted at the root
re-run `apply()`, which is why tools contributed by top-level rows came back. The live agent's own
scope is not rebuilt, because the agent already exists and nothing recreates it, so every
registration its preset made into that scope is gone.

That accounts for the observed split precisely: root-contributed tools survived, preset-contributed
tools did not. It does not explain the one anomaly above, `subagent` surviving while `subagent_fork`,
`list_agents`, `send_message` and `interrupt_agent` vanished, which suggests `tool-subagent` is also
mounted at root scope somewhere that I did not chase down.

It also accounts for the silence. `reconcileProfilePatches` does raise on newly introduced activation
failures:

```ts
if (introduced.length > 0) throw new Error(activationDiagnostic(binName, introduced).trimEnd())
```

but nothing failed to activate. Every plugin is healthy. The tree they were mounted into for that
agent is simply not the tree the agent is still holding.

## Suggested direction

A patch that changes one value in a profile layer should not require rebuilding the whole
application. The root entry is the wrong granularity, and rebuilding it is what strands live agents.

If the rebuild is unavoidable, then the agents holding scopes from the previous tree need rebuilding
with it, or the reconcile should refuse and ask for a restart rather than leaving sessions with a
partial registry and no diagnostic.

## Workaround

Restart after editing the profile. Do not edit profile files from inside a running session.

## Environment

- DSH `dsh-v0.2.0-rc.2`, commit `639ed0153`
- macOS, desktop profile, `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` plus three local plugins
- Counts read from `request/header` records in `session.v4.jsonl.zstd`
