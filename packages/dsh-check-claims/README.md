# dsh-check-claims

One tool: `check_claims`. It turns a countable claim into a command whose answer you cannot misread.

```jsonc
{
  "checks": [
    // Does the shipped source really register 30 prompt sections?
    { "pattern": "\\w+\\.systemPrompt\\.section\\(\\{", "path": "packages", "expect": 30 },

    // Is the network fence genuinely absent upstream, as opposed to absent from
    // my checkout, which carries a patch?
    { "pattern": "--unshare-net", "path": "packages/sandbox", "at": "origin/master", "expect": 0 },

    // Did the prose I wrote actually land in the file?
    { "pattern": "State the assumption a claim rests on", "path": "src/blocks.ts", "atLeast": 1 }
  ]
}
```

## Why it exists

Four unmeasured assertions reached a public bug report in one session:

| Claim | Reality |
|---|---|
| "every preset-scoped tool is lost" | 25 of 65 |
| "three prompt sections render unguarded" | ten of thirty |
| "no `--unshare-net` anywhere" | true of upstream, false of the tree I searched |
| "the docstring says X" | it does, but it wraps across a line so `grep` missed it |

Each was one command from being caught. The failures were not in knowing how to check but in
checking by hand, and a hand check has three specific ways to lie:

- **A pipeline truncates.** `grep … | head -3` reports three matches and exits 0. The count is gone
  and nothing says so.
- **A pattern cannot match wrapped text.** Prose wraps at 100 columns, so a phrase written as one
  line matches nothing and reads as absent.
- **The tree is not the one the claim is about.** A working tree carrying your own patch answers a
  question about your working tree. The answer looks identical to the one you wanted.

## What it does instead

**The count is exact.** Never truncated, never capped by a preview. Where matches are may be
sampled; how many there are may not.

**A partial scan cannot confirm absence.** When a scan stops at its file limit, an exact
expectation is reported `UNKNOWN` rather than passed, because the unread remainder can only add
matches. A minimum already met still passes, since the count can only grow.

**Nothing examined decides nothing.** A path that does not exist returns `UNKNOWN`, not
`found 0, expected 0`. Counting zero matches in zero files is trivially true and completely
uninformative, and it is the shape a mistyped path takes.

**A revision is read from that revision.** `at` reads through `git show` and `git ls-tree`, so a
claim about upstream is answered by upstream. The report names the source, so `[working tree]` and
`[revision origin/master]` are never confused.

**Scope is in every line, pass or fail.** A passing check still states what was searched.
`PASS` alone would hide the failure this tool exists to catch.

## The verdicts

| | |
|---|---|
| `PASS` | The count matches the expectation, on a complete scan. |
| `FAIL` | It does not. Fix the claim, not the pattern. |
| `UNKNOWN` | Undecidable: no expectation given, a partial scan, nothing examined, an unreadable revision, or a path that failed validation. |

`UNKNOWN` is not a soft failure. It means the check cannot support the claim either way, which is
the honest answer more often than a hand search admits.

## Parameters

| Field | |
|---|---|
| `pattern` | Regular expression source. Required. |
| `path` | File or directory relative to the session workspace. Required. |
| `expect` | Exact match count required. `0` claims absence. |
| `atLeast` | Minimum match count required. |
| `at` | Git revision, such as `origin/master`. Defaults to the working tree. |
| `flags` | Regex flags such as `i` or `s`. `g` is added. |

`pattern` and `at` are embedded in a command line for revision reads, so both are validated against
a character allowlist and refused rather than escaped. `..` is rejected in a path.

## Install

```jsonc
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": { "@l33tdawg/dsh-check-claims": "link:/path/to/this/package" },
  "dsh": { "profile": { "bundles": ["@l33tdawg/dsh-check-claims"] } }
}
```

## Limits

The scan reads files into memory and counts with a JavaScript regex, so it is bounded by
`maxFiles` (20,000) and `maxFileBytes` (2 MB per file). Reaching either bound sets `incomplete`,
which is reported rather than hidden. Binary files and dependency directories are skipped.

A count is not an argument. This checks whether a claim is true of the code, not whether it matters.
