# Give the agent the harness's own manual

## What went wrong in this session, structurally

I built three plugins and a sandbox fix, and along the way I:

- regex-parsed patch text to learn which files a patch touched, when `result.value` reports it typed
- reached for a wall-clock timer, when `ctx.workspaceChanges` tracks real file changes
- keyed state on an object identity, when `sessions` carry a stable branded id
- "discovered" that `auto-review` exists and ships disabled

That last one is the tell. DSH ships a skill whose description reads:

> Use when designing, reviewing, adding, enabling, disabling, installing, configuring, or debugging
> a plugin, bundle, feature, page, panel, tool, or MCP connection in the current Harness profile,
> **including a shipped plugin that is disabled by default**

That is the auto-review finding, written down, before I made it. The harness already knew. I did not,
because nothing in my session pointed at it.

The same is true of the rest. DSH ships `cordis_inspect_list` and `cordis_inspect_query`, which
answer "what services exist?" and "what methods and types does this one expose?". Those are the exact
questions I got wrong. My session had 65 tools and zero of them were the introspection pair.

So this was not a reasoning failure. The instruments, the map, and the manual were in a drawer. The
default preset does not open it.

## The delta, measured

A row-level comparison of the two presets turns up exactly three differences:

| Row | `standard` | `cordis` |
|---|---|---|
| `tool-cordis` | absent | present |
| `skill-filesystem` | plain | `customSkillDirs` → the four bundled skills |
| `tool-plugin-manager` | `disabled: true` | `disabled: !ctx.get('profileContext')` |

Everything else matches, including the persona and the disabled subagent drivers.

The third row is a capability grant and deserves saying plainly rather than burying: in `cordis`, an
agent with a profile context can install and remove bundles from the profile. That is the ability to
change the harness from inside a session. It is arguably what you want if the goal is an agent that
fixes its own tooling, and it is more authority than `standard` gives. Decide that one deliberately.

The first two are the point of this document. `cordis` is `standard` plus the harness's
self-knowledge.

## The fix, one line

The preset registry ships with this default
(`packages/bundle/web-app/cordis.patch.yml:561-564`):

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
```

Change it to `cordis` in a profile patch, and every new session can answer questions about its own
composition instead of guessing:

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: cordis
```

`cordis` ships in the installed bundle (`package.json` `files` lists all four presets), so nothing
needs installing. To try it without changing the default, pick `cordis` from the preset roster in
General settings, or for one session.

## What it costs

Two tool schemas, always loaded. Four lines in the skill catalog, with the bodies loaded on demand
through the `skill` tool. That is the whole steady-state cost, and it is the cheapest possible shape:
purpose first, detail on request. Which is what the `agent-experience` skill says to do, in the
skill I did not have.

Against that: an agent that can look up its own seams instead of being corrected.

## The gap underneath

There is a reason this is a preset switch and not a profile patch adding two rows: **a preset's
plugin list cannot be extended additively.** A patch replaces the targeted row's whole `config`, so
adding `tool-cordis` to `standard` means restating all of `config.plugins`, which then drifts the
moment upstream changes the preset.

That is the same shape as the three gaps in [SEAMS.md](SEAMS.md). The composition model is
per-row powerful and preset-monolithic. You can patch any loader row by id, and you cannot add one
plugin to someone else's preset.

The right long-term fix is an additive form for `config.plugins`, so a deployment can say "standard,
plus these two" and mean it. Until then, switching the default is the honest move, and it is a
one-line change, not a restatement that will rot.

## Why this generalizes past this session

The failure is not "the agent did not read the docs". It is that **the session's own composition
decides what the agent can know about itself**, and the shipped default withholds it. Any user
pointing an agent at DSH's own code hits this, and the correction lands on the user, exactly as it
did here.

The principle worth keeping: if a session is going to modify the harness, the harness should say how
it is put together. Make the instruments default, not opt-in.
