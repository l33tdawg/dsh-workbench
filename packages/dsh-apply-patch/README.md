# @l33tdawg/dsh-apply-patch

A multi-file, all-or-nothing patch tool for DeepSeek Harness.

## Why

DSH's `edit` tool replaces one literal string in one file per call. A coherent change spanning five
files therefore costs five calls and five confirmations, and there is no rename primitive at all:
`git mv` through the shell is the only option, and it bypasses the filesystem version guard
entirely.

Codex has `apply_patch`: one call, many hunks, many files, plus renames. This plugin brings that
expressiveness to DSH **without** Codex's failure modes, because several of them are real.

### What this tool does differently from Codex's `apply_patch`

| | Codex `apply_patch` | This tool |
|---|---|---|
| A hunk matching several identical sites | Takes the first match, silently (`file_update.rs:87-113`; pinned by `tool.rs:193-198`) | **Refused**, listing the candidate lines |
| `*** Add File` onto an existing file | Silently overwrites (`tool.rs:348-364`) | **Refused** |
| A hunk that fails partway | Earlier files stay changed (`lib.rs:504+`; scenario `015`) | **Nothing is written**; the whole patch is resolved first |
| Whitespace and punctuation drift | Four-rung tolerance ladder | Same ladder, kept |
| Concurrent modification | Re-derives content with no version check (`lib.rs:609-616`) | Goes through `ctx.fs`, so the version CAS applies |
| Write durability | `set_len(0)` then `write_all`, no fsync (`no_follow/unix.rs:135-141`) | Harness temp-file + fsync + rename |
| Rename | `*** Move to:` | **Not supported**; see below |

The trade is deliberate. Codex optimises for *expressing* a change. This optimises for
*guaranteeing* one.

## Format

```
*** Begin Patch
*** Add File: docs/new.md
+# Title
+
+Body.
*** Update File: src/app.ts
@@ export function greet() {
-console.log('hi')
+console.log('hello')
*** Update File: src/util.ts
@@
-export const answer = 41
+export const answer = 42
*** End Patch
```

Sections, in the order the parser accepts them:

- `*** Add File: <path>` creates a file. Every following line must start with `+`.
- `*** Delete File: <path>` is parsed, then **refused**; see below.
- `*** Update File: <path>` patches in place. Followed by one or more hunks:
  - `@@` or `@@ <header>` opens a hunk. The header is context for you, not for matching.
  - ` <text>` is context, `-<text>` removes, `+<text>` adds.
  - `*** End of File` anchors the hunk at the end of the file.
- `*** Move to: <path>` is parsed, then **refused**; see below.

Markers tolerate surrounding whitespace, because a model reproducing a format from a prompt
occasionally pads a line.

## Matching

A hunk says where it goes by quoting surrounding lines. Real patches quote them imperfectly, so
matching descends a ladder and stops at the first rung that finds **exactly one** position at or
after the current cursor:

1. exact
2. ignoring trailing whitespace
3. ignoring leading and trailing whitespace
4. additionally folding typographic dashes and quotes to ASCII

Two properties follow, and they are the point of the design:

- **Tolerance.** A patch written against slightly different whitespace still applies.
- **Uniqueness.** A rung that matches more than one position is rejected, not guessed at. The error
  names the candidate lines so you can add discriminating context.

Because ambiguity is judged *at or after the cursor*, a block that legitimately appears twice can
still be targeted by two successive hunks: the first advances the cursor past itself.

When a hunk applies only under a lenient rung, the tool result says so. Applying is not the same as
applying where you meant, and you are the only actor who can check that.

## Atomicity

The whole patch is parsed and every resulting file body computed before the first byte is written.
A patch that fails on its fourth file leaves all four untouched.

This is all-or-nothing for *validation*. A write that fails mid-sequence for an environmental
reason (disk full, permissions) may leave a prefix of the files written; the error names exactly
which files landed.

## Deletion and rename are not supported

The harness `fs` service exposes no remove operation, only `readText`, `writeText` and `editText`.

Both operations need one. `*** Delete File` obviously does. So does `*** Move to:`: writing the
destination alone would leave the source in place, producing a **silent copy where a rename was
asked for**. That is exactly the class of quiet wrong answer this tool exists to avoid.

Rather than fake either, the tool refuses both and names the alternative:

```
this tool cannot delete <path>: the harness filesystem service exposes no remove operation.
Delete it with the bash tool instead (`rm -- <path>`), then continue editing.
```

```
this tool cannot move <path> to <dest>: the harness filesystem service exposes no remove operation,
so a rename would leave the original behind.
Move it with the bash tool instead (`mv -- <path> <dest>`), then patch it.
```

Closing this properly means adding a `removeText` to the `fs` seam. That is a small upstream
change, not a plugin workaround. Until then, **a patch schema that advertises `Move to:` would be lying**,
so the prompt guidance and the documentation both say it is unavailable.

## Install

```json
{
  "dependencies": {
    "@l33tdawg/dsh-apply-patch": "link:/path/to/packages/dsh-apply-patch"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@l33tdawg/dsh-apply-patch"
      ]
    }
  }
}
```

Peer dependencies (`dsh-fs`, `dsh-tool-fs`, `dsh-tools`) resolve from the running installation, as
they do for any DSH plugin.

## Integration

Every read and write goes through `ctx.fs`, so this tool inherits the same guarantees as `write`
and `edit`:

- the sandbox fence, with the same `sandbox_permissions` escalation fields when a confining backend
  is mounted (it reuses `FsSandboxController` from `@deepseek-ai/dsh-tool-fs`, so escalation behaves
  identically rather than being reimplemented);
- the read-before-edit observation policy;
- the per-target version CAS inside the provider's lock;
- atomic temp-file, fsync, rename writes.

The tool registers a prompt section at `TOOL_EDIT + 1` that appears only when the tool is visible
in the current scope.

## Tests

```sh
npm test
```

67 tests, none of which need a harness boot. The parser, matching ladder and application core are
pure functions over an in-memory file map. Coverage includes every parser rejection, the create /
update / move paths, trailing-newline preservation, the full tolerance ladder, ambiguity refusal
and cursor-based disambiguation, atomicity on late failure, duplicate-path rejection, and the
model-facing result text.

The integration layer (`src/index.ts`) is not covered by these tests: it imports harness packages
that are not installed in this workspace. It is exercised by loading the bundle into a profile.

## Known limitations

- **No deletion and no rename**, as above. Both are blocked on the same missing `fs` operation.
- **No partial-progress report.** Either the patch plans completely or it reports one failure. Codex
  reports how far it got; that is only meaningful because Codex applies as it goes.
- **The integration layer is not unit-tested.** `src/index.ts` imports harness packages that are not
  installed in this workspace, so it is exercised by loading the bundle into a profile rather than
  by `npm test`.
