/** The real hook, a session-shaped log, and the pipeline decision it returns. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply, name } from '../src/index.ts'
import type { Config } from '../src/recall.ts'

/** One `tools/pre-execute` listener over a controllable session log. */
function host(config: Config = {}) {
  const hooks = new Map<string, (...args: any[]) => any>()
  const events: any[] = [{ type: 'turn/start', data: { turn: 1 } }]
  const ctx = {
    on: (event: string, hook: (...args: any[]) => any) => { hooks.set(event, hook) },
    logger: { warn: () => {} },
  }
  apply(ctx as never, config)
  return {
    hooks, events,
    /** Dispatch a pending call through the registered listener. */
    call: async (toolName: string, args: unknown = {}, downstream: unknown = { kind: 'allow' }) =>
      hooks.get('tools/pre-execute')!(
        { name: toolName, arguments: args, agent: { session: { events } } },
        async () => downstream,
      ),
    /** Record a completed recall the way the durable log does. */
    recall: () => {
      events.push({ type: 'tool/call', data: { callId: 'c1', name: 'mcp__sage__sage_turn' } })
      events.push({ type: 'tool/result', data: { callId: 'c1', message: { isError: false } } })
    },
    newTurn: (turn: number) => { events.push({ type: 'turn/start', data: { turn } }) },
  }
}

describe('recall gate wiring', () => {
  it('denies the first write of a turn and names the tool to call', async () => {
    const h = host()
    const decision = await h.call('edit', { file_path: 'src/A.ts' })
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /sage_turn/)
  })

  it('allows the write once the turn has recalled', async () => {
    const h = host()
    assert.equal((await h.call('edit')).kind, 'deny')
    h.recall()
    assert.equal((await h.call('edit')).kind, 'allow')
  })

  it('reopens the gate on the next turn', async () => {
    const h = host()
    h.recall()
    assert.equal((await h.call('edit')).kind, 'allow')
    h.newTurn(2)
    assert.equal((await h.call('edit')).kind, 'deny')
  })

  it('never denies a read, whatever the turn has done', async () => {
    const h = host()
    for (const tool of ['read', 'grep', 'bash']) assert.equal((await h.call(tool)).kind, 'allow')
  })

  it('gates only the mutating str_replace_editor commands', async () => {
    const h = host()
    assert.equal((await h.call('str_replace_editor', { command: 'view' })).kind, 'allow')
    assert.equal((await h.call('str_replace_editor', { command: 'str_replace' })).kind, 'deny')
  })

  // The pipeline's own refusal must survive this listener. An approval that
  // never came, or a sandbox denial, is not a decision to soften into `allow`.
  it('leaves a decision the pipeline already reached alone', async () => {
    const h = host()
    h.recall()
    const denied = { kind: 'deny', reason: 'sandbox' }
    assert.deepEqual(await h.call('edit', {}, denied), denied)
    const asked = { kind: 'ask', reason: 'needs approval' }
    assert.deepEqual(await h.call('edit', {}, asked), asked)
  })

  it('registers no hook when disabled', () => {
    assert.equal(host({ enabled: false }).hooks.size, 0)
  })

  it('exports the plugin name', () => {
    assert.equal(name, 'recall-gate')
  })
})
