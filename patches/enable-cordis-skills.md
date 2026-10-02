# Restoring the `cordis` preset's bundled skills

| | |
|---|---|
| **Measured** | 2026-10-02, DSH Desktop `0.2.0-rc.2`, session `9292c643-2ef0-44ba-a14a-1c4f01ac517f` for the defect, the session the fix was applied from for the verification; profile `desktop`, preset `cordis` |
| **Applied** | yes, 2026-10-02 17:33 local. Row `skill-filesystem-pack` present, note rewritten; backup `cordis.patch.yml.bak-cordisskills-20261002093357` |
| **Verified** | the same day, in the session the edit was made from: all four skills returned their bodies, plus `~/.agents/skills/technical-writing`. See *Verification* |
| **Applier** | [`enable-cordis-skills.mjs`](enable-cordis-skills.mjs), anchor-asserting, with `--check` and `--revert` |
| **Vendored by** | [`cordis-skills-sync.mjs`](cordis-skills-sync.mjs), which extracts the same files from `app.asar` or verifies them |
| **Upstream** | filed as [discussion #8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649); the body lives in [`BUG-REPORT-asar-skill-roots.md`](BUG-REPORT-asar-skill-roots.md) |

## What breaks

Selecting the `cordis` agent preset adds three rows over `standard`. The two tool rows work. The
skills row does not, and it takes every other filesystem skill with it.

```
skill("agent-experience")              -> skill "agent-experience" is unknown or no longer available
skill("cordis-composition-reference")  -> same
skill("cordis-plugin-development")     -> same
skill("editing-cordis-compositions")   -> same
skill("find-skills")                   -> same   (~/.agents/skills, pre-existing)
skill("human-writing")                 -> same   (~/.agents/skills, pre-existing)
skill("technical-writing")             -> same   (~/.agents/skills, pre-existing)
skill("office-docx")                   -> loads  (@deepseek-ai/dsh-skill-office, another provider)
```

The tool surface is correct. A `request/header` diff against a `standard` session (`e7ad4e0f`) is
three additions and no losses, 70 tools against 67: `cordis_inspect_list`, `cordis_inspect_query`
and `plugin_manager`. Both introspection tools answer with live data.

## Why

`bundle/web-app/cordis.patch.yml` disables the host `skill-filesystem` row on purpose, so that
presets own local discovery. It says so in a comment:

> Only the per-agent rows move behind presets: the base host `skill-filesystem` row is disabled here
> (presets own local discovery), and `tool-skill` is what a preset mounts to give its agent the
> catalog and loader at all.

The live tree agrees. From the plugin manager's plugin list:

```json
{"entryId":"include:skill-filesystem","moduleName":"@deepseek-ai/dsh-skill-filesystem",
 "enabled":false,"fiberPhase":null,"patchId":"skill-filesystem"}
{"entryId":"include:tool-skill","moduleName":"@deepseek-ai/dsh-tool-skill",
 "enabled":false,"fiberPhase":null,"patchId":"tool-skill"}
```

`include:skill` itself is `active`, and the `skill` tool works because the preset mounts `tool-skill`
in its own tree. The same preset mounts `skill-filesystem` there with `customSkillDirs` pointing at
`@deepseek-ai/dsh-agent-preset/skills`. In Desktop that package lives inside `app.asar`, and this
harness's file service cannot read there:

| Path | Result |
|---|---|
| `app.asar/dsh/node_modules/pako/package.json` | `Error: Cannot mix BigInt and other types, use explicit conversions` |
| `app.asar.unpacked/dsh/node_modules/pako/package.json`, the same file | reads normally |
| `app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills` | same `TypeError` |
| `~/.dsh/profiles/desktop/package.json` | reads normally |
| `~/.dsh/skills/definitely-missing/SKILL.md` | clean `not found` |

The error is a `TypeError`, not an absence, so `discoverRoot` does not skip that root: it awaits each
root without a guard, the rejection ends the provider's whole `list()`, and `SkillRegistry` drops the
provider for that read. `customSkillDirs` is scanned before the default roots, so the project's
`.dsh/skills`, `~/.dsh/skills` and `~/.agents/skills` go with it. The service keeps providers that
work, which is why the office skills survive.

Everything above was run in the affected session or read from the installed bundle. The one step not
observed directly is the `skill provider "filesystem" skipped:` warning itself, because the Desktop
app does not show host logger output. That the provider throws follows from the file service
measurements and the unguarded `discoverRoot`.

## The fix

The applier appends one loader patch entry to the profile layer:

```yaml
- insert:
    - id: skill-filesystem-pack
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: filesystem-pack
        includeDefaultRoots: true
        customSkillDirs:
          - /Users/l33tdawg/nodejs-projects/dsh-workspace-mcp/patches/cordis-skills
```

A host row registers into the skill registry's global layer, which the web app comment names as the
place for deployment-level providers, while the preset's row registers into that preset's layer. The
skills service merges both, so this row supplies the catalog whatever the preset's row does. That is
why the fix is a second provider rather than an override of the preset's row: an override would have
to reach into a detached preset tree, which nothing here has tested, and would leave the catalog
dependent on that one row.

Two details in the config are deliberate. `providerName` is distinct because the provider registry
rejects a duplicate name inside one layer, and the outcome of two rows named `filesystem` meeting is
not worth discovering at boot. `includeDefaultRoots` is the schema default, stated so the intent
survives a default change; it is what brings the project and `~/.agents` skills back.

The four skills are vendored into [`cordis-skills/`](cordis-skills/) because no agent-facing file
operation can read them from the archive. They match both on-disk sources of
`@deepseek-ai/dsh-agent-preset@0.2.0-rc.2`: the copy inside `app.asar`, and the one installed at
`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset` (17 files, 75,371 bytes,
`diff -r` clean against both).

The same script rewrites the profile note that says to restore the commented
`agent-preset-registry` block once a real session has checked the preset. That check has happened,
and restoring the block would now break things: the settings row already selects the preset, and a
second live `agent-preset-registry` row makes `enable-cordis-preset.mjs` refuse its own anchor
assertion ("expected exactly one live agent-preset-registry row"). The note is rewritten with the
measurement rather than deleted, so the next reader does not re-add the block.

## Operating it

Editing a profile while DSH runs is the confirmed trigger for the profile-reload defect
([discussion #8635](https://github.com/deepseek-ai/deepseek-harness/discussions/8635)), which strands
a live session's preset-scoped tools until a restart. Both scripts refuse while DSH looks like it is
running.

```sh
# with DSH quit
node patches/cordis-skills-sync.mjs --check      # does the vendored copy still match the archive?
node patches/enable-cordis-skills.mjs --check    # what would change?
node patches/enable-cordis-skills.mjs            # insert the row, rewrite the note
node patches/enable-cordis-skills.mjs --revert   # undo both
node patches/enable-cordis-skills.mjs --force    # accept the #8635 hazard
```

The row took effect without a restart: the run above mounted it in the live session, and loading all
four skills plus `~/.agents/skills/technical-writing` returned their bodies immediately. That is
what the verification below records. The #8635 hazard is therefore not automatic — it did not occur
on this edit — but nothing here establishes when it does, so the quit-first rule stands.

For the same reason, restarting first is optional for this fix rather than required. If the row is
already live, the check that matters is the `skill` call, not a new session.

Refresh the vendored content when DSH is updated:

```sh
node patches/cordis-skills-sync.mjs              # re-extract from the installed archive
node patches/cordis-skills-sync.mjs --check      # exit 1 and list every difference
```

## Verification

| Check | Result |
|---|---|
| `cordis-skills-sync.mjs --check` against `app.asar` | 17 files, 75,371 bytes, byte-identical |
| `diff -r` against the npm-installed copy | identical for all four skill directories |
| Before applying, against the live profile | `row: absent`, `note: stale` — exactly what the applier asserts |
| Applier without `--force` while DSH runs | exit 1, names the #8635 hazard; the denied write left the profile untouched |
| `--check` after applying | `row: present`, `note: verified`, `already in the requested state`, exit 0 |
| `--revert --force` on a copy of the applied profile | reproduces the backup byte for byte (`cmp` clean) |
| `yaml` re-parse of the patched layer | array, one row, `customSkillDirs` intact |
| `skill` in the live session, after the row mounted | all four bundled skills returned their bodies; `technical-writing` returned its body from `~/.agents/skills` |
| `plugin_manager` `list_plugins` after the edit | tree intact, 193 entries, no tool loss |
| `npm test` / `npm run typecheck` | 51 tests pass, 9 files parse cleanly |

One documented imperfection: a layer that does not end in a newline gains one, so apply-then-revert
on such a file differs by that single byte. The live profile ends in a newline and round-trips
exactly.

## Not verified

Only the skills were exercised. Nothing calls the row's other behaviour, so what the second provider
costs at boot and whether every one of the four skill directories serves its `references/` files are
both unmeasured. The load above proves the catalog and the loader see the row; it does not prove
every resource under it is reachable.

Whether the four skills survive a DSH restart is also unmeasured. The edit works live, and nothing
in it is session-scoped, but "worked without a restart" and "survives one" are different claims and
only the first has been observed.

The preset's own row stays in place and still logs one warning per catalog read. Removing it needs
either a working override into the preset tree or an upstream fix.

Whether the `standard` preset was ever affected is unknown. A preset is fixed at session start, and
no session log records the catalog, so old sessions cannot be re-queried for it.
