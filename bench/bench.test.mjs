/**
 * Tests for the benchmark harness.
 *
 * The parts worth pinning are the ones that decide what a run is recorded as,
 * because a harness that misreads its own output reports a confident score for
 * a run that never happened. Everything here is a pure function over captured
 * text; the process spawning underneath is exercised by running the harness.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseSummary } from './score.mjs'
import { parseArgs, parseEvents, summarize } from './run.mjs'
import { LOCAL_BUNDLES, VARIANTS, entryOf, overlayFor } from './variants.mjs'

describe('parseArgs', () => {
  it('reads the container flags', () => {
    const options = parseArgs(['node', 'run.mjs', '--fixture', 'bug-fix', '--container', '--image', 'x:1'])
    assert.equal(options.container, true)
    assert.equal(options.image, 'x:1')
    assert.deepEqual(options.fixtures, ['bug-fix'])
  })

  it('defaults to a host run of the off arm', () => {
    const options = parseArgs(['node', 'run.mjs', '--fixture', 'bug-fix'])
    assert.equal(options.container, false)
    assert.equal(options.variant, 'off')
    assert.equal(options.reps, 1)
  })

  it('rejects an unknown variant rather than running a different arm', () => {
    assert.throws(() => parseArgs(['node', 'run.mjs', '--fixture', 'bug-fix', '--variant', 'nope']), /--variant must be one of/)
  })

  it('rejects a non-positive repetition count', () => {
    assert.throws(() => parseArgs(['node', 'run.mjs', '--fixture', 'bug-fix', '--reps', '0']), /positive integer/)
  })

  it('rejects an unknown flag instead of ignoring a typo', () => {
    assert.throws(() => parseArgs(['node', 'run.mjs', '--fixture', 'bug-fix', '--reppps', '2']), /unknown argument/)
  })

  it('requires a fixture', () => {
    assert.throws(() => parseArgs(['node', 'run.mjs']), /--fixture is required/)
  })
})

describe('parseEvents', () => {
  it('parses newline-delimited events', () => {
    const { events, unparsed } = parseEvents('{"type":"final","text":"ok"}\n{"type":"status"}\n')
    assert.equal(events.length, 2)
    assert.deepEqual(unparsed, [])
  })

  it('keeps a line it cannot parse rather than dropping it', () => {
    // A dropped line is how a run that printed nothing recognizable reads as a
    // run that produced nothing at all.
    const { events, unparsed } = parseEvents('not json\n{"type":"final","text":"ok"}\n')
    assert.equal(events.length, 1)
    assert.deepEqual(unparsed, ['not json'])
  })

  it('ignores blank lines', () => {
    const { events, unparsed } = parseEvents('\n\n')
    assert.deepEqual(events, [])
    assert.deepEqual(unparsed, [])
  })
})

describe('summarize', () => {
  it('takes the final text, session id and summed usage', () => {
    const summary = summarize([
      { type: 'session', sessionId: 'session-abc', cwd: '/tmp' },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
      { type: 'final', text: 'the answer' },
    ])
    assert.equal(summary.final, 'the answer')
    assert.equal(summary.sessionId, 'session-abc')
    assert.equal(summary.steps, 2)
    assert.equal(summary.usage.inputTokens, 15)
    assert.equal(summary.usage.outputTokens, 3)
    assert.deepEqual(summary.reason, { kind: 'completed' })
  })

  it('reports no final answer rather than an empty one when the run never settled', () => {
    const summary = summarize([{ type: 'status', phase: 'step_start' }])
    assert.equal(summary.final, undefined)
    assert.equal(summary.steps, 0)
  })

  it('counts a step whose usage is missing without inventing tokens for it', () => {
    const summary = summarize([{ type: 'status', phase: 'step_end' }])
    assert.equal(summary.steps, 1)
    assert.equal(summary.usage.totalTokens, 0)
  })
})

describe('parseSummary', () => {
  it('reads the counts node --test prints', () => {
    const summary = parseSummary('# tests 11\n# pass 7\n# fail 4\n')
    assert.deepEqual(summary, { tests: 11, pass: 7, fail: 4 })
  })

  it('is undefined when no summary was printed, so silence is not a pass', () => {
    // This is the difference between "the suite passed" and "the suite never
    // ran", and a scorer that conflates them is worse than no scorer.
    assert.equal(parseSummary('sh: node: command not found\n'), undefined)
    assert.equal(parseSummary(''), undefined)
  })
})

describe('variants', () => {
  it('mounts nothing for the off arm', () => {
    assert.deepEqual(VARIANTS.off, [])
    assert.ok(overlayFor('off').startsWith('#'))
  })

  it('mounts every local bundle for the on arm', () => {
    const overlay = overlayFor('on')
    for (const pkg of LOCAL_BUNDLES) {
      assert.ok(overlay.includes(pkg.replace(/^dsh-/, '')), `overlay is missing ${pkg}`)
    }
  })

  it('excludes edit-feedback from the on arm, because it is unmounted for real', () => {
    assert.ok(!LOCAL_BUNDLES.includes('dsh-edit-feedback'))
    assert.ok(VARIANTS['edit-feedback'].includes('dsh-edit-feedback'))
  })

  it('resolves an entry that exists for every listed package', () => {
    for (const pkg of Object.values(VARIANTS).flat()) {
      assert.match(entryOf(pkg), /index\.ts$/)
    }
  })

  it('refuses an unknown variant', () => {
    assert.throws(() => overlayFor('nope'), /unknown variant/)
  })
})
