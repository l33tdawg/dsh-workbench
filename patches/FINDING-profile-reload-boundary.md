# What a profile edit does to a running session

Status: settled from the shipped `dsh-hmr` source and its README, and from the durable session logs
of 2026-10-01 to 2026-10-03. No profile write was made to determine it; every number below is read
back from records the harness had already written.

This resolves the contradiction that prompted it. A profile plugin row did hot-reload into running
sessions on 2026-10-02, and a preset-row repair did not reach a running session on 2026-10-03. Both
are the same rule applied to two different layers of the composition.

## The boundary

| What the profile edit changes | Does a running session see it | Evidence |
|---|---|---|
| A row in the root composition (new row, changed row, removed row) | Yes - 2.5-3.0 s after the write, as soon as a session takes its next turn | the first session to turn after each of the two 10-02 installs shows the change at +3.0 s and +2.5 s |
| The ordered `dsh.profile.bundles` list | Yes - it is what makes a newly installed bundle's rows appear | 4 running sessions gained `check_claims`, the first at +2.5 s and the last at +3.9 min, each when it next turned |
| A manifest edit whose bundle list is unchanged | No. `dsh-hmr` returns before reading anything | `refresh()` at `lib/index.js:359` |
| A write whose composed inputs are unchanged | No | `refresh()` at `lib/index.js:368` |
| A preset's own definition (a `preset-*` row) | Not to an agent that is already mounted | 5 `cordis` catalogs in 5 sessions, none before the 04:13:56Z relaunch |
| Anything an already-mounted agent registered from its preset | Not reliably: one reconcile **destroyed** it and later ones left it alone | 4 sessions lost the identical 25 tools, 7 times, 3 s after write #1 below; writes #3 and #4 left every agent intact |

## The code that decides it

`dsh-hmr`'s initialization registers three exact-path watches
(`node_modules/@deepseek-ai/dsh-hmr/lib/index.js:353-376`):

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

Three consequences, all of which the logs show:

1. A patch-file write always reaches `refresh(false)`, so composition is rebuilt. A manifest write
   only matters through the ordered bundles list; installing a dependency without activating its
   bundle is invisible.
2. `reconcileProfilePatches` re-applies the **root Include entry** -
   `entry.update({ config: { ...includeConfig, patches: prepared } })` and then awaits the fibers
   that existed before (`@deepseek-ai/dsh-app-boot/lib/index.js:3481-3488` in the 0.2.0-rc.2 bundle).
   The change lands as an ordinary Loader entry update, which is why root rows re-apply and their
   tools come back.
3. Nothing in that path re-mounts an agent, so nothing in it *re-resolves* the agent's own
   composition either. The agent's scope, the preset it was mounted from and every registration that
   preset made into it are read at mount, which for a resumed session means the next launch. A change
   to them therefore appears only at the next mount - and, as row #1 of the measurements shows, they
   are not guaranteed to survive a reconcile untouched.

The README states the same boundary in one line: "Direct Plugin Manager operations apply without
waiting for file events" and "manifest notifications reload only when the ordered `dsh.profile.bundles`
list changes" (`dsh-hmr/README.md:47`, `:57`). `awaitWriteFinish` defaults to a 2-second stability
window, which is why the measured latencies are 2.5-3.0 s rather than milliseconds.

## Measured

Times are UTC. The host clock is UTC+8, so a file mtime printed by `ls` runs 8 h ahead of the
instants below; the profile's own backup names mix the two conventions, so the mtimes are what the
table uses.

| # | Profile write | Observed in running sessions |
|---|---|---|
| 1 | `cordis.patch.yml` + `package.json`, 06:19:30.955Z (uplift install: three bundles added to the ordered list, plus a profile-layer override of `agent-preset-registry`) | 4 sessions lost the identical **25 tools** at 06:19:33.956Z, 06:20:03.388Z, 06:20:31.135Z and 06:21:15.444Z, each `reason=change`; `Error: unknown tool` follows immediately, and 63 such results land across the two loss events |
| 2 | a second write at about 06:40:52Z (the revert of #1, run outside the harness) | 3 sessions lost the same 25 tools at 06:40:52.240Z, 06:40:52.886Z and 06:41:16.882Z |
| 3 | `cordis.patch.yml` + `package.json`, 08:22:27.974Z (check-claims install: one bundle added to the ordered list) | **4 sessions gained `check_claims`** at 08:22:30.446Z, 08:22:40.179Z, 08:23:01.759Z and 08:26:21.278Z, `reason=change`, nothing lost (66 to 67) |
| 4 | `cordis.patch.yml`, 2026-10-03T01:15:24.145Z (the `preset-cordis` repair) | **No tool-surface change anywhere.** No `cordis` session published a skill catalog for the next 3 h, including `session-3680dd4f`, whose turn ran 02:09:29Z to 03:13:42Z |

Only the first session to turn after a write dates the reload: the later instants in each row are when
each session next ran, not when the change landed. That is also why row 2's write instant is an
inference - three sessions changed within the same second, and the profile files carry no backup from
that write.

Rows 3 and 4 are the contradiction the 8649 comment created, and they are the same mechanism. Row 3
changed what the root composition mounts, so it landed in seconds. Row 4 changed a preset's
definition, which is read when an agent mounts; the catalog it repairs is published per agent on
`agent/pre-step`, from that agent's own provider rows. As of this measurement the corpus holds 55
catalog messages: 50 predate the
relaunch and **none of them is `cordis`** (47 `standard`, 3 with no preset recorded); the 5 that
follow it are all `cordis`, the first at 04:14:06.424Z, 10 s after the Electron profile's
`Session Storage` was rewritten at 04:13:56.330Z. The reload census finds no tool-surface change
anywhere in the corpus after 2026-10-02T08:26:21.278Z.

Rows 1 and 3 also bracket the report's real defect. The same file, written twice in two hours, took
25 tools away once and added one cleanly the other time. So the loss is not a property of "editing the
patch layer"; something about write #1 made the reconcile dispose a scope a live agent was holding. The
one structural difference between them is the shape of the patch entry: #1 introduced a *new*
profile-layer override of an existing host-plane row (`agent-preset-registry`), which the Loader has to
dispose and re-create, while #3 only changed a value in an override row the profile layer already
owned. The README's "Loader commits volatile-only changes in place" (`:57`) is consistent with that
reading but does not establish it, so it stays a hypothesis.

## What this changes in the filed report

- **The third event's attribution does not hold.** It says "editing only `package.json`" mounted
  `check_claims`. That install wrote `package.json` at 08:22:27.974Z and `cordis.patch.yml` at
  08:22:27.977Z, 3 ms apart, and the manifest path alone is gated on the bundles list. A genuinely
  manifest-only install followed in the same profile at 08:52:31Z (`package.json` only, `dsh-edit-feedback`
  added to the bundles list); it added no tool because that bundle contributes none. The corpus
  therefore contains no case of a tool mounting from a manifest edit at all.
- **The trigger is narrower than the patch layer.** Write #3 is a patch-layer edit that was purely
  additive, and write #4 is a patch-layer edit that produced no live effect at all. What the two loss
  events share is a write that creates or removes an override of a host-plane row - write #1
  introduced the `agent-preset-registry` override, write #2 removed it - whereas the two later writes
  only changed a value inside an existing override, or restated a preset declaration.
- **The survivors are not "rows mounted outside the preset".** The shipped layers insert the lost
  tools' rows at the root too: `@deepseek-ai/dsh-base/cordis.patch.yml` inserts 94 rows at top level,
  including `tool-bash`, `tool-fs`, `tool-todo`, `tool-web` and `tool-skill`, and the preset lists
  those ids to select them for its agent. The accurate statement is that the preset's *selection* is
  what dies, and that `mcp-resources` and `subagent` survived it while their neighbours did not. This
  corpus does not explain those two.

## What is not settled

- **What makes a reconcile destructive.** The hypothesis above (a dispose plus re-create of a row the
  agent's scope hangs from) fits every observation but was not tested. The experiment is one profile
  write of each shape against one live session, reading the next `request/header` reason.
- **Whether a new agent mounted after a preset write picks up the new definition before any relaunch.**
  The corpus has no case: `session-9796ac8a` was created 1 m 49 s after write #4 and took its first
  turn after the relaunch. The experiment is to create a session after the write, take one turn, and
  read the catalog.

## Reproducing

```sh
node tools/session-reload-census.mjs --verbose          # the tool-surface changes
node tools/skill-catalog-census.mjs --preset cordis     # the catalog half
```

`session-reload-census.mjs` reads `request/header.tools` per session and reports every consecutive
pair whose tool set differs, with the harness's own `reason` (`initial`, `series`, `resume`,
`change`). A `change` is the observable; the correlate is the profile file's mtime, which is why the
backup copies in the profile directory are the useful second half of the evidence.

## Environment

- DSH `0.2.0-rc.2`, the same install the report was filed against; the archive was read with the
  offsets in [`cordis-skills-sync.mjs`](../patches/cordis-skills-sync.mjs)
- Counts from `~/.dsh/sessions/**/session.v4.jsonl.zstd`
- Profile writes dated by the `cordis.patch.yml.bak-*` / `package.json.bak-*` mtimes in
  `~/.dsh/profiles/desktop`
- Relaunch dated by `~/Library/Application Support/@deepseek-ai/dsh-desktop/Session Storage`
