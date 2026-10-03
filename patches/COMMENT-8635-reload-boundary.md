*Posted 2026-10-03 as [comment 18726817](https://github.com/deepseek-ai/deepseek-harness/discussions/8635#discussioncomment-18726817) on [discussion #8635](https://github.com/deepseek-ai/deepseek-harness/discussions/8635).*

This thread's title is the question, so here is the boundary, measured rather than inferred - and it also explains a result that looked like it contradicted this report.

## What a profile edit reaches

`dsh-hmr` registers three exact-path watches (`@deepseek-ai/dsh-hmr/lib/index.js:353-376` in 0.2.0-rc.2):

```js
const manifestPath = join(profile.dir, "package.json")
const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)]
const refresh = async (manifestOnly) => {
  const bundles = JSON.stringify(readProfileManifest("dsh", profile.dir).dsh?.profile?.bundles ?? [])
  if (manifestOnly && bundles === lastBundles) return
  const inputs = JSON.stringify([bundles, ...patchFiles.map((filename) => readFileSync(filename, "utf8"))])
  if (inputs === lastInputs) return
  const patches = readProfilePatches("dsh", profile)
  const warnings = await reconcileProfilePatches(this.ownerContext.root, patches, "dsh")
  ...
}
for (const filename of patchFiles) await this.watchConfig(filename, () => refresh(false))
await this.watchConfig(manifestPath, () => refresh(true))
```

A patch-file write therefore always recomposes; a `package.json` write matters only through the ordered `dsh.profile.bundles` list; a write whose composed inputs are unchanged is skipped. `reconcileProfilePatches` then re-applies the **root Include entry** - `entry.update({ config: { ...includeConfig, patches: prepared } })`, `@deepseek-ai/dsh-app-boot/lib/index.js:3481-3488` - and awaits the fibers that existed before it.

Nothing in that path re-mounts an agent. An agent's scope, the preset it was mounted from and every registration that preset made into it are resolved at mount, which for a resumed session means the next launch. So the answer depends on which layer the edited row belongs to, and the log agrees:

| Profile write | In running sessions |
|---|---|
| 2026-10-02 06:19:30.955Z, patch + manifest (three bundles added to the ordered list, plus a new profile-layer override of `agent-preset-registry`) | 4 sessions lost the same 25 tools, the first at +3.0 s with `reason=change`; `unknown tool` errors follow immediately |
| 2026-10-02 08:22:27.974Z, patch + manifest (one bundle added) | 4 sessions gained `check_claims`, the first at +2.5 s, nothing lost |
| 2026-10-03 01:15:24.145Z, patch only (a `preset-cordis` override repairing its `customSkillDirs` root) | no tool-surface change in any session, and no `cordis` skill catalog for the next 3 h; the first `cordis` catalog in the corpus arrives 10 s after the app relaunch |

Times are UTC. After the first instant in each row, the others are when each session next took a turn rather than when the change landed.

The two comments above are the reporting half and the detection half of this. What the boundary adds
is when to expect the damage: rows 1 and 2 both create or remove a profile-layer override of a
host-plane row, and rows 3 and 4 - which only changed a value inside an existing override, or
restated a preset's declaration - stranded nothing at all. A detection patch that labels a stranded
reload is more useful with that shape attached, because the transcript cannot tell the four writes
apart today.

## Two corrections to this report

**The third install was not manifest-only.** It names "editing only `package.json` to add a bundle" as the case that mounted a tool cleanly. That install wrote `package.json` at 08:22:27.974Z and `cordis.patch.yml` at 08:22:27.977Z, 3 ms apart, and the manifest path alone is gated on the bundle list. A genuinely manifest-only install followed 30 minutes later in the same profile (`dsh-edit-feedback`, added to the ordered list); it mounted no tool, because that bundle contributes none. So the corpus has no case of a tool mounting from a manifest edit at all, and the correlation with the patch layer survives - but that row does not demonstrate what it says it does.

**The loss is not a property of the patch layer.** The same file, written twice in two hours, took 25 tools away and then added one cleanly. What separates the two writes is the shape of the patch entry, and this is where measurement stops: the destructive write introduced a *new* profile-layer override of an existing host-plane row (`agent-preset-registry`), which the Loader has to dispose and re-create, while the clean one only changed a value in an override row the profile layer already owned ("Loader commits volatile-only changes in place", `dsh-hmr/README.md:57`). If that distinction is the answer, the defect is sharper than the title - a row-level dispose and re-create strands an already-mounted agent's preset scope - and nothing in the transcript says so.

One more correction, because it is the first thing we tried to check against the source: the survivors are not "the tools contributed by profile rows mounted outside the agent preset". `@deepseek-ai/dsh-base/cordis.patch.yml` inserts 94 rows at top level, `tool-bash`, `tool-fs`, `tool-todo`, `tool-web` and `tool-skill` among them, and the preset selects those ids for its agent. What dies is the preset's selection. `mcp-resources` and `subagent` survive it and we could not account for those two from the layers alone.

## What we can hand over

The cheap experiment for the shape question is one profile write of each shape against one live session, reading the next `request/header`'s `reason` (`change` means the surface moved). We can run it if it is wanted. We have not, because the destructive shape costs whatever that session was doing.

Independent of the above, and worth a look on your side: a bundle installed into a profile but never added to `dsh.profile.bundles` is invisible to a running app, and the reload is skipped silently - there is no diagnostic for "your manifest changed and nothing happened".
