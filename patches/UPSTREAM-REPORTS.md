# Upstream reports

DSH's [`CONTRIBUTING.md`](https://github.com/deepseek-ai/deepseek-harness/blob/main/CONTRIBUTING.md)
declines external pull requests and names **GitHub Discussions** as the channel. Issues are disabled
on the repository, so everything below is a discussion. The `General` category is the de-facto bug
channel; four of the five most recent discussions there are defect reports.

## Filed

| # | Report | Severity | Filed |
|---|---|---|---|
| [8630](https://github.com/deepseek-ai/deepseek-harness/discussions/8630) | Sandbox modes named read-only / workspace-write do not restrict network egress | security | yes |
| [8635](https://github.com/deepseek-ai/deepseek-harness/discussions/8635) | Editing a profile while DSH runs drops preset-scoped tools from live sessions | high | yes |
| [8636](https://github.com/deepseek-ai/deepseek-harness/discussions/8636) | Unknown tool arguments are accepted and silently dropped | medium | yes |
| [8637](https://github.com/deepseek-ai/deepseek-harness/discussions/8637) | Three prompt sections render for agents without the tools they describe | low | yes |
| [8638](https://github.com/deepseek-ai/deepseek-harness/discussions/8638) | `isConcurrencySafe` is unset on the shell tools | low | yes |

Each report has a copy in this directory, byte-identical to what was posted.

## Corrections made after filing

Everything below was found by re-checking the reports against the source and the session logs
*after* posting. All three are now updated upstream.

### 8635 overstated the blast radius

It claimed the session loses "every preset-scoped tool". It does not. Comparing `request/header`
records either side of the event: **65 tools become 41, so 25 are lost**, and the survivors are the
35 `mcp__sage__*` tools plus `apply_patch` and four other top-level contributors.

The corrected version lists both sets exactly. The finding is sharper than the original claim: the
session keeps its MCP servers and loses `read`, `write`, `bash`, `edit`, `grep` and `glob`. It is not
degraded, it is useless.

`subagent` surviving while `subagent_fork`, `list_agents`, `send_message` and `interrupt_agent`
vanish is flagged in the report as unexplained. All five come from the same preset rows, so a plain
scope teardown does not account for it.

### 8635 had an uncontrolled confound

Both occurrences followed a sandbox escalation, which I had not separated from the profile edit. A
later session provided the control: four escalated commands (git remote, commit, push, rm) with the
tool count holding at 66 throughout. Escalation is ruled out. That control is now in the report,
because a cause I had not excluded is the first thing a reader should ask about.

### 8637 undercounted by six

It said three prompt sections render unguarded. Parsing every `ctx.systemPrompt.section({...})`
object literal under `packages/` gives **21 registrations, 16 of them tool sections, 7 guarded and 9
not**. Added: `tool:bash`, `tool:pwsh`, `tool:pty`, `tool:lsp`, `tool:session-query` and
`tool:workflow`.

The original also cited `packages/dsh-apply-patch` as an example of the guard, which is a plugin in
*this* repository, not theirs. A maintainer searching for it would find nothing. Replaced with the
seven shipped files that actually do it.

### 8636 was checked and held

The filed example was re-tested against the path the runtime uses, `defineTool` at
`packages/core/tools/src/schema.ts:578-599`, which is
`validateJsonSchemaValue(parameterSchemaSpecToJsonSchema(spec), args, '')`. The report now cites that
call site and notes that the extra key is *passed through* to the tool body rather than stripped.

### 8637 undercounted a second time, and the tool we built caught it

The "21 registrations, seven guarded, nine unguarded" figure above was itself wrong. It came from
searching for `ctx.systemPrompt.section({`, which silently misses every registration made through a
different receiver. Nine use another name:

```
promptCtx  scope  inner  scoped  childCtx  runtimeCtx
```

Corrected to **30 registrations, eight guarded, ten unguarded tool sections**.

How it was found is the part worth keeping. `check_claims` was pointed at the claim "`packages/`
contains 21 of these" and returned 85, because it searched the whole tree including tests and
matched any receiver. Narrowing to shipped source gave 30. The tool found, in its first hour, an
error that two rounds of manual review had missed, and it missed it in the direction that made the
defect look smaller, which is the direction a hand search fails in.

## Checked and rejected

Two findings from the earlier analysis did not survive verification. Recording them here so they are
not re-filed later.

### Compaction headroom is not a bug

`resolveCompactSpec` throws `TargetPressureConfigError` when
`(contextWindow − reservedCompletion) − headroomTokens` is not positive
(`packages/compaction/compaction-basic/src/config.ts:181-194`). With the shipped `headroomTokens:
65536`, any context window below roughly 73.5k has no auto compaction, which looked like a defect.

It is not. The error carries an actionable message naming all three remedies:

> reduce the effective request maxTokens or compaction headroomTokens, or configure a larger adapter
> model contextWindow

And it does not bite on the default model: `deepseek-flash` declares
`contextWindow: 1_000_000` (`packages/llm/llm-deepseek/src/defaults.ts:6`), where the 0.8 ratio
binds for any completion reserve under ~134k. Failing loudly with the fix named is the right
behaviour for a misconfiguration. Filing this would have been noise.

### The unknown-argument example was wrong

The earlier draft claimed:

```
edit { file_path: "a.ts", old_str: "x", new_string: "y" }   # old_str ignored; old_string missing
```

That call is **rejected**. `old_string` is required, so omitting it trips `required` and the model
gets `missing required property "value.file_path"`. The real defect is narrower, and only shows up
when the misspelled parameter is optional or undeclared:

```js
const schema = parameterSchemaSpecToJsonSchema({
  file_path: { type: 'string', required: true },
  replace_all: { type: 'boolean' },
})
validateJsonSchemaValue(schema, { file_path: 'a', replace_alll: true })  // []  <- typo discarded
validateJsonSchemaValue(schema, { file_path: 'a', wat: 1 })              // []  <- unknown discarded
```

The filed report uses the corrected example. Worth the correction: a report whose first
reproduction does not reproduce gets closed on that basis, whatever else it says.

## Still open

Nothing from the original analysis is unfiled. The remaining gaps in
[`../research/SCORECARD.md`](../research/SCORECARD.md) are feature work, not defects, and belong in
the repository we control rather than upstream.
