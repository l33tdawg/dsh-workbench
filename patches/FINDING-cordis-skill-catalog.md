# Which gate loses the `cordis` skill catalog

Status: determined from the shipped source, from a reproduction of the failing
call in isolation, from a controlled comparison of the two presets, and from the
live `cordis` session the repair was made for: it publishes the catalog and
serves the four bundled skills from the repaired root.

## Outcome

`@deepseek-ai/dsh-tool-skill` publishes the catalog from `agent/pre-step` behind
three gates (`lib/index.js` in the 0.2.0-rc.2 bundle):

| Gate | Line | Condition | When it fails |
|---|---|---|---|
| 1 | 207 | `ctx.tools.get("skill", agent) === skillTool` | the snapshot is replaced by `{ skills: [], complete: true }` |
| 2 | 216 | `if (!snapshot.complete) return decision` | nothing is published, and nothing says so |
| 3 | 227 | `if (!history.published && skills.length === 0) return decision` | silence until something is published once |

**Gate 2 is the one that blocks this preset.** The chain that reaches it:

1. The `cordis` preset's `skill-filesystem` row declares `customSkillDirs` as
   `.../@deepseek-ai/dsh-agent-preset/skills` resolved through `createRequire`,
   which lands inside `Contents/Resources/app.asar`.
2. That root is a `custom` root, so `skill-filesystem` reads it through the file
   service rather than Node (`lib/index.js:617`, `optionalFileSystem` is
   `ctx.get("fs")` at `:707`).
3. The file service cannot stat anything inside the archive. Under Electron,
   `fs.stat(archivePath, { bigint: true })` returns **Number** stats rather than
   BigInt ones, and `dsh-fs-local`'s `probe()` then evaluates `info.mode & 511n`
   on them (`lib/index.js:239` and `:243`), which throws
   `Cannot mix BigInt and other types, use explicit conversions`.
4. The provider's discovery loop has no per-root guard (`:103`), so that one
   root ends the whole `list()`. The registry catches the rejection, sets
   `cacheable = false` and logs a warning nobody can see (`dsh-skill`
   `lib/index.js:349-356`), so `snapshot()` reports `complete: false`.
5. Gate 2 returns, forever. Gate 3 keeps it silent, because nothing was ever
   published.

The four bundled skills still load by name, because the profile's separate
`skill-filesystem-pack` row serves them from a real directory. That is what made
the two symptoms look like one: callability was restored, visibility was not.

## What rules out the alternatives

**Gate 1.** `ctx.tools.get("skill", agent)` cannot be observed through any
inspect provider: the Host `Tool` provider returns `ctx.tools.schemas(agent)`
(`dsh-tool-cordis/lib/types/providers.js:52`), which carries no registration
identity, and the preset's own tree is invisible to `Config.listConfigs` - a
query by the exact package name returns only the *host* entries
(`include:tool-skill` inactive, `include:skill-filesystem` inactive). What rules
it out instead is the controlled comparison: `standard` and `cordis` mount
`tool-skill` through the identical preset mechanism, and 42 of 42 `standard`
sessions publish a catalog. The only row difference that decides `complete` is
the filesystem row's `customSkillDirs`. A gate-1 failure would have to be caused
by something the two presets do not differ in.

**Gate 3.** It cannot fire while any skill resolves: the catalog refuses only
when nothing has been published *and* the filtered list is empty, and
`skill("find-skills")` still returns a body in a `cordis` session.

**The watcher.** The addendum's second comment retracted blaming
`observeRoots`, and the code says why it cannot be to blame at all:
`resolveRootWatchMode` (`dsh-skill-filesystem/lib/index.js:502-537`) swallows
`ENOTDIR` through `isAbsentPathError` and walks up to the nearest existing
directory, then watches that ancestor with `fs.watchFile` on `app.asar` - a real
file. Watching therefore succeeds, the `try`/`catch` at `:96-101` never runs,
and `complete` is still `true` when the read loop starts.

## Measured

*Catalog census over every session log under `~/.dsh/sessions`, 2026-10-02:*

```
skill catalog by preset
  preset                sessions  with catalog  catalogs
  standard                    42            42        47
  cordis                      16             0         0
  (no preset recorded)         6             3         3
```

`cordis` went from 5 to 16 sessions today and the count is still zero. The
census is reproducible with `tools/skill-catalog-census.mjs`; the catalog names
its entries, so the `standard` rows can be read back one by one
(`better-writing, find-skills, human-writing, office-docx, office-pptx,
office-xlsx, technical-writing`).

*The repaired row, live, 2026-10-03:*

Four `cordis` sessions carry a catalog, against zero before it. That count is
still moving, because the remaining `cordis` sessions publish on their next
turn. The first was `session-9796ac8a`, this repository's own session:

```
skill catalog by preset
  preset  sessions  with catalog  catalogs
  cordis        22             4         4
```

Three of the four were created before the repair and had already taken turns
without publishing one, so the change reaches sessions that predate it. The
catalogs name eleven skills, `agent-experience`,
`cordis-composition-reference`, `cordis-plugin-development` and
`editing-cordis-compositions` among them, and each of those four resolves by name
to a body whose base directory is `patches/cordis-skills/<name>`. That half is
not a repeat of the catalog count: the fix retires the `skill-filesystem-pack`
row, the profile now names it once and only in the note that records the
retirement, so the preset's own repaired row is the only provider left that
could have served them.

*The repair needed a relaunch.* `session-3680dd4f` took a turn at 02:09:29Z, 54
minutes after the profile was written at 01:15:24Z, and published nothing. Its
catalog arrives at 04:20:09Z, after the app was relaunched at 04:13Z local (the
Electron singleton lock under
`~/Library/Application Support/@deepseek-ai/dsh-desktop` is re-created per
launch). A profile row's repair does not reach the running composition, which is
the shape #8635 reports.

*The failing call, in isolation:*

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e '
  const fs = require("node:fs")
  const p = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/package.json"
  console.log(fs.statSync(p, { bigint: true }).mode & 511n)'
```

prints `Cannot mix BigInt and other types, use explicit conversions`. The same
expression on `/etc/hosts` prints `420`, and `readdirSync` on a directory inside
the archive works. So the archive is readable; only the bigint stat contract is
broken.

*The profile-layer fix, composed offline:*

`patches/enable-cordis-skill-root.mjs` restates the shipped `preset-cordis`
declaration with that one root replaced, and retires the `skill-filesystem-pack`
row. Applied to a throwaway copy of the desktop profile, `dsh --profile
desktop-dryrun --dump-config` renders the repaired row inside the declaration
(`customSkillDirs: [.../patches/cordis-skills]`), drops the pack row entirely,
keeps the three unrelated overrides that sit between the pack row's drifted
markers, and composes with no duplicate top-level id. `--revert` is
composition-identical to the pristine layer: the restored block lands at the end
of the layer rather than in its drifted position, and `--dump-config` renders
both layouts byte for byte the same.

It was applied to the live desktop profile on 2026-10-03T01:15Z, with the
pre-apply layer kept at `cordis.patch.yml.bak-cordisskillroot-20261003011524`.

## Two patch-layer behaviours worth keeping

Both were measured with `dsh --dump-config` against the copy, and both cost a
session if forgotten:

- **A patch entry reaches only rows that existed before that layer was applied.**
  An `- id: skill-filesystem-pack` / `disabled: true` override in the same layer
  that inserts the row does nothing at all. It works across layers, which is why
  `- id: compaction-todo` / `disabled: false` in the profile does work against a
  row a bundle inserted.
- **Re-inserting the same id in one layer duplicates the id** instead of
  replacing the row, which is the failure `patches/dryrun.sh` calls out as
  aborting a boot. Retirement therefore has to remove the insert.

## What is not proven

`gate 1` has not been observed in-process, because nothing exposes it; the
argument against it is the controlled comparison above. The rest of the finding
now has a live measurement behind it: a `cordis` session composed after the
repair carries the catalog, and the four bundled skills resolve from
`patches/cordis-skills`, which after the pack row's retirement only the preset's
own repaired row can serve.

Posted to discussion 8649 as
[comment 18726436](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18726436),
body kept at [`COMMENT-8649-gate2-live-confirmation.md`](COMMENT-8649-gate2-live-confirmation.md).
It adds the gate, the exact throwing expression in `dsh-fs-local`, the reason the
watcher cannot be the cause, and the live before and after that the earlier
comments left open. The two fixes it asks for were already in the report: a
per-root guard in the discovery loop, and a skipped provider that reports itself
where a user can see it.

The scope of the loss, and why it repeats, was pinned down on 2026-10-05: a
reader supplied the catch site, the reply confirms it and draws the boundary, and
both are archived at
[`COMMENT-8649-catch-scope-and-uncached-snapshot.md`](COMMENT-8649-catch-scope-and-uncached-snapshot.md)
([comment 18754547](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18754547)).
The catch sits inside the per-provider loop (`dsh-skill/lib/index.js:346-356`), so
a throwing provider loses only its own output — the other providers' candidates,
and the layer's runtime skills pushed at `:336-345`, survive into
`collectFresh`, which merges them (`:298-311`). What makes the loss total is
gate 2: `complete: false` returns before the catalog message is built, so those
surviving entries are collected and never published. `collect()` writes its
cache only under `if (result.cacheable)` (`:288-289`) while the hit branch
reports `cacheable: true` (`:272-275`), so an incomplete snapshot is rediscovered
on every request, and a repeated `skipped` warning is a usable signal that the
provider is still throwing. The warning itself is emitted (`:354`) and still
invisible here, because it goes through `ctx.logger`, which is the separate
report [2905](https://github.com/deepseek-ai/deepseek-harness/discussions/2905)
names.
