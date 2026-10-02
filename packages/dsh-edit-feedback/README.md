# @l33tdawg/dsh-edit-feedback

Show the agent where its edit landed.

## Why

An `edit` in DeepSeek Harness returns one sentence:

```
The file src/app.ts has been updated successfully.
```

That is the whole model-facing result. The diff exists — `edit` computes it with
`computeHunkDiffs` and hands it to `presentationMeta` — but `presentationMeta` is
the *presentation* layer, so the human sees where the change went and the model
does not.

The model's rational response is to read the file back. In this repository's own
measurement of 46 recorded sessions, **`read-after-edit` is 189 of 319
undo-class events — 59%, the largest single category by a wide margin**. It is
not a model failure. Nothing in a default session tells the agent that a bad edit
fails loudly instead of applying somewhere unexpected, so it checks.

The prompt-level fix was tried first, in `dsh-guidance-pack`:

> After a successful edit, do not re-read the file to confirm. The call fails if
> it did not apply, so re-reading only spends context.

That is the weakest available lever. This plugin is the mechanical one: the tool
result carries the diff, so there is nothing left to check.

## What it does

It listens on `tools/post-execute` and appends a diff to the result text:

```
The file src/app.ts has been updated successfully.

@@ -11,4 +11,4 @@
   const total = items.length
-  return total / items.length
+  return total / (items.length || 1)
   // guard against an empty list
```

Covered tools: `edit`, `write`, and `apply_patch`. `str_replace_editor` is
deliberately excluded — its result is a single string, so there is no
before/after pair to diff, and a guess would be worse than silence.

A file being **created** is also skipped. There is nothing to compare against,
and the model just supplied that content; echoing it back would spend context to
repeat what the model already wrote.

## Install

```json
{
  "dependencies": {
    "@l33tdawg/dsh-edit-feedback": "link:/path/to/packages/dsh-edit-feedback"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@l33tdawg/dsh-edit-feedback"
      ]
    }
  }
}
```

It is also mounted by `@l33tdawg/dsh-uplift` along with the rest of the
reliability pack.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Whether the feedback is attached at all. |
| `tools` | `['edit', 'write', 'apply_patch']` | Tools whose results are enriched. |
| `context` | `2` | Unchanged lines kept either side of a change. |
| `maxHunks` | `6` | Most hunks shown before the rest are counted and dropped. |
| `maxLines` | `60` | Most diff lines emitted, hunk headers included. |
| `maxLineLength` | `400` | Longest line echoed before it is clipped. |

Anything past `maxHunks` or `maxLines` is counted and reported rather than
silently dropped:

```
... 3 more hunks and 41 more changed lines not shown
```

**The footer never says "read the file".** Re-reading after an edit is the
behaviour this plugin exists to remove, so recommending it would defeat the
purpose.

## What it deliberately does not do

- **It never fails a call.** The edit already succeeded; only its text changes.
  Any error inside the hook is logged and the result passes through untouched.
- **It never overrides another policy.** A downstream `block` is returned
  unchanged, and content another policy already replaced is extended, not
  discarded.
- **It never touches `value` or `meta`.** The decision replaces `content` only,
  so the filesystem version guard, the session transcript, and the UI's diff card
  are exactly as they were.
- **It does not judge the edit.** No opinion on whether the change was correct,
  only where it landed. Correctness is `dsh-verify-on-edit`'s job.

## Development

```sh
npm test     # 58 tests: the diff, the rendering, the hook, and the real registry
```

The split is deliberate. `src/diff.ts` and `src/report.ts` import nothing from
the harness, so every decision about what the model is shown is testable from a
before/after pair and a config object. `src/index.ts` is the wiring, and it
imports harness packages **as types only** — which means it loads under plain
Node and its hook test runs in the same suite rather than being skipped.

`tests/runtime.test.ts` goes further: it boots the genuine `ToolRuntime`,
registers a tool declaring the same output shape `edit` declares, and calls it
through `ctx.tools.execute`. That is what proves the claim on this page that only
`content` changes — the assertions are that `value` and `meta` still hold exactly
what they held before.

## The prediction

Installing this should cut `read-after-edit` without touching any other counter.
That is measurable with the audit already in this repository:

```sh
node tools/session-audit.mjs --json > after.json
```

If the count does not move, this plugin is not pulling its weight and should be
cut rather than kept because it looks thorough.
