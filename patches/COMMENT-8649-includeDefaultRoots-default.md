One correction to the YAML side, because it changes what the symptom can tell you: `includeDefaultRoots` is not written in that row, and the schema default is already `true`. So the failure does not establish that the row wrote `false`.

I pulled the shipped bundle out of `app.asar` and verified the extraction against the archive's own `integrity.hash`. The code the Desktop app runs for `0.2.0-rc.2` is byte-identical to `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js`:

```js
// lib/index.js:33
includeDefaultRoots: z.boolean().default(true),

// lib/index.js:76
this.includeDefaultRoots = config.includeDefaultRoots ?? true;
```

The `cordis` preset row writes neither the field nor a `bundledSkillDir`:

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js ...resolve('@deepseek-ai/dsh-agent-preset/package.json')... + '/skills'
```

`standard` ships the same row with no `config` block at all, and neither preset mentions `includeDefaultRoots`. Both were extracted from `dsh-web-app/presets/` in the installed archive and hash-check clean.

That row therefore ran with `includeDefaultRoots: true`, and the project roots and user roots were in the returned list. Rank 300 is scanned, its read throws, and ranks 100, 200, 400 and 500 are never reached — the same mechanism the report already gives, and it is why `~/.agents/skills` went missing while the row never asked for isolation. A row that writes nothing and a row that writes `false` produce the same silence here, so the observed symptom cannot separate them; only the code can, and it says `true`.

Two of your other points hold as written:

- `bundledSkillDir` adds its root at rank 600 independently of `includeDefaultRoots` (`lib/index.js:181`), so yes, it reaches a real directory without unpacking the archive.
- `$DSH_BUNDLED_SKILL_DIR` is the fallback that `includeDefaultRoots: false` removes: it is read only when `bundledSkillDir` is unset (`lib/index.js:84`).

On "rank 300 sits after project roots and before user roots": that ordering holds with `includeDefaultRoots: true`, which is what this row has. Phrased that way it is another point for the default rather than for a written `false`.

One thing to be careful about for whoever reads this next: with `includeDefaultRoots: false` the only roots left are `customSkillDirs` at rank 300 and an explicitly configured `bundledSkillDir` at rank 600, as you describe. In the state we measured, rank 300 sits inside the archive and rank 600 is unset, so the row has exactly one root and that root is the unreadable one.

Agreed on the second symptom being worth keeping separate: a repaired root does not clear it, because the watcher's first `stat` rejects on the archive path before discovery runs, so the observation is incomplete and the publisher refuses. The chain is in the comment above.

For reproducing either side, the extraction detail worth checking: in this asar the file bodies begin at `16 + headerSize + 2`, where `headerSize` is the `UInt32LE` at byte 12. The wrong constant is quiet at first, because a file extracted two bytes early still has exactly its recorded size and starts mid-JSON; the archive's per-file `integrity.hash` catches it, and all four files above match at `+ 2`.
