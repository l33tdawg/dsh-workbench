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
