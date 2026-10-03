# @l33tdawg/dsh-uplift

One install, five fixes for the ways a DSH session makes a capable model look careless.

## Install

```json
{
  "dependencies": {
    "@l33tdawg/dsh-uplift": "link:/path/to/packages/dsh-uplift"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@l33tdawg/dsh-uplift"
      ]
    }
  }
}
```

That is the whole change. Each of the five rows can still be disabled or reconfigured alone from a
later profile layer, because they are ordinary loader rows addressed by id.

## What it mounts

| Row | What it fixes | Package |
|---|---|---|
| `guidance-pack` | A default DSH prompt carries about 1,750 tokens of per-tool one-liners and no cross-cutting discipline. This adds planning, verification, editing constraints, destructive-action rules, and reporting. | [`dsh-guidance-pack`](../dsh-guidance-pack) |
| `apply-patch` | Coherent changes across several files currently cost several calls and several confirmations, and there is no multi-file form at all. This adds one, keeping DSH's uniqueness and staleness guarantees. | [`dsh-apply-patch`](../dsh-apply-patch) |
| `edit-feedback` | An `edit` returns one sentence. The diff is computed and sent to the UI only, so the model reads the file back to find out where its change landed. This returns the diff to the model. | [`dsh-edit-feedback`](../dsh-edit-feedback) |
| `verify-on-edit` | Nothing checks the agent's work. This runs the project's own check after an edit and reports what broke, while the file is still open. | [`dsh-verify-on-edit`](../dsh-verify-on-edit) |
| `check-claims` | A count written by eye is wrong in the direction that flatters the author. This turns a countable claim into a command with an exact answer, and can read a named git revision rather than the checkout. | [`dsh-check-claims`](../dsh-check-claims) |

## Why these five

They were chosen by measuring what actually goes wrong, not by comparing feature lists. Across 46
recorded sessions and 9,450 tool calls, the largest single source of rework is an agent re-reading a
file it just edited: 189 of 319 undo-class events, 59% of the total. That behaviour is rational —
nothing tells the agent its edit cannot silently misapply, so it checks.

The first attempt at that was prompt text in `guidance-pack` telling the agent not to re-read. The
measurement could not show it working, which is the expected result for the weakest available lever.
`edit-feedback` is the mechanical version, and `verify-on-edit` supplies the other half: the edit now
says where it landed, and a broken check says so while the file is still open.

The full baseline and the reasoning are in [`tools/README.md`](../../tools/README.md).

## Cost

Roughly 1,750 tokens of prompt, two extra tool schemas, up to 60 lines of diff per edit, and one
project check per edit burst, debounced. Against that, an agent that can see where its own edit
landed and finds out about its own mistakes while the file is still open.

## What is deliberately not here

- **The introspection preset.** `cordis` gives an agent the harness's own documentation and API
  discovery. It is a preset switch rather than a plugin, and it also grants profile plugin
  installation, so it is a deliberate choice. See
  [`patches/enable-harness-introspection.md`](../../patches/enable-harness-introspection.md).
- **The network fence.** That one is a harness-level change and cannot be a plugin, because a plugin
  cannot add a syscall boundary. It is applied and reported upstream.
- **Auto-review.** Already built and shipped disabled; enabling it is a profile change.

## Tests

Each package carries its own suite.

```sh
for p in dsh-guidance-pack dsh-apply-patch dsh-edit-feedback dsh-verify-on-edit dsh-check-claims; do
  (cd ../$p && npm test)
done
```

281 tests across the five. The `edit-feedback` and `verify-on-edit` hook tests drive the real plugin
against the installed DSH packages with a fake context, so the wiring is covered without a boot.
