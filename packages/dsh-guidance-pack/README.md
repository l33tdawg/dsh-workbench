# @l33tdawg/dsh-guidance-pack

Behavioural prompt guidance for DeepSeek Harness.

## Why

DSH assembles its system prompt from three sources: a one-sentence harness identity, a
two-sentence deployment persona, and one short section per mounted tool. Measured on a live
session, that comes to **7,001 characters, about 1,750 tokens**, and almost all of it is
tool-usage one-liners.

Codex ships roughly **30,500 characters (~7,600 tokens)** of hand-written behavioural policy
covering planning, persistence, verification, scope, editing constraints, git safety, and
reporting style. DSH ships none of that.

The gap is *coverage*, not quality. Where DSH does write prompt guidance it is excellent. The
plan-mode policy in `packages/bundle/base/cordis.patch.yml` is arguably better than Codex's
equivalent. But `plan:policy` renders only while plan mode is active, and `todo_write` registers
**no prompt section at all**, so an ordinary session tells the model nothing about when to plan,
how long to persist, or what to verify.

This plugin contributes one prompt section covering that gap, and deliberately says nothing that
DSH already says.

## Install

Add the package to a profile and to its bundle list, the same way any DSH bundle is mounted:

```json
{
  "dependencies": {
    "@l33tdawg/dsh-guidance-pack": "link:/path/to/packages/dsh-guidance-pack"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@l33tdawg/dsh-guidance-pack"
      ]
    }
  }
}
```

The plugin's own `cordis.patch.yml` inserts the row; no harness file changes.

## Configure

| Field | Type | Default | Meaning |
|---|---|---|---|
| `blocks` | `string[]` | `[]` | Which blocks to include. Empty means all of them. |
| `order` | `number` | `100` | Prompt sort position. 100 sits after the deployment persona (0) and before plan-mode policy (500). |
| `extra` | `string` | `''` | Deployment-specific text appended last. |

Block names: `execution`, `planning`, `editing`, `verification`, `destructive`, `asking`,
`efficiency`, `scope`, `reporting`, `review`, `frontend`.

```yaml
- id: guidance-pack
  config:
    blocks: [planning, verification, editing, reporting]
    extra: >-
      This repository uses pnpm. Run `pnpm test` before reporting a change as done.
```

An unknown or duplicated block name fails at plugin load rather than being ignored. A deployment
that misspells a block should not silently lose the guidance it asked for.

## What it adds

| Block | Covers |
|---|---|
| `execution` | Finishing the task; root cause over surface patch; don't fix unrelated bugs; git safety; never revert work you did not author |
| `planning` | When to use the todo tool; what makes a plan verifiable, with contrasting examples; one step in progress; progress notes |
| `editing` | ASCII default; comment restraint; no license headers; script bulk changes |
| `verification` | Narrow tests first, then widen; don't add a test framework; formatter policy; never claim an unperformed verification |
| `destructive` | Resolve and read back the target; never recursive-delete a root or home directory; prefer recoverable operations; use a fresh temp directory |
| `asking` | Explore before asking; separate discoverable facts from user-owned decisions; offer 2–4 options with a recommendation |
| `efficiency` | Batch independent reads; narrow before widening a search; avoid unbounded blocking commands; don't chain unrelated operations |
| `scope` | Ambitious when starting fresh, surgical inside an existing codebase |
| `reporting` | Lead with the outcome; default to brief; reference paths instead of pasting files; state residual risk |
| `review` | Findings first, ordered by severity, with file and line |
| `frontend` | Deliberate typography, colour, motion, and backgrounds; preserve an existing design system |

**Total: 8,456 characters, about 2,114 tokens.** That roughly doubles the default DSH prompt while
staying at under a quarter of Codex's.

## What it deliberately does not do

A test enforces these omissions, so a future edit cannot quietly reintroduce duplication.

- **No restatement of DSH's own guidance.** Tool-selection rules (`read` over `cat`, `glob` over
  `find`, `grep` over `rg`), `@`-file reference handling, read-before-edit, background-job
  tracking, untrusted web content, goal and workflow semantics, and deliverable presentation are
  all already shipped by the packages that own those tools. Repeating them would spend tokens and
  risk contradicting the authoritative text.
- **No file-link formatting rules.** DSH already specifies these in detail, including the
  `#L24-L30` suffix convention. Codex's equivalent differs, so importing it would conflict.
- **No sandbox or approval narrative.** DSH injects the live sandbox mode and approval policy as
  runtime context every turn. Static prose would go stale and could contradict the live values.
- **No identity or persona override.** The deployment owns that.

## Design notes

- The section is registered with `interpolate: false`. The text is literal Markdown, and a future
  edit containing `{{...}}` must not be silently rewritten as a prompt variable.
- Placement at order 100 reads as: who you are → how you work → plan-mode specifics → tool
  specifics.
- Sections are concatenated in declaration order, not config order, so a subset renders stably.

## Tests

```sh
npm test
```

21 tests over configuration validation, block selection, rendering, registration, the prompt
budget, and the non-duplication guarantees above.

## Verify what it actually did

The section is an ordinary `systemPrompt.section`, so it appears in the session transcript. This
prints the assembled system prompt from a recorded session:

```sh
node -e '
const fs=require("fs"), z=require("zlib");
const buf=fs.readFileSync(process.argv[1]);
const M=Buffer.from([0x28,0xB5,0x2F,0xFD]); const parts=[];
for(let i=0;i<=buf.length-4;i++) if(buf[i]===0x28&&buf[i+1]===0xB5&&buf[i+2]===0x2F&&buf[i+3]===0xFD)
  { try{ parts.push(z.zstdDecompressSync(buf.subarray(i))) }catch{} }
const lines=Buffer.concat(parts).toString("utf8").split("\n").filter(Boolean);
const rec=lines.map(l=>{try{return JSON.parse(l)}catch{return null}})
  .find(r=>r&&r.type==="system/message");
const d=rec.data;
console.log(typeof d==="string" ? d : (d.message?.content?.[0]?.text ?? JSON.stringify(d)));
' ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd | grep -c "## Planning"
```

Reading `1` confirms the section is live; `0` means it is not mounted.

A session transcript is a **concatenated multi-frame** zstd stream. The session measured here had
145 frames. Node's `zstdDecompressSync` silently returns only the first frame, so the
frames must be split on the magic before decompressing, as above. Calling it on the whole file
returns a 229-byte header and looks like an empty session. (The `/usr/local/bin/zstd` on this
machine is an x86 binary and fails with `Bad CPU type in executable`, so it cannot be used instead.)

## The `claims` block

Added after four unmeasured assertions reached a public bug report against DSH itself:

- a count stated as "every preset-scoped tool" when 25 of 65 tools were removed
- a count stated as "three prompt sections" when the real number was nine
- a citation of `packages/dsh-apply-patch`, a plugin in this repository rather than in the
  repository the report was filed against
- a security claim checked against a working tree carrying the reporter's own patch, which would
  have answered the wrong question for every assertion in it

Each of those was a claim that one command would have settled. The block is deliberately about the
shape of a claim rather than about any particular subject, so it applies to code, to prose, and to
reports about a third party.
