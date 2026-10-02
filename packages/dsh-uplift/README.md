# @l33tdawg/dsh-uplift

One install, three fixes for the ways a DSH session makes a capable model look careless.

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

That is the whole change. Each of the three rows can still be disabled or reconfigured alone from a
later profile layer, because they are ordinary loader rows addressed by id.

## What it mounts

| Row | What it fixes | Package |
|---|---|---|
| `guidance-pack` | A default DSH prompt carries about 1,750 tokens of per-tool one-liners and no cross-cutting discipline. This adds planning, verification, editing constraints, destructive-action rules, and reporting. | [`dsh-guidance-pack`](../dsh-guidance-pack) |
| `apply-patch` | Coherent changes across several files currently cost several calls and several confirmations, and there is no multi-file form at all. This adds one, keeping DSH's uniqueness and staleness guarantees. | [`dsh-apply-patch`](../dsh-apply-patch) |
| `verify-on-edit` | Nothing checks the agent's work. This runs the project's own check after an edit and reports what broke, while the file is still open. | [`dsh-verify-on-edit`](../dsh-verify-on-edit) |

## Why these three

They were chosen by measuring what actually goes wrong, not by comparing feature lists. Across 36
recorded sessions and 6,855 tool calls, the largest single source of rework is an agent re-reading a
file it just edited, at 127 occurrences. That behaviour is rational: nothing tells the agent its edit
cannot silently misapply, so it checks. The guidance pack states the rule, and `verify-on-edit`
supplies the feedback that makes checking unnecessary in the first place.

The full baseline and the reasoning are in [`tools/README.md`](../../tools/README.md).

## Cost

Roughly 1,750 tokens of prompt, one extra tool schema, and one project check per edit burst,
debounced. Against that, an agent that finds out about its own mistakes while the file is still open.

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
for p in dsh-guidance-pack dsh-apply-patch dsh-verify-on-edit; do
  (cd ../$p && npm test)
done
```

155 tests across the three, none requiring a harness boot except the `verify-on-edit` hook test,
which drives the real plugin against the installed DSH packages with a fake shell.
