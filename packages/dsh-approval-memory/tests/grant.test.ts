/**
 * Tests for session-scoped grants.
 *
 * The grant is the part of this plugin with the widest blast radius: it can
 * answer an ask no rule mentions. So the tests are mostly about what does NOT
 * qualify - a fresh session, a different tool, a different mode, a decision
 * that was not an allow - and about the pending request never serving as its
 * own basis.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { escalationMode, sessionGrantBasis } from '../src/grant.ts'

/** An `approval/asked` record. */
function asked(id, toolName, reason, callId) {
  return { type: 'approval/asked', data: { id, toolName, reason, callId } }
}

/** An `approval/decided` record. */
function decided(id, outcome) {
  return { type: 'approval/decided', data: { id, outcome } }
}

const ESCALATE = 'escalate sandbox to danger-full-access: the file is outside the workspace'
const request = { toolName: 'bash', callId: 'call_2', reason: 'escalate sandbox to danger-full-access: another file' }

describe('escalationMode', () => {
  it('reads the widened mode', () => {
    assert.equal(escalationMode(ESCALATE), 'danger-full-access')
    assert.equal(escalationMode('escalate sandbox to workspace-write'), 'workspace-write')
  })

  it('returns nothing for a non-escalation ask', () => {
    assert.equal(escalationMode('plugin_manager install_bundle. Profile changes persist across sessions'), undefined)
    assert.equal(escalationMode(undefined), undefined)
  })
})

describe('sessionGrantBasis', () => {
  const tools = ['bash']

  it('grants after an earlier allow of the same tool and mode', () => {
    const basis = sessionGrantBasis(
      [asked('a1', 'bash', ESCALATE, 'call_1'), decided('a1', 'allowed-once'), asked('a2', 'bash', request.reason, 'call_2')],
      request,
      tools,
    )
    assert.deepEqual(basis, { askId: 'a1', mode: 'danger-full-access', tool: 'bash' })
  })

  it('grants nothing in a fresh session', () => {
    assert.equal(sessionGrantBasis([asked('a1', 'bash', request.reason, 'call_2')], request, tools), undefined)
  })

  it('does not use the pending request as its own basis', () => {
    const basis = sessionGrantBasis([asked('a1', 'bash', request.reason, 'call_2'), decided('a1', 'allowed-once')], request, tools)
    assert.equal(basis, undefined)
  })

  it('grants nothing for a tool outside the configured list', () => {
    const events = [asked('a1', 'bash', ESCALATE, 'call_1'), decided('a1', 'allowed-once'), asked('a2', 'bash', request.reason, 'call_2')]
    assert.equal(sessionGrantBasis(events, request, []), undefined)
    assert.equal(sessionGrantBasis(events, request, ['edit']), undefined)
  })

  it('grants nothing for a different tool', () => {
    const events = [asked('a1', 'edit', ESCALATE, 'call_1'), decided('a1', 'allowed-once'), asked('a2', 'bash', request.reason, 'call_2')]
    assert.equal(sessionGrantBasis(events, request, ['bash', 'edit']), undefined)
  })

  it('grants nothing for a different widened mode', () => {
    const events = [
      asked('a1', 'bash', 'escalate sandbox to workspace-write', 'call_1'),
      decided('a1', 'allowed-once'),
      asked('a2', 'bash', request.reason, 'call_2'),
    ]
    assert.equal(sessionGrantBasis(events, request, tools), undefined)
  })

  it('grants nothing when the earlier ask was not allowed', () => {
    for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
      const events = [asked('a1', 'bash', ESCALATE, 'call_1'), decided('a1', outcome), asked('a2', 'bash', request.reason, 'call_2')]
      assert.equal(sessionGrantBasis(events, request, tools), undefined, outcome)
    }
  })

  it('grants nothing when the earlier ask was never decided', () => {
    const events = [asked('a1', 'bash', ESCALATE, 'call_1'), asked('a2', 'bash', request.reason, 'call_2')]
    assert.equal(sessionGrantBasis(events, request, tools), undefined)
  })

  it('grants nothing when the ask is not an escalation at all', () => {
    const plain = { toolName: 'bash', callId: 'call_2', reason: 'the plugin runs outside the sandbox' }
    const events = [asked('a1', 'bash', ESCALATE, 'call_1'), decided('a1', 'allowed-once')]
    assert.equal(sessionGrantBasis(events, plain, tools), undefined)
  })

  it('still grants when the pending request carries no call id', () => {
    const noCallId = { toolName: 'bash', reason: request.reason }
    const events = [asked('a1', 'bash', ESCALATE, 'call_1'), decided('a1', 'allowed-once'), asked('a2', 'bash', request.reason)]
    assert.deepEqual(sessionGrantBasis(events, noCallId, tools)?.askId, 'a1')
  })
})
