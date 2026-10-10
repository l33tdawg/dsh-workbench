/** The gate's decision surface: who is gated, and what satisfies the gate. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  currentTurn, gate, matchesToolName, mutatesFiles, recalledInTurn, resolveConfig,
} from '../src/recall.ts'
import type { SessionEvent } from '../src/recall.ts'

const config = resolveConfig()

/** A turn boundary, then the events of that turn. */
function turn(events: SessionEvent[] = [], turnNo = 1): SessionEvent[] {
  return [{ type: 'turn/start', data: { turn: turnNo } }, ...events]
}

/** A completed recall, as the durable log records one. */
function recallCall(callId = 'c1', tool = 'mcp__sage__sage_turn'): SessionEvent[] {
  return [
    { type: 'tool/call', data: { callId, name: tool, arguments: '{}' } },
    { type: 'tool/result', data: { callId, message: { isError: false } } },
  ]
}

describe('tool name matching', () => {
  it('matches a bare name and an MCP-namespaced one', () => {
    assert.ok(matchesToolName('sage_turn', ['sage_turn']))
    assert.ok(matchesToolName('mcp__sage__sage_turn', ['sage_turn']))
  })

  it('does not match a name that merely contains the candidate', () => {
    assert.equal(matchesToolName('sage_turn_extra', ['sage_turn']), false)
    assert.equal(matchesToolName('not_sage_turn', ['sage_turn']), false)
  })

  it('matches the tool segment inside a deeper namespace', () => {
    assert.ok(matchesToolName('mcp__fs__apply_patch', ['apply_patch']))
  })
})

describe('which calls are gated', () => {
  it('gates the file-mutating tools', () => {
    for (const tool of ['edit', 'write', 'apply_patch']) {
      assert.equal(gate({ name: tool, args: {} }, turn(), config).kind, 'deny', tool)
    }
  })

  // A namespaced write is gated on its own segment, so `mcp__fs__write` is a
  // write wherever it is mounted from.
  it('gates a namespaced write', () => {
    assert.equal(gate({ name: 'mcp__fs__apply_patch', args: {} }, turn(), config).kind, 'deny')
    assert.equal(gate({ name: 'mcp__fs__write', args: {} }, turn(), config).kind, 'deny')
  })

  it('never gates a read', () => {
    for (const tool of ['read', 'grep', 'glob', 'bash', 'sage_recall']) {
      assert.equal(gate({ name: tool, args: {} }, turn(), config).kind, 'allow', tool)
    }
  })

  // `str_replace_editor` is the one write tool that also reads.
  it('gates only the mutating str_replace_editor commands', () => {
    for (const command of ['create', 'str_replace', 'insert']) {
      assert.equal(gate({ name: 'str_replace_editor', args: { command } }, turn(), config).kind, 'deny', command)
    }
    for (const command of ['view', 'undo_edit']) {
      assert.equal(gate({ name: 'str_replace_editor', args: { command } }, turn(), config).kind, 'allow', command)
    }
    assert.equal(mutatesFiles('str_replace_editor', { command: 'view' }), false)
  })
})

describe('what satisfies the gate', () => {
  it('denies a write in a turn with no recall', () => {
    const verdict = gate({ name: 'edit', args: {} }, turn(), config)
    assert.equal(verdict.kind, 'deny')
    assert.match(verdict.kind === 'deny' ? verdict.reason : '', /sage_turn/)
    assert.match(verdict.kind === 'deny' ? verdict.reason : '', /retry this call/)
  })

  it('allows a write after a completed recall', () => {
    assert.equal(gate({ name: 'edit', args: {} }, turn(recallCall()), config).kind, 'allow')
  })

  it('allows a bare, non-namespaced recall', () => {
    assert.equal(gate({ name: 'edit', args: {} }, turn(recallCall('c1', 'sage_turn')), config).kind, 'allow')
  })

  // The gate is about this turn: a recall before the boundary cannot license
  // writes that happen after it, because the relevant memory is the one that
  // exists now.
  it('does not count a recall from an earlier turn', () => {
    const events = [...turn(recallCall(), 1), { type: 'turn/start', data: { turn: 2 } }]
    assert.equal(recalledInTurn(currentTurn(events).events, config.recallTools), false)
    assert.equal(gate({ name: 'edit', args: {} }, events, config).kind, 'deny')
  })

  it('does not count a recall that failed', () => {
    const failed: SessionEvent[] = [
      { type: 'tool/call', data: { callId: 'c1', name: 'mcp__sage__sage_turn' } },
      { type: 'tool/result', data: { callId: 'c1', message: { isError: true } } },
    ]
    assert.equal(gate({ name: 'edit', args: {} }, turn(failed), config).kind, 'deny')
  })

  // The durable log records the pairing id in either place depending on which
  // variant wrote the record.
  it('pairs a result by message.toolCallId as well as callId', () => {
    const viaMessage: SessionEvent[] = [
      { type: 'tool/call', data: { callId: 'c1', name: 'mcp__sage__sage_turn' } },
      { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } },
    ]
    assert.equal(gate({ name: 'edit', args: {} }, turn(viaMessage), config).kind, 'allow')
  })

  it('does not count a recall with no id to pair', () => {
    const anonymous: SessionEvent[] = [{ type: 'tool/call', data: { name: 'sage_turn' } }]
    assert.equal(gate({ name: 'edit', args: {} }, turn(anonymous), config).kind, 'deny')
  })

  it('does not count a recall still in flight', () => {
    // The attempt exists, with no result yet: nothing has been read.
    const inFlight: SessionEvent[] = [{ type: 'tool/call', data: { callId: 'c1', name: 'sage_turn' } }]
    assert.equal(gate({ name: 'edit', args: {} }, turn(inFlight), config).kind, 'deny')
  })

  it('ignores a recall by an unrelated tool', () => {
    assert.equal(gate({ name: 'edit', args: {} }, turn(recallCall('c1', 'some_other_turn')), config).kind, 'deny')
  })

  it('opens the gate on an empty log only when the gate is off', () => {
    assert.equal(gate({ name: 'edit', args: {} }, [], config).kind, 'deny')
    assert.equal(gate({ name: 'edit', args: {} }, [], resolveConfig({ enabled: false })).kind, 'allow')
  })
})

describe('configuration', () => {
  it('accepts a profile that names its own recall tool', () => {
    const custom = resolveConfig({ recallTools: ['my_recall'] })
    assert.equal(gate({ name: 'edit', args: {} }, turn(recallCall('c1', 'my_recall')), custom).kind, 'allow')
    const verdict = gate({ name: 'edit', args: {} }, [], custom)
    assert.equal(verdict.kind, 'deny')
    assert.match(verdict.kind === 'deny' ? verdict.reason : '', /my_recall/)
  })

  // An empty list would deny every write forever, or never deny anything.
  // Both are more likely a profile mistake than an intention.
  it('rejects an empty tool list instead of defaulting it', () => {
    assert.throws(() => resolveConfig({ recallTools: [] }), /non-empty array/)
    assert.throws(() => resolveConfig({ writeTools: [] }), /non-empty array/)
    assert.throws(() => resolveConfig({ recallTools: [''] }), /non-empty array/)
  })

  it('reads both Session log APIs', () => {
    assert.equal(currentTurn([{ type: 'turn/start', data: { turn: 7 } }]).turn, 7)
    assert.equal(currentTurn([]).turn, undefined)
    assert.deepEqual(currentTurn([]).events, [])
  })
})
