# 09 — Guidance pack: draft superseded by the built plugin

This file was the first draft of the guidance pack's prompt text. It has been **superseded** — the
pack is now implemented, tested, and configurable at
[`packages/dsh-guidance-pack`](../../packages/dsh-guidance-pack), with its rationale, block table,
token budget, and deliberate-omission list in that package's
[README](../../packages/dsh-guidance-pack/README.md).

Kept as a pointer rather than deleted so the research trail stays intact.

## What changed between draft and implementation

| Draft | Built |
|---|---|
| 8 blocks | **11 blocks** |
| ~6,150 chars / ~1,540 tok (estimated) | **7,036 chars / 1,759 tok** (measured) |
| Static text | Configurable subset, order, and `extra` text |
| No tests | **19 tests**, including a non-duplication guard |

Three blocks were added after the prompt-engineering and sandbox dives reported, all covering
measured gaps the draft had missed:

- **`destructive`** — target read-back, never a recursive delete at a root or home directory, prefer
  recoverable operations, fresh temp directories. DSH's only coverage of this was one clause in the
  `bash` tool description.
- **`asking`** — explore before asking, and separate discoverable facts from user-owned decisions.
- **`efficiency`** — batch independent reads, narrow before widening a search, avoid unbounded
  blocking commands, don't chain unrelated operations. This one matters more than the draft assumed,
  because the same dive established that DSH serializes shell tool calls (see finding 5 in the
  [uplift plan](../UPLIFT-PLAN.md)).

The token estimate in the draft was also optimistic: estimating from a hand-written table
under-counted by about 14% against the measured render.
