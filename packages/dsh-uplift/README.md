# @l33tdawg/dsh-uplift

One install for guidance, safer edits, verification before completion, and task continuity.

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

Each row can still be disabled or reconfigured alone from a
later profile layer, because they are ordinary loader rows addressed by id.

## What it mounts

| Row | What it fixes | Package |
|---|---|---|
| `guidance-pack` | A default DSH prompt carries about 1,750 tokens of per-tool one-liners and no cross-cutting discipline. This adds planning, verification, editing constraints, destructive-action rules, and reporting. | [`dsh-guidance-pack`](../dsh-guidance-pack) |
| `apply-patch` | Coherent changes across several files currently cost several calls and several confirmations, and there is no multi-file form at all. This adds one, keeping DSH's uniqueness and staleness guarantees. | [`dsh-apply-patch`](../dsh-apply-patch) |
| `edit-feedback` | An `edit` returns one sentence. The diff is computed and sent to the UI only, so the model reads the file back to find out where its change landed. This returns the diff to the model. | [`dsh-edit-feedback`](../dsh-edit-feedback) |
| `verify-on-edit` | Records every edit, checks pending edits before completion, reports explicit check outcomes and permits one bounded corrective continuation. | [`dsh-verify-on-edit`](../dsh-verify-on-edit) |
| `check-claims` | A count written by eye is wrong in the direction that flatters the author. This turns a countable claim into a command with an exact answer, and can read a named git revision rather than the checkout. | [`dsh-check-claims`](../dsh-check-claims) |
| `compaction-todo` | Restores saved task state once after a compaction. Enables `workflow_context` for a bounded objective, constraints, decisions and remaining checks. | [`dsh-compaction-todo`](../dsh-compaction-todo) |

## Why these changes

They were chosen by measuring what actually goes wrong, not by comparing feature lists. Across 46
recorded sessions and 9,450 tool calls, the largest single source of rework is an agent re-reading a
file it just edited: 189 of 319 undo-class events, 59% of the total. That behaviour is rational —
nothing tells the agent its edit cannot silently misapply, so it checks.

The first attempt at that was prompt text in `guidance-pack` telling the agent not to re-read. The
measurement could not show it working, which is the expected result for the weakest available lever.
`edit-feedback` is the mechanical version, and `verify-on-edit` supplies the other half: the edit now
says where it landed, and a broken check says so while the file is still open.

The original baseline and reasoning are in [`tools/README.md`](../../tools/README.md).
The current regression cases and measurement protocol are in
[`research/RELIABILITY-EVAL.md`](../../research/RELIABILITY-EVAL.md). The verification loop now
retains edits skipped by debounce; a passing earlier check cannot cover a later edit by accident.

## Cost

The bundle adds the guidance prompt, three tool schemas, bounded edit diffs and verification
notices. Checks are debounced during work, with a final check when edits remain pending at a normal
completion boundary. The completion guard can request at most one additional step per turn; it
does not promise that the model will resolve every failure. Saved workflow context is model-authored
task data and grants no new authority.

## What is deliberately not here

- **The introspection preset.** `cordis` gives an agent the harness's own documentation and API
  discovery. It is a preset switch rather than a plugin, and it also grants profile plugin
  installation, so it is a deliberate choice. See
  [`patches/enable-harness-introspection.md`](../../patches/enable-harness-introspection.md).
- **The network fence.** That one is a harness-level change and cannot be a plugin, because a plugin
  cannot add a syscall boundary. A source patch exists and was reported upstream; that is not
  evidence of protection in the installed desktop runtime.
- **Auto-review.** Already built and shipped disabled; enabling it is a profile change.

## Tests

Each package carries its own suite.

```sh
for p in dsh-guidance-pack dsh-apply-patch dsh-edit-feedback dsh-verify-on-edit dsh-check-claims dsh-compaction-todo; do
  (cd ../$p && npm test)
done
```

The hook suites drive the actual plugins against installed DSH message APIs with fake contexts and
shells. They cover deferred final edits, failure reporting, bounded completion and compaction
recovery. A separate local census reads supported session records without uploading transcripts:

```sh
node ../../tools/reliability-census.mjs --json
```
