/**
 * Behaviour tests for the guidance pack. Everything runs against a fake Cordis
 * context, so the assertions show exactly what the plugin would register without
 * booting a harness.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  apply,
  BLOCK_NAMES,
  BLOCKS,
  Config,
  DEFAULT_ORDER,
  inject,
  name,
  renderGuidance,
  SECTION_NAME,
  selectBlocks,
  validateConfig,
} from '../src/index.ts'

/** Normalize configuration exactly as the loader's validation step does. */
function config(raw = {}) {
  const result = Config['~standard'].validate(raw)
  if (result.issues) throw new Error(result.issues.map(issue => issue.message).join('; '))
  return result.value
}

/** A fake Cordis context recording registered sections and logger calls. */
function fakeContext() {
  const sections = []
  const warnings = []
  return {
    sections,
    warnings,
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      getSectionOrder(orderName) {
        return { PERSONA_PREFIX: 0, PLAN_POLICY: 500 }[orderName]
      },
    },
    logger: {
      warn(format, ...args) {
        warnings.push(format.replace(/%s/g, () => String(args.shift())))
      },
    },
  }
}

describe('plugin identity', () => {
  it('declares the prompt service as its only requirement', () => {
    assert.equal(name, 'guidance-pack')
    assert.deepEqual(inject, ['systemPrompt'])
  })

  it('names every block', () => {
    assert.deepEqual(BLOCK_NAMES, [
      'execution',
      'planning',
      'editing',
      'verification',
      'claims',
      'destructive',
      'asking',
      'efficiency',
      'scope',
      'reporting',
      'review',
      'frontend',
    ])
    for (const block of BLOCKS) {
      assert.ok(block.text.length > 0, `${block.name} must have text`)
    }
  })
})

describe('configuration', () => {
  it('defaults to every block at the documented order', () => {
    assert.deepEqual(config(), { blocks: [], order: DEFAULT_ORDER, extra: '' })
  })

  it('accepts an explicit subset and extra text', () => {
    const resolved = config({ blocks: ['planning', 'verification'], order: 250, extra: 'House rule.' })
    assert.deepEqual(resolved, { blocks: ['planning', 'verification'], order: 250, extra: 'House rule.' })
  })

  it('rejects an unknown block name', () => {
    const result = validateConfig({ blocks: ['planing'] })
    assert.ok(result.issues, 'expected issues')
    assert.match(result.issues[0].message, /unknown block "planing"/)
  })

  it('rejects a duplicated block name', () => {
    const result = validateConfig({ blocks: ['planning', 'planning'] })
    assert.ok(result.issues, 'expected issues')
    assert.match(result.issues[0].message, /duplicate block "planning"/)
  })

  it('rejects a non-finite order', () => {
    const result = validateConfig({ order: Number.POSITIVE_INFINITY })
    assert.ok(result.issues, 'expected issues')
    assert.match(result.issues[0].message, /order must be number/)
  })

  it('rejects a non-string extra', () => {
    const result = validateConfig({ extra: 7 })
    assert.ok(result.issues, 'expected issues')
    assert.match(result.issues[0].message, /extra must be string/)
  })

  it('rejects a non-object configuration', () => {
    assert.ok(validateConfig([]).issues)
  })
})

describe('block selection', () => {
  it('selects every block when none are named', () => {
    assert.deepEqual(selectBlocks([]).map(block => block.name), [...BLOCK_NAMES])
    assert.deepEqual(selectBlocks(undefined).map(block => block.name), [...BLOCK_NAMES])
  })

  it('preserves declaration order regardless of request order', () => {
    const selected = selectBlocks(['reporting', 'planning'])
    assert.deepEqual(selected.map(block => block.name), ['planning', 'reporting'])
  })
})

describe('rendering', () => {
  it('joins selected blocks with a blank line', () => {
    const text = renderGuidance({ blocks: ['scope', 'review'], order: DEFAULT_ORDER, extra: '' })
    assert.ok(text.includes('## Scope and judgement'))
    assert.ok(text.includes('## Code review requests'))
    assert.ok(!text.includes('## Planning'))
    assert.match(text, /\n\n/)
  })

  it('appends deployment extra text last', () => {
    const text = renderGuidance({ blocks: ['scope'], order: DEFAULT_ORDER, extra: 'House rule.' })
    assert.ok(text.endsWith('House rule.'))
  })

  it('ignores blank extra text', () => {
    const text = renderGuidance({ blocks: ['scope'], order: DEFAULT_ORDER, extra: '   \n  ' })
    assert.equal(text, BLOCKS.find(block => block.name === 'scope').text)
  })
})

describe('registration', () => {
  it('registers one non-interpolated section at the configured order', () => {
    const ctx = fakeContext()
    apply(ctx, config())
    assert.equal(ctx.sections.length, 1)
    const [section] = ctx.sections
    assert.equal(section.name, SECTION_NAME)
    assert.equal(section.order, DEFAULT_ORDER)
    assert.equal(section.interpolate, false)
    assert.ok(section.text.startsWith('## Finishing the task'))
  })

  it('places the section after the persona and before plan policy', () => {
    const ctx = fakeContext()
    apply(ctx, config())
    const [section] = ctx.sections
    assert.ok(section.order > 0, 'must follow the deployment persona')
    assert.ok(section.order < 500, 'must precede plan-mode policy')
  })

  it('warns instead of registering when there is nothing to say', () => {
    const ctx = fakeContext()
    // An empty `blocks` list means "every block", so this state is unreachable
    // through configuration. Drive `apply` directly to cover the guard.
    apply(ctx, { blocks: ['__none__'], order: DEFAULT_ORDER, extra: '' })
    assert.equal(ctx.sections.length, 0)
    assert.match(ctx.warnings.join('\n'), /no prompt section registered/)
  })
})

describe('prompt budget', () => {
  it('stays within the budget the measurements allow', () => {
    const text = renderGuidance(config())
    const approxTokens = Math.ceil(text.length / 4)
    assert.ok(text.length < 8000, `guidance is ${text.length} chars; budget is 8000`)
    assert.ok(approxTokens < 2000, `guidance is ~${approxTokens} tokens; budget is 2000`)
  })
})

describe('non-duplication', () => {
  // These are all owned by first-party DSH prompt sections or tool descriptions.
  // Repeating them would spend tokens and risk contradicting the authoritative text.
  const owned = [
    'exit code',
    'read-before',
    'sandbox_permissions',
    'danger-full-access',
    'workspace-write',
    'README.md#L',
    'mcp__',
  ]

  it('does not restate guidance DSH already ships', () => {
    const text = renderGuidance(config()).toLowerCase()
    for (const phrase of owned) {
      assert.ok(!text.includes(phrase.toLowerCase()), `guidance must not restate "${phrase}"`)
    }
  })
})

describe('the claims block', () => {
  // Written after four unmeasured assertions reached a public bug report: a
  // count stated as "every", a count stated as three when it was nine, a path
  // from the wrong repository, and a claim checked against a patched tree.
  const claims = BLOCKS.find(block => block.name === 'claims')

  it('exists and covers each failure that motivated it', () => {
    assert.ok(claims !== undefined, 'the claims block is missing')
    const text = claims.text
    // A count must be counted.
    assert.match(text, /is not a count/)
    // An absence must not rest on a search that can silently under-report.
    assert.match(text, /truncates/)
    // The subject of a claim must be the thing that was inspected.
    assert.match(text, /which revision/)
    // A check must not be able to destroy what it checks.
    assert.match(text, /alter what it checks/)
    // An unstated assumption is invisible to the user who has to correct it.
    assert.match(text, /State the assumption/)
  })

  it('is enabled by default, since it guards every other block', () => {
    assert.ok(BLOCK_NAMES.includes('claims'))
  })
})
