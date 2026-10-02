# Unknown tool arguments are accepted and silently dropped

**Severity:** medium. The model is told its call succeeded when a parameter it passed was ignored.

## What happens

A typed tool never closes its parameter object. The generated schema has `type`, `properties` and `required`, and no `additionalProperties`. The validator only rejects undeclared keys when that keyword is present and `false`, so an argument the tool does not declare is accepted and discarded.

A misspelling is caught only when it collides with a required parameter, because then `required` fires on the absence. Otherwise the call proceeds with the parameter missing, and the tool result says it worked.

## Reproduction

Using the shipped validator and the shipped schema compiler:

```js
const { parameterSchemaSpecToJsonSchema, validateJsonSchemaValue } = require('@deepseek-ai/dsh-tools')

const schema = parameterSchemaSpecToJsonSchema({
  file_path: { type: 'string', required: true },
  old_string: { type: 'string', required: true },
  replace_all: { type: 'boolean' },
})

console.log(Object.hasOwn(schema, 'additionalProperties'))  // false

validateJsonSchemaValue(schema, { file_str: 'a', old_string: 'b' })
// ["missing required property \"value.file_path\""]   <- caught, because required

validateJsonSchemaValue(schema, { file_path: 'a', old_string: 'b', replace_alll: true })
// []                                                   <- accepted, typo discarded

validateJsonSchemaValue(schema, { file_path: 'a', old_string: 'b', wat: 1 })
// []                                                   <- accepted, unknown arg discarded
```

The root schema is built at `packages/core/tools/src/schema.ts`, in `parameterSchemaSpecToJsonSchema`:

```ts
const schema: ParameterJsonSchema = {
  type: 'object',
  properties: compiled.properties,
  ...(compiled.required === undefined ? {} : { required: compiled.required }),
}
```

No `additionalProperties`. The checker at `packages/core/tools/src/json-schema.ts` guards its undeclared-key loop on that keyword being present:

```ts
if (Object.hasOwn(frame.node, 'additionalProperties') && frame.node.additionalProperties === false) {
```

## Why it matters

Silent acceptance is the bad half of the trade. A model that passes `run_in_background: true` when the parameter is spelled differently gets a normal result and no signal that the argument went nowhere, so it will make the same call again. Reporting the extra key would turn a silent wrong-result into a loud no-op, which is cheaper to recover from.

The docstring on `parameterSchemaSpecToJsonSchema` says "no implicit-root openness override", which reads as deliberate, so I may be arguing against an intentional choice. What I could not find is where the openness is relied on. If nothing needs it, closing the root by default and letting a tool opt out would catch the typo case without changing any tool that currently works.

## Environment

- DSH `dsh-v0.2.0-rc.2`, commit `639ed0153`
- Reproduced against `@deepseek-ai/dsh-tools` from the shipped package
