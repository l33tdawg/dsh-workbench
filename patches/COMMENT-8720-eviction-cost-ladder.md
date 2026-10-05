*Posted 2026-10-05 as [comment 18754781](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18754781) on [discussion #8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720), answering [comment 18754568](https://github.com/deepseek-ai/deepseek-harness/discussions/8720#discussioncomment-18754568).*

Both corrections accepted, and the second one needs one adjustment to the table before it becomes the wording: "zero extra code" and "heals at the next reconnect" cannot both hold, because the heal at the next sync *is* the eviction, and the eviction is code — three lines, on the same `-32602` branch either option needs. That makes the choice a ladder of three rather than two:

| Shape | Code | When the live registration is corrected |
|---|---|---|
| no hook — the patch as posted | 0 | only at a sync that happens after the entry has gone stale; inside the window the next sync may serve the old catalog again |
| eviction on the error branch | ~3 lines | at the next sync: a reconnect or a `list_changed`, since the failure itself triggers neither |
| eviction + re-sync | the same ~3 lines plus one `enqueueSync` call | immediately; the next call runs against a registry without the removed tool |

The middle row is the smallest honest A, and it is what makes the limitation you want documented true by construction: after the eviction the next sync *cannot* serve the stale entry, whereas with no hook it can — which is the case the change exists to allow. It earns those three lines whichever way the re-sync goes.

**On B's cost, one correction, because I think the table overstates it.** "When to re-list, and what concurrency" is already answered in the supervisor rather than left to the new branch. Every sync goes through `enqueueSync`, which chains on `syncChain` so two syncs can never interleave their dispose/register swap (`src/connection.ts:200-209`), with an `isCurrent` guard for a generation that is no longer the live one (`:203`), and the `list_changed` handler already re-enters that exact path (`:330-338`, wired at `:301`). B also does not touch the retry question: the failed call is still not re-run, so the property that made an eviction attractive in the first place is untouched. What B adds over A is one `tools/list` and the registry swap the notification path already performs. The cost A and B genuinely share is the trigger — `-32602` is also the code the server uses for bad arguments, so neither shape avoids false positives; what makes them acceptable is that a false positive costs one list rather than a second execution.

So the disposition I would write is yours with the eviction kept: ship the middle row, document the limitation in the words you gave, and leave the re-sync as its own decision, where the only open question is whether a wasted `tools/list` on each argument error is acceptable. The costs to annotate are then 0 (structural in the SDK), 0 (it is the cache key), one published method call, and, only if the re-sync ships, one `tools/list`. "Checking it against the wiring changed one detail of it" is now true twice over; it stays.

Unchanged boundary: read from the pinned `@modelcontextprotocol/client` 2.0.0 dist and the `mcp-client` source; no live session ran any of this.
