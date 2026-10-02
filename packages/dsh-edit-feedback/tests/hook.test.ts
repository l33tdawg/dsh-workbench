/**
 * End-to-end test of the post-execute hook.
 *
 * The unit tests cover the diff and the rendering in isolation. This drives the
 * real `apply` with a fake context, so the wiring itself is covered: the event
 * name, the decision shape, and the three promises the module makes — that it
 * only replaces content, that it never overrides another policy, and that
 * nothing thrown inside it can break a tool call.
 *
 * It also proves something about the module's imports: `index.ts` loads under
 * plain Node with no harness installed, because every harness import is
 * type-only and erased before resolution. If that ever stops being true, this
 * file fails to load and the suite does not silently skip.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply, inject, name } from '../src/index.ts'
import type { Config } from '../src/report.ts'

/** A text block as the harness models it. */
interface TextBlock {
  type: 'text'
  text: string
}

/** What a post-execute policy returns, narrowed to what these tests read. */
interface Decision {
  kind: string
  content?: TextBlock[]
  additionalContexts?: unknown[]
}

/** Everything the fake context captured. */
interface Harness {
  hook: (exec: unknown, result: unknown, next: () => Promise<Decision>) => Promise<Decision>
  events: string[]
  warnings: unknown[][]
}

/**
 * Install the plugin against a fake context.
 * @param config - plugin configuration.
 * @returns the captured hook and diagnostics.
 */
function install(config: Config = {}): Harness {
  const harness: Harness = {
    hook: undefined as never,
    events: [],
    warnings: [],
  }
  const ctx = {
    on: (event: string, handler: Harness['hook']) => {
      harness.events.push(event)
      harness.hook = handler
      return () => {}
    },
    logger: { warn: (...args: unknown[]) => { harness.warnings.push(args) } },
  }
  apply(ctx as never, config)
  return harness
}

/** An `edit` execution, as the registry hands it to a policy. */
function editExec(toolName = 'edit'): unknown {
  return { name: toolName, arguments: { file_path: 'src/app.ts' }, agent: undefined }
}

/** A successful result whose value is the pair the `edit` tool returns. */
function editResult(before = 'one\ntwo\nthree\n', after = 'one\nTWO\nthree\n'): unknown {
  return {
    isError: false,
    value: { path: 'src/app.ts', before, after },
    content: [{ type: 'text', text: 'The file src/app.ts has been updated successfully.' }],
  }
}

/** The default downstream decision: another policy accepted without changes. */
function accept(): Promise<Decision> {
  return Promise.resolve({ kind: 'accept' })
}

describe('edit-feedback plugin', () => {
  it('declares the loader name and its required service', () => {
    assert.equal(name, 'edit-feedback')
    assert.deepEqual(inject, ['tools'])
  })

  it('registers exactly one post-execute listener', () => {
    const harness = install()
    assert.deepEqual(harness.events, ['tools/post-execute'])
  })

  it('registers nothing when disabled', () => {
    const harness = install({ enabled: false })
    assert.deepEqual(harness.events, [])
  })

  it('appends the diff to the sentence the tool already rendered', async () => {
    const harness = install()
    const decision = await harness.hook(editExec(), editResult(), accept)
    assert.equal(decision.kind, 'accept')
    assert.deepEqual(decision.content, [{
      type: 'text',
      text: [
        'The file src/app.ts has been updated successfully.',
        '',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
      ].join('\n'),
    }])
  })

  it('keeps the diff in one block, so no adapter has to join several', async () => {
    const harness = install()
    const decision = await harness.hook(editExec(), editResult(), accept)
    assert.equal(decision.content?.length, 1)
  })

  it('leaves the result untouched when the content did not change', async () => {
    const harness = install()
    const decision = await harness.hook(editExec(), editResult('same\n', 'same\n'), accept)
    assert.deepEqual(decision, { kind: 'accept' })
  })

  it('ignores a tool it was not configured for', async () => {
    const harness = install()
    const decision = await harness.hook(editExec('bash'), editResult(), accept)
    assert.deepEqual(decision, { kind: 'accept' })
  })

  it('enriches a tool added by configuration', async () => {
    const harness = install({ tools: ['edit', 'bash'] })
    const decision = await harness.hook(editExec('bash'), editResult(), accept)
    assert.equal(decision.content?.length, 1)
  })

  it('leaves a failed result alone', async () => {
    const harness = install()
    const failed = {
      isError: true,
      content: [{ type: 'text', text: 'nope' }],
      error: { message: 'nope' },
    }
    const decision = await harness.hook(editExec(), failed, accept)
    assert.deepEqual(decision, { kind: 'accept' })
  })

  it('never overrides a policy that blocked the call', async () => {
    const harness = install()
    const blocked: Decision = { kind: 'block', content: [{ type: 'text', text: 'check failed' }] }
    const decision = await harness.hook(editExec(), editResult(), () => Promise.resolve(blocked))
    assert.deepEqual(decision, blocked)
  })

  it('carries a downstream policy context through', async () => {
    const harness = install()
    const notice = { role: 'user', content: 'typecheck failed' }
    const downstream: Decision = { kind: 'accept', additionalContexts: [notice] }
    const decision = await harness.hook(editExec(), editResult(), () => Promise.resolve(downstream))
    assert.deepEqual(decision.additionalContexts, [notice])
    assert.equal(decision.content?.length, 1)
  })

  it('honours content another policy already replaced', async () => {
    const harness = install()
    const downstream: Decision = {
      kind: 'accept',
      content: [{ type: 'text', text: 'replaced by someone else' }],
    }
    const decision = await harness.hook(editExec(), editResult(), () => Promise.resolve(downstream))
    assert.match(decision.content?.[0].text ?? '', /^replaced by someone else\n\n@@ /)
  })

  it('appends a block when the result carries no text to extend', async () => {
    const harness = install()
    const result = {
      isError: false,
      value: { path: 'src/app.ts', before: 'a\n', after: 'b\n' },
      content: [],
    }
    const decision = await harness.hook(editExec(), result, accept)
    assert.equal(decision.content?.length, 1)
    assert.match(decision.content?.[0].text ?? '', /^@@ /)
  })

  it('does not mutate the content it was given', async () => {
    const harness = install()
    const result = editResult() as { content: TextBlock[] }
    const original = result.content[0]
    await harness.hook(editExec(), result, accept)
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0], original)
    assert.equal(original.text, 'The file src/app.ts has been updated successfully.')
  })

  it('swallows its own failure and lets the call succeed', async () => {
    const harness = install()
    const result = { isError: false, content: [] }
    Object.defineProperty(result, 'value', {
      get() { throw new Error('boom') },
    })
    const decision = await harness.hook(editExec(), result, accept)
    assert.deepEqual(decision, { kind: 'accept' })
    assert.equal(harness.warnings.length, 1)
    assert.match(String(harness.warnings[0][0]), /edit-feedback: hook error/)
  })

  it('reads an apply_patch result across files', async () => {
    const harness = install()
    const result = {
      isError: false,
      content: [{ type: 'text', text: 'Applied 2 files.' }],
      value: {
        files: [
          { path: 'a.ts', target: 'a.ts', operation: 'update', before: 'x\n', after: 'y\n' },
          { path: 'b.ts', target: 'b.ts', operation: 'update', before: 'p\n', after: 'q\n' },
        ],
      },
    }
    const decision = await harness.hook(editExec('apply_patch'), result, accept)
    const text = decision.content?.[0].text ?? ''
    assert.ok(text.startsWith('Applied 2 files.\n\n'))
    assert.ok(text.includes('--- a.ts'))
    assert.ok(text.includes('--- b.ts'))
  })
})
