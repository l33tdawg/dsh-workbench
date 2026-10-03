/**
 * Tests for the escalation census.
 *
 * This census is the evidence for dropping Codex-parity item 14, so its
 * reading of the record is worth pinning. Two mistakes it was written through
 * are the ones to guard: the marker string appears in the system prompt, in
 * the bash tool's own description, and in any file that quotes either, so a
 * text search finds denials that are not there; and a result's call id lives
 * at `data.message.toolCallId`, so reading `data.toolCallId` yields `undefined`
 * for every result and silently reports zero re-issues rather than failing.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DENIAL_LINE, ECHO_TOOLS, askedEscalation, deniedMode, escalationMetrics, resultCallId,
} from './escalation-census.mjs'

/** The marker line the sandbox renders. */
const MARKER = '[sandbox: file access denied under workspace-write mode]'

/** One `tool/call` record. */
function call(callId, name, args, turn = 1, step = 1) {
  return { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args), turn, step } }
}

/** One `tool/result` record answering a call. */
function result(callId, text, turn = 1, step = 2) {
  return { type: 'tool/result', data: { turn, step, message: { toolCallId: callId, content: [{ type: 'text', text }] } } }
}

describe('deniedMode', () => {
  it('reads the mode from a marker on its own line', () => {
    assert.equal(deniedMode(result('c1', `mv: Operation not permitted\n${MARKER}\n`)), 'workspace-write')
  })

  it('refuses a marker that is not alone on its line', () => {
    assert.equal(deniedMode(result('c1', `note: ${MARKER} and more\n`)), undefined)
  })

  it('refuses a result that merely quotes the marker inside source', () => {
    // This is the shape that made a text search report 49 denials where there
    // was one: an agent reading a file that discusses the marker.
    const quoted = "97: return `[sandbox: file access denied under ${mode} mode]`"
    assert.equal(deniedMode(result('c1', quoted)), undefined)
  })

  it('is unmoved by a result with no text blocks at all', () => {
    assert.equal(deniedMode({ type: 'tool/result', data: { message: { content: [{ type: 'image' }] } } }), undefined)
    assert.equal(deniedMode({ type: 'tool/result', data: {} }), undefined)
  })

  it('exposes the pattern it matches', () => {
    assert.equal(DENIAL_LINE.test(MARKER), true)
  })
})

describe('resultCallId', () => {
  it('reads the id from inside the message, not from the record', () => {
    assert.equal(resultCallId(result('call_abc', 'x')), 'call_abc')
  })

  it('falls back to the message source', () => {
    const record = { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call_xyz' } } } }
    assert.equal(resultCallId(record), 'call_xyz')
  })

  it('is undefined for a record that carries no id', () => {
    assert.equal(resultCallId({ type: 'tool/result', data: { toolCallId: 'call_top_level' } }), undefined)
  })
})

describe('askedEscalation', () => {
  it('is true when either escalation field is present', () => {
    assert.equal(askedEscalation(call('c1', 'bash', { command: 'ls', sandbox_permissions: 'danger-full-access' }).data), true)
    assert.equal(askedEscalation(call('c1', 'bash', { command: 'ls', justification: 'why' }).data), true)
  })

  it('is false for an ordinary call', () => {
    assert.equal(askedEscalation(call('c1', 'bash', { command: 'ls' }).data), false)
  })

  it('is false rather than throwing on unparsable arguments', () => {
    assert.equal(askedEscalation({ arguments: 'not json' }), false)
    assert.equal(askedEscalation({}), false)
  })
})

describe('escalationMetrics', () => {
  it('counts a denial and the same-tool escalation that answered it', () => {
    const metrics = escalationMetrics([
      call('c1', 'bash', { command: 'mv a b' }, 3, 129),
      result('c1', `mv: Operation not permitted\n${MARKER}\n`, 3, 129),
      call('c2', 'bash', { command: 'mv a b', sandbox_permissions: 'danger-full-access' }, 3, 130),
    ])
    assert.equal(metrics.denials, 1)
    assert.equal(metrics.reissued, 1)
    assert.equal(metrics.abandoned, 0)
    assert.equal(metrics.details[0].name, 'bash')
    assert.equal(metrics.details[0].turnDelta, 0)
    assert.equal(metrics.details[0].stepDelta, 1)
    assert.equal(metrics.escalationsWithoutDenial, 0)
  })

  it('counts a denial nothing escalated past as abandoned', () => {
    const metrics = escalationMetrics([
      call('c1', 'bash', { command: 'mv a b' }),
      result('c1', MARKER),
      call('c2', 'read', { file_path: '/tmp/x' }),
    ])
    assert.equal(metrics.denials, 1)
    assert.equal(metrics.reissued, 0)
    assert.equal(metrics.abandoned, 1)
  })

  it('counts an escalation with no denial before it as pre-emptive', () => {
    const metrics = escalationMetrics([
      call('c1', 'read', { file_path: '/tmp/x' }),
      result('c1', 'the file contents'),
      call('c2', 'bash', { command: 'install', sandbox_permissions: 'danger-full-access' }),
    ])
    assert.equal(metrics.denials, 0)
    assert.equal(metrics.escalationsWithoutDenial, 1)
  })

  it('does not read a denial out of a read result that quotes the marker', () => {
    const quoted = `2: const DENIAL = '[sandbox: file access denied under workspace-write mode]'`
    const metrics = escalationMetrics([
      call('c1', 'read', { file_path: '/tmp/source.ts' }),
      result('c1', quoted),
      call('c2', 'bash', { command: 'ls', sandbox_permissions: 'danger-full-access' }),
    ])
    assert.equal(metrics.denials, 0)
    assert.equal(metrics.escalationsWithoutDenial, 1)
  })

  it('will not let one escalation answer two denials', () => {
    const metrics = escalationMetrics([
      call('c1', 'bash', { command: 'first' }),
      result('c1', MARKER),
      call('c2', 'bash', { command: 'second' }),
      result('c2', MARKER),
      call('c3', 'bash', { command: 'first', sandbox_permissions: 'danger-full-access' }),
    ])
    assert.equal(metrics.denials, 2)
    assert.equal(metrics.reissued, 1)
    assert.equal(metrics.abandoned, 1)
    assert.equal(metrics.escalationsWithoutDenial, 0)
  })

  it('counts an escalation of a different tool as pre-emptive, not as an answer', () => {
    const metrics = escalationMetrics([
      call('c1', 'bash', { command: 'mv a b' }),
      result('c1', MARKER),
      call('c2', 'edit', { file_path: '/tmp/x', sandbox_permissions: 'danger-full-access' }),
    ])
    assert.equal(metrics.reissued, 0)
    assert.equal(metrics.escalationsWithoutDenial, 1)
  })

  it('reports the modes that were denied', () => {
    const metrics = escalationMetrics([
      call('c1', 'bash', { command: 'a' }),
      result('c1', MARKER),
    ])
    assert.deepEqual(metrics.byMode, { 'workspace-write': 1 })
  })

  it('names the tools whose output is not evidence', () => {
    for (const tool of ['read', 'grep', 'glob']) assert.equal(ECHO_TOOLS.has(tool), true)
  })
})
