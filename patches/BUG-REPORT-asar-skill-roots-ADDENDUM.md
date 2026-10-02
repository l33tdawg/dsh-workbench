Confirming this one and adding a second symptom from the same root. The provider does not only lose every skill: it also switches off the model-facing skill catalog entirely, so a `cordis` agent is not told that any skill exists. The two failures need separate fixes, and the second one survives a workaround that repairs the first.

*Posted 2026-10-02 as a comment on [discussion #8649](https://github.com/deepseek-ai/deepseek-harness/discussions/8649#discussioncomment-18713176).*

## The presets differ only in that row

Both presets mount `skill-filesystem` and `tool-skill`. `standard` mounts the row bare, so its roots are the real defaults:

```yaml
# presets/standard.patch.yml
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
```

`cordis` adds the archive-relative custom directory this report names:

```yaml
# presets/cordis.patch.yml
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
            config:
              customSkillDirs:
                - !!js ...resolve('@deepseek-ai/dsh-agent-preset/package.json')... + '/skills'
```

## Why the catalog disappears

The watchdog, not the skill read, is what marks the observation incomplete, and its first step cannot see inside the archive:

1. `@deepseek-ai/dsh-fs-local` `watch()` begins with `const directory = (await this.stat(target, signal))?.type === 'directory'`. On this machine `stat` on the configured path throws `ENOTDIR`, because `app.asar` is a 121 MB file: `statSync` → `ENOTDIR`, `lstatSync` → `ENOTDIR`, `readdirSync` → `ENOTDIR`.
2. That rejection reaches `skill-filesystem` `lib/index.js:97`, `await this.watchManager.observeRoots(roots)`, which sits in a `try` whose `catch` sets `complete = false` for the provider's whole observation. The watcher is on by default (`enabled: config.watch ?? true`, `:494`) and covers every root, `customSkillDirs` included.
3. `:104` then returns `{ candidates, complete: false }` instead of an array. `dsh-skill` `listLayerCandidates` treats an incomplete observation, and a thrown provider, the same way: `cacheable = false` on both paths (`:353` for the throw, `:358` for the incomplete observation).
4. `dsh-skill` `snapshot()` maps that to `{ skills, complete: false }` and caches nothing.
5. `dsh-tool-skill:216` refuses to publish while the snapshot is incomplete (`if (!snapshot.complete) return decision`), and `:227` keeps it silent (`if (!history.published && skills.length === 0) return decision`).

A watcher exists to invalidate a cache. As written it decides whether the discovery result may be published at all, so a directory that cannot be watched is indistinguishable from a directory that cannot be read. `chokidar` itself accepts this path without error, which is what points at the `stat` in front of it rather than at the watcher library.

## The measurement

Every session log on this install carries at most one catalog message, and its presence tracks the preset exactly. Logs were decoded from `~/.dsh/sessions` (the `.jsonl.zstd` files hold many concatenated frames; `zlib.zstdDecompressSync` returns only the first, so each frame is decompressed separately).

| Preset | Sessions | With a catalog message |
|---|---|---|
| `standard` | 42 | 42 |
| `cordis` | 5 | 0 |

The version and preset are the same for all of them, so the only variable left is the row. A fresh `cordis` session created after the archive-relative root was replaced by a readable directory still received no catalog, while `skill` calls in that session resolved every bundled skill and every skill under `~/.agents/skills`. Callability and visibility are independent here, and fixing the first does not fix the second.

## Completeness is merged across the scope chain

`snapshot()` merges the global layer with the viewing agent's preset layer, and one non-cacheable layer makes the whole observation non-cacheable. A provider failure inside a preset therefore suppresses the catalog for every agent viewing that preset, including skills registered by providers that are working. In this install the global layer held a readable provider for those same four skills and the catalog still never appeared.

## Proposed fix

1. Do not let the watcher gate discovery. `observeRoots` should not be able to mark a provider incomplete: call it after the candidates are collected, or contain its failure inside the watcher, so `complete` describes the read.
2. Do not let one provider suppress another's catalog. `dsh-tool-skill` can publish the model-invocable entries of an incomplete snapshot, the same way an incomplete provider observation already contributes its readable candidates (`BUG-REPORT-asar-skill-roots.md`, "An observation marked incomplete still contributes its candidates").
3. Keep the `discoverRoot` guard from item 1 of this report. It addresses the read path; this comment addresses the watch path.

## Not verified

`stat` on the configured path was measured with Node's `fs`, in a shell rather than in the Desktop host process, so whether the host's file service wraps it differently is not established. Everything from `observeRoots` onward is read from the installed bundles for `0.2.0-rc.2`. The `skill provider "filesystem" skipped:` line and the `SkillWatchManager` warning remain unobserved, for the reason this report gives: Desktop shows the user no host logger output.
