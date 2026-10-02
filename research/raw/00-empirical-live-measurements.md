# Empirical findings: measured on the live DSH runtime

These are **first-hand measurements** taken from the running DSH installation, not code
reading. Source: the live session transcript for session `b1dc8ccf-32c4-400f-acdb-d913594d1e0e`,
decompressed from `~/.dsh/sessions/--Users-l33tdawg-nodejs-projects-dsh-workspace-mcp--/session-b1dc8ccf-32c4-400f-acdb-d913594d1e0e/session.v4.jsonl.zstd`.

Method note: the file is a *concatenated multi-frame* zstd stream (145 frames). Node's
`zstdDecompressSync` silently returns only the first frame. Split on the `28 B5 2F FD`
magic and decompress each frame to get the whole 600 KB / 255-record transcript.

Comparison revision pins:
- DSH `639ed015397290b3745d163aafe02ffee4aa3f84` (v0.2.0-rc.2)
- Codex `2abb02bc004fe2847d1f99f47610c92d1744b22d`

---

## 1. System prompt: DSH is ~4x smaller than Codex

Measured from the live `system/message` record.

| | bytes | ~tokens (÷4) |
|---|---|---|
| **DSH assembled system prompt (total)** | **7,001** | **~1,750** |
| Codex `protocol/src/prompts/base_instructions/default.md` | 20,903 | ~5,225 |
| Codex `core/gpt-5.2-codex_prompt.md` | 7,589 | ~1,900 |
| Codex selected permissions template (1 of 7) | ~200–3,700 | ~50–900 |
| **Codex assembled base (approx)** | **~30,500** | **~7,600** |

DSH's 7,001 bytes are almost entirely **per-tool one-liners**. The harness-owned identity is a
single sentence (`packages/core/system-prompt/src/index.ts:429`):

> `You are an AI agent powered by DeepSeek Harness.`

and the desktop/web deployment persona is two sentences
(`packages/bundle/web-app/cordis.patch.yml:19-21`):

> `You are a coding agent powered by the {{model}} model.`
> `Your working directory is {{cwd}}.`

Everything else in the prompt is tool-specific fragments registered by individual tool packages
at fixed orders (`SECTION_ORDERS`, `packages/core/system-prompt/src/index.ts:125-159`).

**What is therefore absent from a normal DSH session prompt** (all present in Codex's base
instructions, with line cites): planning/todo discipline (`default.md:62-121`, 60 lines of
good-vs-bad plan examples), task-execution persistence. *"keep going until the query is
completely resolved, before ending your turn"* (`default.md:125`), validation philosophy
(`default.md:149-163`), ambition-vs-precision (`default.md:165-171`), progress-preamble
discipline (`default.md:73-99`), final-message formatting contract (`default.md:193-256`),
editing constraints. ASCII default, comment restraint, git safety, never revert user changes
(`gpt-5.2-codex_prompt.md:9-19`), review mindset (`gpt-5.2-codex_prompt.md:31`), and frontend
anti-slop guidance (`gpt-5.2-codex_prompt.md:33-43`).

**Verdict: this is a coverage gap, not a quality gap.** Where DSH does write prompt guidance it is
excellent, the plan-mode policy (`packages/bundle/base/cordis.patch.yml:325-334`) is arguably
better than Codex's equivalent. It just isn't there for the other 90% of the work.

## 2. Tool schemas cost 8.5x the system prompt

Measured from the live `request/header` record.

| | count | bytes | ~tokens |
|---|---|---|---|
| MCP tools (`mcp__sage__*`) | 35 | 37,302 | **~9,326** |
| Native DSH tools | 30 | 22,229 | **~5,557** |
| **Total, sent on every request** | **65** | **59,531** | **~14,883** |

The three most expensive single schemas are `mcp__sage__sage_inbox` (3,892 B),
`workflow` (3,389 B) and `mcp__sage__sage_task` (2,384 B).

So DSH spends **~14.9k tokens on tool definitions against a ~1.75k-token system prompt**. Codex
instead models tool exposure explicitly: `ToolExposure::Hidden` and `is_deferred()`
(`codex-rs/core/src/tools/registry.rs:410-413`), plus a native `tool_search` tool and
`ToolSpec::ToolSearch` / `ToolSpec::Namespace` variants
(`codex-rs/core/src/tools/tool_namespaces_info.rs:26-45`). Deferred tools are *not* in the
request; the model searches for them.

This is the single largest context-economy gap found, and it is structural.

## 3. Parallel tool calls: DSH serializes shell, edit, and MCP work

**This entry corrects an earlier version of this document.** My first pass measured
wall-clock span against summed duration per step and concluded "DSH executes independent tool calls
concurrently". That was wrong: I generalised from two steps whose overlap came from `subagent`
fan-out. Breaking the same data down by tool name shows the real rule.

```
step n tools span(ms) sumIndividual(ms) overlap
1:11 4 subagent 61 227 YES
1:12 4 subagent 58 229 YES
1:4 2 bash 28829 28828 no
1:9 2 bash 3896 3896 no
1:18 2 read,bash 216 216 no
1:1 2 bash 41 41 no
```

Every batch containing `bash` has **span == sum of individual durations**, strictly serial, with
no overlap at all. Only the two all-`subagent` batches overlap.

This matches the code: `packages/core/agent-loop/src/tool-calls.ts:85-100` groups by execution mode
and takes one call at a time when the mode is not `parallel`; the predicate is
`packages/core/tools/src/index.ts:1303-1313`, where only an exact `true` from
`isConcurrencySafe(args)` is parallel and everything else fails closed. The tools that opt in are
`read`, `read-image`, web search, web fetch, the three session-query tools, and `subagent`.
`bash`, persistent bash, pwsh, `write`, `edit`, **all MCP-bridged tools**, and `run_code` are
exclusive.

Codex marks `exec_command` and `write_stdin` parallel-safe
(`codex-rs/core/src/tools/parallel.rs:126-128`, `:45-47`) and gates on one `RwLock` per sampling
request (`:42-48`, `:155-159`), so the latency-dominant case overlaps there and does not here.

**Measured cost in this session: 1,005 ms recoverable out of 35,962 ms of tool time (3%).** That
is small only because my commands were mostly fast (20-70 ms); the worst single batch was 28.8 s of
two calls. The exposure is structural, not incidental: a batch of long independent commands
(a test run plus a build plus a status check) pays the full sum here and only the maximum in Codex.
16 of 30 steps issued multi-call `bash` batches, all serialized.


## 4. Tool-selection prompt adherence: good: hypothesis falsified

DSH's prompt says *"Use the read tool. Not shell commands like cat"*, *"Use the glob tool, not
shell find"*, *"Use the grep tool, not shell grep or rg"*. Counting true violations across all
44 `bash` calls in the session (`/tmp/adherence.js`):

- `cat`/`head`/`tail` of a file: **1** (bundled with an `env` dump)
- standalone `grep`/`rg`: **0**
- standalone `find`: **1** (and it searched for *directories*, which `glob` cannot do, arguably correct)

**2 true violations in 44 calls (5%).** The one-liner prompt fragments DSH does ship are
adhered to. This reinforces finding #1: the problem is *missing* guidance, not ignored guidance.

## 5. LLM auto-review already exists in DSH but ships switched off

Codex's `guardian` crate decides `on-request` approvals automatically: it rebuilds a compact
transcript, asks a dedicated review session for strict JSON, fails closed on timeout/malformed
output, and applies an explicit allow/deny (`codex-rs/core/src/guardian/mod.rs:1-20`, files
`policy.md`, `prompt.rs`, `review.rs`, `approval_request.rs`, ~250 KB of implementation+tests).

DSH has the equivalent: `packages/experimental/auto-review`. *"Before each native or PTC inner
tool call, the current agent's provider and model assess the pending action; an allowed call
executes with Full access, and a denied call asks the user."* It classifies effects into
low/medium/high risk, denies ambiguous effects, and fails calls closed on malformed reviewer
responses.

**But** `packages/experimental/auto-review/cordis.patch.yml` is a bare self-insert and
`grep -rn "auto-review" packages/bundle/*/cordis.patch.yml` returns nothing. **no bundle mounts
it.** The README states plainly: *"The dsh installation ships this layer switched off."*

This is a capability DSH already has, disabled by default. Enabling it is a one-line profile
insert, not a harness change.

## 6. No `apply_patch`-equivalent multi-file atomic edit

`grep -rln "apply_patch" packages/` matches only a client presentation file. DSH's edit surface is
`read`/`write`/`edit` (`packages/fs/tool-fs`) or the alternative `str_replace_editor`
(`packages/fs/tool-str-replace-editor`), both **single-file, single-replacement**.

Two consequences visible in `packages/fs/tool-fs/src/edit.ts`:
- One literal replacement per call, unique-match enforced (`:91`), `replace_all` as the only
 bulk option. A coherent change spanning 5 files costs 5 round-trips.
- The model-facing result is only `"The file X has been updated successfully."` (`:64-68`, `:104-107`).
 The computed diff exists but goes to `presentationMeta` for the UI only (`:108-111`), so the
 model gets no structural confirmation of *where* the edit landed.

Codex's `apply-patch` is a whole crate with its own grammar and tests, supporting multi-file
Add/Delete/Update in one atomic call, plus explicit prompt instructions to use it
(`gpt_5_codex_prompt.md:132`, `gpt-5.2-codex_prompt.md:11`).

## 7. Plan/todo guidance exists only inside plan mode

`packages/todo/tool-todo/src/index.ts` registers **no system-prompt section at all**
(`grep -c systemPrompt` → 0). And `plan:policy` renders only while plan mode is active, it
returns `''` otherwise (`packages/plan/plan-mode/src/index.ts:220-224`), and the plan-mode text
explicitly says *"Do not use todo_write to track this planning phase"*.

So in an ordinary (non-plan) DSH session there is **zero prompt-level instruction about when to
plan, when to use `todo_write`, or what makes a good plan**, the model sees only the tool's own
description. Codex devotes ~60 lines plus a dedicated model-prompt section to exactly this
(`default.md:62-121`, `gpt-5.2-codex_prompt.md:21-26`).

---

## Summary table

| # | Finding | DSH | Codex | Route |
|---|---|---|---|---|
| 1 | Behavioral prompt coverage | ~1.75k tok, tool one-liners | ~7.6k tok, engineered spec | **plugin** (`personaPrefix` / prompt section) |
| 2 | Tool schema context cost | 65 eager tools, ~14.9k tok | deferred + `tool_search` | core |
| 3 | Parallel shell/edit/MCP calls | serialized (3% cost here) | parallel via `RwLock` | core / tool opt-in |
| 4 | Tool-selection adherence | 95% | n/a | none |
| 5 | LLM auto-review of approvals | exists, ships off | guardian, on | **plugin/config** (insert `auto-review`) |
| 6 | Multi-file atomic edit | absent | `apply_patch` crate | **plugin** (new tool) |
| 7 | Plan/todo discipline | plan-mode only | base + model prompt | **plugin** (prompt section) |

Findings 1, 5, 6 and 7 are all reachable **without forking the harness**, which is the whole
point of the plugin/patch model. Finding 3 needs a one-line opt-in per tool
(`isConcurrencySafe` on the shell `defineTool` sites), which is a small upstream-shaped change
rather than a new subsystem.
