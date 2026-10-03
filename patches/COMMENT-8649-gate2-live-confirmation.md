Answering my own open question from the last comment. The missing catalog is not a second, unrelated defect: one skipped provider explains it exactly. I got there by changing a single field and watching what happened.

## The gate that blocks is the completeness check

`dsh-tool-skill` decides whether to publish on `agent/pre-step`, behind three conditions (`lib/index.js` in the 0.2.0-rc.2 bundle):

| | Line | Condition |
|---|---|---|
| tool identity | `:207` | `ctx.tools.get("skill", agent) === skillTool` |
| completeness | `:216` | `if (!snapshot.complete) return decision` |
| first publication | `:227` | refuses while nothing has been published and the list is empty |

The middle one is the gate, and it is the only one the intervention touches. I kept the preset, kept `tool-skill`, kept the tool's identity, and replaced just the archive path in the preset's own `skill-filesystem` row (`dsh-web-app/presets/cordis.patch.yml:143-147`) with a real directory holding the same four skills, extracted from the archive. The same change retired the second filesystem provider row I had added earlier as a workaround, so that directory is the only thing left that can serve them.

Before the change: zero catalogs in every recorded `cordis` session, across two days of them. The corpus grew from 5 sessions to 22 and the count stayed at zero, while `standard` held at 42 of 42.

After it: four `cordis` sessions carry a catalog, a count that is still moving as the other sessions take their next turn. Three of those were created hours before the change and had already taken turns without one. The catalog names eleven skills, the four bundled ones among them, and each of those four loads by name from the replacement directory. Nothing else can serve them now, so that is not an inference from the symptom; it is the only provider left in the tree.

One timing note, because it surprised me. The profile edit alone did not reach the running app: a `cordis` session took a turn 54 minutes after the write and still published nothing. The catalogs begin after the app was relaunched. Same shape as #8635: an edit to the profile while the app is running does not reach the preset composition.

## What throws

```js
// dsh-fs-local/lib/index.js:238
async function probe(absolutePath) {
  const info = await probeStats(absolutePath, (path) => stat(path, { bigint: true }));
  // ...
  mode: Number(info.mode & 511n),   // :243
```

Under Electron, `fs.stat(archivePath, { bigint: true })` hands back Number stats, so `& 511n` throws `Cannot mix BigInt and other types, use explicit conversions`. It reproduces outside the app:

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e '
  const fs = require("node:fs")
  console.log(fs.statSync("/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/package.json", { bigint: true }).mode & 511n)'
```

That prints the TypeError. `typeof statSync(archivePath, { bigint: true }).mode` is `"number"`, the same expression on `/etc/hosts` prints `420n`, and `readdirSync` inside the archive works. The archive is readable; the bigint contract is what breaks.

## Why the watcher is not the cause

`resolveRootWatchMode` (`dsh-skill-filesystem/lib/index.js:502`) climbs from the root, swallows absence errors (`:524-527`, the `isAbsentPathError` class that includes `ENOTDIR`) and returns the nearest existing ancestor. For a path inside the archive that ancestor is `Resources/`, with `app.asar` as the next segment, and `app.asar` is a real file. Watching it succeeds. So `observeRoots` never throws, `complete` is still `true` when the read loop starts (`:97-101`), and the failure lands in the loop.

## The chain, in order

1. `discoverRoot` on the archive root goes through the host file service, which throws the TypeError above.
2. The loop at `dsh-skill-filesystem:103` (`for (const root of roots) for (const skill of await discoverRoot(...))`) has no per-root guard, so that one rejection ends `list()`.
3. `SkillRegistry` catches it, sets `cacheable = false`, and logs `skill provider "filesystem" skipped: <error>` (`dsh-skill:351-354`).
4. `snapshot()` returns `complete: collected.cacheable` (`dsh-skill:238`), which is now `false`.
5. `dsh-tool-skill:216` returns, so nothing is ever published, and `:227` keeps it quiet because nothing was published before.

One skipped provider therefore costs both the skills and the catalog, and the catalog is the part that hurts. A skill the model has never been told about may as well not exist; it stays callable only for someone who already knows its name.

## Two things that would have shortened this

The per-root guard the report already asks for, and a skipped provider that says so somewhere a user can see. Today the only trace is a `logger.warn` that Desktop never shows, which is why this arrived as "the whole preset has no skills" rather than "one root is unreadable".

My local repair is a profile patch, not a fix for the shipped preset. `presets/cordis.patch.yml` still points that root inside `app.asar`, so every Desktop install has this by default.
