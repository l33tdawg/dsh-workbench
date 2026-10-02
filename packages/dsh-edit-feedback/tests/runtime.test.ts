/**
 * End-to-end check against the real tool registry.
 *
 * The hook test drives `apply` with a fake context, which covers the wiring but
 * not the part that actually matters: whether the harness *keeps* the rest of the
 * result when a policy replaces `content`. That behaviour lives in
 * `ToolRuntime.postExecute`, so this boots the genuine registry, registers a tool
 * declaring the same output shape `edit` declares, and calls it through
 * `ctx.tools.execute`.
 *
 * Two assertions carry the weight, and both are about what did NOT change:
 *
 * - `value` still holds the before/after pair, so the filesystem version guard
 *   and anything downstream of the registry see exactly what they saw before.
 * - `meta` still holds the presentation diffs, so the human's diff card is
 *   untouched by the text the model now reads.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

import { apply } from '../src/index.ts'
import * as plugin from '../src/index.ts'

const BEFORE = 'one\ntwo\nthree\n'
const AFTER = 'one\nTWO\nthree\n'

/** Contexts started by this file, disposed after the last test. */
const started: Array<{ dispose: () => Promise<void> }> = []

after(async () => {
  for (const fiber of started.reverse()) {
    try {
      await fiber.dispose()
    } catch {
      // A fiber that already unloaded is not a failure of this teardown.
    }
  }
})

/**
 * Boot the real registry with the plugin installed and one `edit`-shaped tool.
 * @param viaLoader - install the module the way the loader does, through
 *   Cordis's `inject`, rather than calling `apply` directly.
 * @returns the context, ready to execute a call against.
 */
async function boot(viaLoader = false): Promise<Context> {
  const ctx = new Context()
  started.push(await ctx.plugin(SystemPrompt))
  started.push(await ctx.plugin(ToolRuntime))

  // The same definition shape `edit` declares: a structured value carrying the
  // before/after pair, a one-sentence render, and a presentation-only diff.
  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `The file ${value.path} has been updated successfully.`,
      }],
      presentationMeta: (_args, value) => ({
        diffs: [{ path: value.path, oldText: value.before, newText: value.after }],
      }),
    },
    execute: async args => ({
      path: args.file_path,
      before: BEFORE,
      after: AFTER,
    }),
  }))

  if (viaLoader) started.push(await ctx.plugin(plugin))
  else apply(ctx, {})
  return ctx
}

/**
 * Run the registered `edit` tool through the real registry.
 * @param ctx - the booted context.
 * @returns the materialized result.
 */
async function runEdit(ctx: Context) {
  return ctx.tools.execute({
    callId: `call-${Math.random().toString(36).slice(2)}` as never,
    name: 'edit',
    arguments: { file_path: 'src/app.ts', old_string: 'two', new_string: 'TWO' },
    signal: new AbortController().signal,
  })
}

/** Concatenate the text of a result's content blocks. */
function textOf(result: { content: readonly { type: string, text?: string }[] }): string {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
}

describe('edit feedback against the real registry', () => {
  it('activates through the loader path, resolving its injected service', async () => {
    // `inject: ['tools']` is a promise to the loader: this plugin does not
    // activate without the tool registry. Passing the whole module namespace is
    // what the loader does, so this covers the export names it reads.
    const result = await runEdit(await boot(true))
    assert.equal(result.isError, false)
    assert.match(textOf(result), /@@ -1,3 \+1,3 @@/)
  })

  it('reports no error and delivers the diff to the model', async () => {
    const result = await runEdit(await boot())
    assert.equal(result.isError, false)
    assert.equal(textOf(result), [
      'The file src/app.ts has been updated successfully.',
      '',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
    ].join('\n'))
  })

  it('leaves the structured value intact', async () => {
    const result = await runEdit(await boot())
    assert.equal(result.isError, false)
    if (result.isError) throw new Error('unreachable')
    assert.deepEqual(result.value, { path: 'src/app.ts', before: BEFORE, after: AFTER })
  })

  it('leaves the presentation metadata intact', async () => {
    const result = await runEdit(await boot())
    assert.deepEqual(result.meta, {
      diffs: [{ path: 'src/app.ts', oldText: BEFORE, newText: AFTER }],
    })
  })

  it('produces exactly one text block', async () => {
    const result = await runEdit(await boot())
    assert.equal(result.content.length, 1)
  })

  it('does not disturb a tool it was not configured for', async () => {
    const ctx = await boot()
    ctx.tools.register(defineTool({
      name: 'unrelated',
      description: 'A tool this plugin has no opinion about.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [{ type: 'text', text: 'unrelated ran' }],
      },
      execute: async () => ({}),
    }))
    const result = await ctx.tools.execute({
      callId: 'call-unrelated' as never,
      name: 'unrelated',
      arguments: {},
      signal: new AbortController().signal,
    })
    assert.equal(textOf(result), 'unrelated ran')
  })
})
