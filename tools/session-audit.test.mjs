/**
 * Tests for the session audit.
 *
 * The counters are the evidence for a claim about harness quality, so they need
 * to be right. The retry counter in particular shipped broken once: it read a
 * call id that was never recorded, so it silently degenerated into a second
 * copy of the repeat counter. These cases pin each counter to a distinct
 * situation, which is what makes that class of bug visible.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { audit, parseSession } from '../tools/session-audit.mjs'

/** A tool call record. */
function call(callId, name, args) {
  return { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } }
}

/** A tool result record. */
function result(callId, isError = false) {
  return { type: 'tool/result', data: { message: { toolCallId: callId, isError, content: [] } } }
}

describe('audit', () => {
  it('counts nothing for a clean session', () => {
    const counts = audit([
      call('1', 'read', { file_path: 'a.ts' }), result('1'),
      call('2', 'edit', { file_path: 'a.ts' }), result('2'),
      call('3', 'read', { file_path: 'b.ts' }), result('3'),
    ])
    assert.deepEqual(counts, {
      toolCalls: 3, filesEdited: 1, rework: 0, readAfterEdit: 0, repeatCall: 0, retryAfterFail: 0, undoEvents: 0,
    })
  })

  it('counts a read that follows an edit of the same file', () => {
    const counts = audit([
      call('1', 'edit', { file_path: 'a.ts' }), result('1'),
      call('2', 'read', { file_path: 'a.ts' }), result('2'),
    ])
    assert.equal(counts.readAfterEdit, 1)
  })

  it('does not count a read that came before the edit', () => {
    const counts = audit([
      call('1', 'read', { file_path: 'a.ts' }), result('1'),
      call('2', 'edit', { file_path: 'a.ts' }), result('2'),
    ])
    assert.equal(counts.readAfterEdit, 0)
  })

  it('counts rework once at the third edit, not again after', () => {
    const six = []
    for (let i = 1; i <= 6; i++) {
      six.push(call(String(i), 'edit', { file_path: 'a.ts' }), result(String(i)))
    }
    assert.equal(audit(six).rework, 1)
  })

  it('does not count rework at two edits', () => {
    const counts = audit([
      call('1', 'edit', { file_path: 'a.ts' }), result('1'),
      call('2', 'edit', { file_path: 'a.ts' }), result('2'),
    ])
    assert.equal(counts.rework, 0)
  })

  it('counts an identical call back to back', () => {
    const counts = audit([
      call('1', 'bash', { command: 'ls' }), result('1'),
      call('2', 'bash', { command: 'ls' }), result('2'),
    ])
    assert.equal(counts.repeatCall, 1)
    // Not a retry: the first call succeeded.
    assert.equal(counts.retryAfterFail, 0)
  })

  // The distinction the broken version could not make.
  it('counts an unchanged retry only when the previous call failed', () => {
    const counts = audit([
      call('1', 'bash', { command: 'npm test' }), result('1', true),
      call('2', 'bash', { command: 'npm test' }), result('2'),
    ])
    assert.equal(counts.repeatCall, 1)
    assert.equal(counts.retryAfterFail, 1)
  })

  it('does not count a changed retry as a retry', () => {
    const counts = audit([
      call('1', 'bash', { command: 'npm test' }), result('1', true),
      call('2', 'bash', { command: 'npm test -- --run' }), result('2'),
    ])
    assert.equal(counts.repeatCall, 0)
    assert.equal(counts.retryAfterFail, 0)
  })

  it('totals the four counters', () => {
    const counts = audit([
      call('1', 'edit', { file_path: 'a.ts' }), result('1'),
      call('2', 'read', { file_path: 'a.ts' }), result('2'),
      call('3', 'bash', { command: 'x' }), result('3', true),
      call('4', 'bash', { command: 'x' }), result('4'),
      // Distinct arguments, so these three edits count as rework alone and do
      // not also register as repeat calls.
      call('5', 'edit', { file_path: 'b.ts', old_string: '1' }), result('5'),
      call('6', 'edit', { file_path: 'b.ts', old_string: '2' }), result('6'),
      call('7', 'edit', { file_path: 'b.ts', old_string: '3' }), result('7'),
    ])
    assert.equal(counts.undoEvents, counts.rework + counts.readAfterEdit + counts.repeatCall + counts.retryAfterFail)
    assert.equal(counts.rework, 1)
    assert.equal(counts.readAfterEdit, 1)
    assert.equal(counts.repeatCall, 1)
    assert.equal(counts.retryAfterFail, 1)
    assert.equal(counts.undoEvents, 4)
  })

  // Three identical edits are three calls with one identity, so they are both
  // rework and repetition. Worth pinning, because the double count is correct
  // and looks like a bug.
  it('counts a repeated identical edit as both rework and repetition', () => {
    const counts = audit([
      call('1', 'edit', { file_path: 'a.ts' }), result('1'),
      call('2', 'edit', { file_path: 'a.ts' }), result('2'),
      call('3', 'edit', { file_path: 'a.ts' }), result('3'),
    ])
    assert.equal(counts.rework, 1)
    assert.equal(counts.repeatCall, 2)
  })

  it('ignores a call whose arguments cannot be read', () => {
    const counts = audit([
      { type: 'tool/call', data: { callId: '1', name: 'edit', arguments: '{ not json' } },
      result('1'),
    ])
    assert.equal(counts.toolCalls, 1)
    assert.equal(counts.filesEdited, 0)
  })

  it('survives a session with no tool calls', () => {
    assert.equal(audit([{ type: 'turn/start', data: {} }]).undoEvents, 0)
  })
})

describe('parseSession', () => {
  it('drops a truncated tail rather than throwing', () => {
    const text = '{"type":"tool/call","data":{}}\n{"type":"tool/ca'
    assert.equal(parseSession(text).length, 1)
  })

  it('skips blank lines', () => {
    assert.equal(parseSession('\n{"a":1}\n\n').length, 1)
  })
})
