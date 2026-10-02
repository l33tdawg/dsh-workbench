# The `cordis` preset loses every filesystem skill in Desktop, because its only skill provider points inside `app.asar`

**Component:** `skill/skill-filesystem`, `bundle/web-app/cordis.patch.yml`, host file service
**Version:** `0.2.0-rc.2` · **Platform:** macOS, Desktop app

## Summary

With the `cordis` agent preset selected, `skill` cannot load the four skills the preset ships, and it
cannot load skills the user wrote either. Skills served by `@deepseek-ai/dsh-skill-office` still
load, so the registry and the tool work. What fails is the only filesystem provider an agent has.

The provider configuration is the problem. `bundle/web-app/cordis.patch.yml` disables the host
`skill-filesystem` row on purpose, because presets own local discovery. The `cordis` preset then
mounts its own copy with `customSkillDirs` pointing at `@deepseek-ai/dsh-agent-preset/skills`, which
in the Desktop app lives inside `app.asar`. The host file service fails on that path with
`TypeError: Cannot mix BigInt and other types, use explicit conversions`, and `discoverRoot` treats a
failing root as a failing provider:

1. The host row is disabled, so the preset's row is the only provider for local skills.
2. That row's only custom directory is inside `app.asar`.
3. The file service cannot read inside the archive, and the error is a `TypeError` rather than an
   absence, so it is not classified as one.
4. `discoverRoot` awaits each root without a guard, so this one rejection ends the provider's whole
   `list()`. The custom directory is scanned before the default roots, so the project's
   `.dsh/skills`, `~/.dsh/skills` and `~/.agents/skills` are lost with it.
5. `SkillRegistry` answers a throwing provider by skipping it and keeping the others. That is the
   right call for one bad provider, but nothing reaches the user, and the catalog merely looks small.

`cordis-plugin-development/SKILL.md` already describes the constraint this path runs into:

> In Desktop the directory sits inside `app.asar`, which only the Host process's own file reads can
> open; shell commands (`ls`, `cat`, `cp`, `cmp`), the glob and search tools (they run a native
> ripgrep process), `node`, and pnpm all fail on it.

Host file reads are what the skill provider uses, and they fail here.

## Reproduction

1. Choose `cordis` in General settings, then agent preset. Start a new session: a preset is fixed at
   session start.
2. Ask that session to load a bundled skill, then a user skill, then a skill from another provider:

```
skill("cordis-plugin-development")    -> skill "cordis-plugin-development" is unknown or no longer available
skill("agent-experience")             -> same
skill("cordis-composition-reference") -> same
skill("editing-cordis-compositions")  -> same
skill("find-skills")                  -> same   (~/.agents/skills/find-skills, valid front matter)
skill("human-writing")                -> same   (~/.agents/skills/human-writing)
skill("technical-writing")            -> same   (~/.agents/skills/technical-writing)
skill("office-docx")                  -> loads  (different provider)
```

3. Confirm the preset mounted. The session's `request/header` tool list holds exactly three tools
   more than a `standard` session: 70 against 67, with `cordis_inspect_list`,
   `cordis_inspect_query` and `plugin_manager` added, and nothing lost. Both introspection tools
   return live data.

4. Confirm the host row is off and the preset's row is the only one. This comes from the plugin
   manager's plugin list, which reads the live Loader tree:

```json
{"entryId":"include:skill-filesystem","moduleName":"@deepseek-ai/dsh-skill-filesystem",
 "enabled":false,"fiberPhase":null,"patchId":"skill-filesystem"}
{"entryId":"include:tool-skill","moduleName":"@deepseek-ai/dsh-tool-skill",
 "enabled":false,"fiberPhase":null,"patchId":"tool-skill"}
```

`include:skill` itself is `active`. The preset mounts `tool-skill` and `skill-filesystem` in its own
tree, which is why the `skill` tool still works.

## Evidence

The file service cannot read inside the archive. Each row was run from the affected session through
the harness's own read path.

| Path | Result |
|---|---|
| `.../app.asar/dsh/node_modules/pako/package.json` | `Error: Cannot mix BigInt and other types, use explicit conversions` |
| `.../app.asar.unpacked/dsh/node_modules/pako/package.json`, the same file | reads normally |
| `.../app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/agent-experience/SKILL.md` | same `TypeError` |
| `.../app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills`, the configured root | same `TypeError` |
| `~/.dsh/profiles/desktop/package.json` | reads normally |
| `~/.dsh/skills/definitely-missing/SKILL.md` | clean `not found` |

Three of those rows are controls. A real path outside the workspace reads, a missing real path is
reported as absent instead of throwing, and the identical file under the unpacked mirror reads
normally. The failure follows the archive, not the file.

Walking the entries the archive's directory declares puts the skills at
`dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills`: four skills, 17 files, 75,371 bytes. A walk
of the app bundle, `~/.dsh` and the project trees found no unpacked mirror of that package, and one
unrelated copy in this workspace's own `node_modules`, installed as a dependency of
`@deepseek-ai/dsh`.

The shipped preset sets the path, and the web app layer disables the host row:

```yaml
# bundle/web-app/presets/cordis.patch.yml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js ...createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')... + '/skills'

# bundle/web-app/cordis.patch.yml
# ... Only the per-agent rows move behind presets: the base host `skill-filesystem` row is
# disabled here (presets own local discovery), and `tool-skill` is what a preset mounts ...
- id: skill-filesystem
  disabled: true
- id: tool-skill
  disabled: true
```

Neither end of the failure path has a guard. In `skill-filesystem`, `roots()` pushes
`customSkillDirs` ahead of the user and bundled roots, and `discoverRoot` awaits each root without a
`try`, so one rejection ends `list()`. In `SkillRegistry.listLayerCandidates`, a provider that
throws is dropped for that read:

```js
try {
	output = await waitWithAbort(provider.list(options), options.signal);
} catch (error) {
	if (options.signal?.aborted === true) throw toError(options.signal.reason);
	cacheable = false;
	this.ctx.logger.warn(`skill provider "${provider.name}" skipped: ${errorMessage(error)}`);
}
```

An observation marked incomplete still contributes its candidates, so the existing incomplete
channel is enough to keep the readable roots. Only a thrown provider contributes nothing.

That warning is the only trace, and it does not reach the user. This is the same shape as #8633
("Host plugin failures are invisible in `dsh web`"). The `skill` tool's description tells the model
that a session skill catalog exists and that names come from it, so a shrunken catalog produces
nothing but "unknown or no longer available".

## Impact

Any Desktop install on this version that selects the preset. The preset and the path both ship with
the app, and the Desktop archive layout is what the bundled skill's own text describes. The loss
reaches past the row that causes it: user skills in the standard roots stop resolving too.

## Proposed fix

1. Guard the roots instead of the provider. In `discoverRoot`, skip a root that cannot be read, mark
   the observation incomplete and keep the readable roots. A provider observation already carries a
   `complete` flag, and today only a watcher failure sets it. As written, one bad entry in
   `customSkillDirs` costs a user every local skill.
2. Stop handing out a path the same file service cannot open. Either teach the host file service the
   archive read that the shipped skill documentation assumes, or resolve the preset's bundled skills
   directory to something readable, such as the unpacked mirror or a directory the installer writes.
3. Surface the skip. A provider dropped from a read should appear somewhere a user will see it, in
   the session or on the plugin status surface, rather than in one host log line.

## Verification

Verified in the affected session on macOS, Desktop `0.2.0-rc.2`, preset `cordis`: every `skill` call
above; every file read above with its controls; the archive walk; the live plugin listing that shows
the host row disabled; the preset declaration, the disabling patch and the code paths quoted. All
were read from the installed bundle or run in that session.

Three things were not verified.

The `skill provider "filesystem" skipped:` line was never observed. The Desktop app does not show
host logger output to the user or the agent. That this provider throws on its single configured root
follows from the file service measurements and the unguarded `discoverRoot`; the skip itself is read
from `SkillRegistry`.

No source checkout was tested, so whether this reproduces where the preset resolves to a real
directory is unknown. The bundled skill's text implies it does not.

Whether the previous preset was affected is also unknown. A preset is fixed at session start, and no
session log records the catalog, so the failure cannot be re-queried after the fact.
