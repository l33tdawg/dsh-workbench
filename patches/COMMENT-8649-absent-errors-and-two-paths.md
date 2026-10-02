Both retractions are right, and the second one holds for a reason other than the one you give. I checked both against the shipped bundle while checking my own claim, and my previous comment turns out to be unproven on exactly this point.

## The absence list swallows `ENOTDIR`, so it cannot be the mechanism

The shipped code confirms your reading of the list:

```js
// lib/index.js:573
return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");

// lib/index.js:576
return isAbsentPathError(error) || hasErrorCode(error, "FS_NOT_FOUND") || hasErrorCode(error, "FS_NOT_DIRECTORY");
```

and both root-entry readers return `[]` on that class (`:624` for the file-service path, `:648` for the Node path). The file-service reader is the one this configuration uses, because a `ctx.fs` is present and the `custom` root is not marked trusted (`:617`).

From there the argument inverts. If the archive root rejected with a plain Node `ENOTDIR`, `listSkillRootEntries` would return an empty array, the loop at `:103` would continue, and ranks 400 and 500 would be scanned. A symlink into `~/.dsh/skills` would then be discovered. The retraction is still correct, because the failure that stops the read is a `TypeError` (`Cannot mix BigInt and other types`), which is not an absence and does propagate out of the loop. But the absence list is evidence against `ENOTDIR` being what kills it, not for it.

## The two paths that can poison the observation are distinguishable

I had collapsed them, and they are not the same failure:

| Where | Code | Effect |
|---|---|---|
| Watch | `:97` `await this.watchManager.observeRoots(roots)` inside `try`/`catch` | catch sets `complete = false`; `list()` returns `{ candidates, complete: false }` and the registry never sees a throw |
| Read | `:103` `for (const root of roots) for (const skill of await discoverRoot(...))`, no per-root guard | rejection ends `list()` entirely and the provider is skipped |

Only the second makes `SkillRegistry` log `skill provider "filesystem" skipped: <error>`, because the registry's `catch` sits around `provider.list()` (dsh-skill `lib/index.js:349-356`). A watcher failure marks the layer non-cacheable and produces no such line. `observeRoots` awaits `Promise.all(pending)` over every root (`:236`), so a single watcher rejection on the archive root would take the whole call down and land in the first row.

That matters for the fix path, and it is where my own comment was wrong. I wrote that the watcher's `stat` rejects on the archive path and that is what marks the observation incomplete. The code cannot tell those apart on its own, and the shipped read-path measurement - the host file service returning a `TypeError`, not an absence - points at the read row instead: rank 300 throws, the loop dies, the provider is skipped, `complete` is irrelevant because nothing is returned at all. I am not going to assert it either way now, because both paths lead to a provider that contributes nothing.

## The line that discriminates, and one experiment

The report lists `skill provider "filesystem" skipped: <error>` under "not verified" because Desktop shows no host logger output. If you can see the devtools console, that line is decisive and its error text names the path: present, and the throw is the read loop; absent while the catalog is still missing, and the watcher is the one reporting incomplete.

You can also separate them without logs: mount `skill-filesystem` a second time with `watch: false` (schema default is `true`, `:37`; consumed at `:494`) and the same `customSkillDirs`. If the throw persists with watching off, the read path owns it. If it disappears, the watcher does. No capture needed, and it settles a question that neither of us can settle by reading.

## On the second symptom

I agree with leaving it alone. One provider being skipped explains an empty directory and nothing more, and it cannot explain a catalog that stays missing after the first cause is bypassed. That is still open in the report, and it is the part a maintainer needs to answer rather than either of us.
