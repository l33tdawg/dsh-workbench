/**
 * Configuration, result-shape reading, and the bounded rendering.
 *
 * These run without a harness, which is the point: every decision about what the
 * model is shown is testable from a before/after pair and a config object.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULTS,
  changesFrom,
  formatFeedback,
  resolveConfig,
} from '../src/report.ts'
import type { Change } from '../src/report.ts'

/** One change, defaulted to a trivial edit. */
function change(overrides: Partial<Change> = {}): Change {
  return { path: 'src/app.ts', before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n', ...overrides }
}

describe('resolveConfig', () => {
  it('applies every default to an empty config', () => {
    assert.deepEqual(resolveConfig({}), DEFAULTS)
  })

  it('keeps the defaults on the object it exports', () => {
    // The cordis row and this module must not drift apart.
    assert.deepEqual(DEFAULTS.tools, ['edit', 'write', 'apply_patch'])
    assert.equal(DEFAULTS.context, 2)
    assert.equal(DEFAULTS.maxLines, 60)
  })

  it('clamps values that would produce a useless result', () => {
    const resolved = resolveConfig({ context: -5, maxHunks: 0, maxLines: 0, maxLineLength: 5 })
    assert.equal(resolved.context, 0)
    assert.equal(resolved.maxHunks, 1)
    assert.equal(resolved.maxLines, 1)
    assert.equal(resolved.maxLineLength, 20)
  })

  it('honours an explicit config', () => {
    const resolved = resolveConfig({ enabled: false, tools: ['edit'], context: 5 })
    assert.equal(resolved.enabled, false)
    assert.deepEqual(resolved.tools, ['edit'])
    assert.equal(resolved.context, 5)
  })
})

describe('changesFrom', () => {
  it('reads the edit shape', () => {
    const value = { path: 'src/app.ts', before: 'a', after: 'b' }
    assert.deepEqual(changesFrom('edit', value, DEFAULTS.tools), [
      { path: 'src/app.ts', before: 'a', after: 'b' },
    ])
  })

  it('reads the write shape for an update', () => {
    const value = { path: 'src/app.ts', operation: 'update', before: 'a', after: 'b' }
    assert.deepEqual(changesFrom('write', value, DEFAULTS.tools), [
      { path: 'src/app.ts', before: 'a', after: 'b' },
    ])
  })

  it('skips a creation, which has nothing to compare against', () => {
    // The model just supplied this content. Echoing it back spends context to
    // repeat what the model already wrote.
    const value = { path: 'src/new.ts', operation: 'create', before: null, after: 'b' }
    assert.deepEqual(changesFrom('write', value, DEFAULTS.tools), [])
  })

  it('reads every file in an apply_patch result', () => {
    const value = {
      files: [
        { path: 'a.ts', target: 'a.ts', operation: 'update', before: 'a', after: 'b' },
        { path: 'b.ts', target: 'b.ts', operation: 'update', before: 'c', after: 'd' },
      ],
    }
    assert.deepEqual(changesFrom('apply_patch', value, DEFAULTS.tools), [
      { path: 'a.ts', before: 'a', after: 'b' },
      { path: 'b.ts', before: 'c', after: 'd' },
    ])
  })

  it('drops created files from an apply_patch result but keeps the rest', () => {
    const value = {
      files: [
        { path: 'a.ts', target: 'a.ts', operation: 'update', before: 'a', after: 'b' },
        { path: 'new.ts', target: 'new.ts', operation: 'create', before: null, after: 'z' },
      ],
    }
    assert.deepEqual(changesFrom('apply_patch', value, DEFAULTS.tools), [
      { path: 'a.ts', before: 'a', after: 'b' },
    ])
  })

  it('prefers the resolved target over the path as written', () => {
    const value = { files: [{ path: 'old.ts', target: 'new.ts', before: 'a', after: 'b' }] }
    assert.deepEqual(changesFrom('apply_patch', value, DEFAULTS.tools), [
      { path: 'new.ts', before: 'a', after: 'b' },
    ])
  })

  it('ignores a tool it was not asked to enrich', () => {
    const value = { path: 'src/app.ts', before: 'a', after: 'b' }
    assert.deepEqual(changesFrom('bash', value, DEFAULTS.tools), [])
  })

  it('ignores values that do not carry a usable pair', () => {
    assert.deepEqual(changesFrom('edit', null, DEFAULTS.tools), [])
    assert.deepEqual(changesFrom('edit', 'a string', DEFAULTS.tools), [])
    assert.deepEqual(changesFrom('edit', { path: 'a', before: 5, after: 'b' }, DEFAULTS.tools), [])
    assert.deepEqual(changesFrom('edit', { path: 'a', after: 'b' }, DEFAULTS.tools), [])
    assert.deepEqual(changesFrom('apply_patch', { files: 'nope' }, DEFAULTS.tools), [])
  })
})

describe('formatFeedback', () => {
  const config = resolveConfig({})

  it('says nothing when there are no changes', () => {
    assert.equal(formatFeedback([], config), undefined)
  })

  it('says nothing when the content is identical', () => {
    assert.equal(formatFeedback([change({ before: 'same\n', after: 'same\n' })], config), undefined)
  })

  it('renders one hunk for one edit', () => {
    assert.equal(formatFeedback([change()], config), [
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
    ].join('\n'))
  })

  it('names each file when the change spans several', () => {
    const text = formatFeedback([
      change({ path: 'a.ts' }),
      change({ path: 'b.ts', before: 'x\n', after: 'y\n' }),
    ], config)
    assert.ok(text !== undefined)
    assert.match(text, /^--- a\.ts\n/)
    assert.ok(text.includes('\n--- b.ts\n'))
  })

  it('omits the file header for a single file', () => {
    const text = formatFeedback([change()], config)
    assert.ok(text !== undefined)
    assert.ok(!text.includes('--- '))
  })

  it('drops hunks past the cap and counts them', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const after = [...before]
    for (const at of [2, 10, 18, 26, 34]) after[at] = `CHANGED ${at}`
    const text = formatFeedback(
      [change({ before: `${before.join('\n')}\n`, after: `${after.join('\n')}\n` })],
      resolveConfig({ maxHunks: 2, maxLines: 100 }),
    )
    assert.ok(text !== undefined)
    assert.equal(text.split('\n').filter(line => line.startsWith('@@ ')).length, 2)
    assert.match(text, /\.\.\. 3 more hunks and \d+ more changed lines not shown/)
  })

  it('stops at the line budget and counts what it dropped', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const after = [...before]
    for (const at of [2, 10, 18, 26, 34]) after[at] = `CHANGED ${at}`
    const text = formatFeedback(
      [change({ before: `${before.join('\n')}\n`, after: `${after.join('\n')}\n` })],
      resolveConfig({ maxLines: 5 }),
    )
    assert.ok(text !== undefined)
    assert.ok(text.split('\n').length <= 6, `too long:\n${text}`)
    assert.match(text, /more changed line/)
  })

  it('clips a line that would otherwise dominate the result', () => {
    const long = 'x'.repeat(30)
    const text = formatFeedback(
      [change({ before: `${long}\n`, after: 'short\n' })],
      resolveConfig({ maxLineLength: 20 }),
    )
    assert.ok(text !== undefined)
    assert.ok(text.includes('-xxxxxxxxxxxxxxxxxxxx  ... [10 more characters]'))
  })

  it('never tells the model to go read the file', () => {
    // Re-reading after an edit is the behaviour this plugin exists to remove, so
    // a truncation footer that recommends it would defeat the purpose.
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    const after = before.map((line, i) => (i % 4 === 0 ? `CHANGED ${i}` : line))
    const text = formatFeedback(
      [change({ before: `${before.join('\n')}\n`, after: `${after.join('\n')}\n` })],
      resolveConfig({ maxHunks: 2, maxLines: 10 }),
    )
    assert.ok(text !== undefined)
    assert.doesNotMatch(text, /\bread\b/i)
    assert.match(text, /not shown/)
  })

  it('reports a rewrite as a summary rather than hunks', () => {
    const before = Array.from({ length: 2100 }, (_, i) => `before ${i}`).join('\n')
    const after = Array.from({ length: 2100 }, (_, i) => `after ${i}`).join('\n')
    const text = formatFeedback([change({ before, after })], config)
    assert.ok(text !== undefined)
    assert.match(text, /rewritten, 2100 lines before and 2100 after; too large to show here/)
  })
})
