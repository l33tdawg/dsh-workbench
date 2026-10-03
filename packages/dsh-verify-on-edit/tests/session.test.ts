import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { currentTurnEvents, recoverEditedPaths } from '../src/session.ts'

const call = (id: string, name = 'edit', args: unknown = { file_path: `src/${id}.ts` }) => ({
  type: 'tool/call', data: { callId: id, name, arguments: JSON.stringify(args) },
})
const result = (id: string, isError = false) => ({ type: 'tool/result', data: { message: { callId: id, isError } } })

describe('reload recovery from the current turn', () => {
  it('ignores old turns and uncompleted or failed calls', () => {
    const session = { events: [
      { type: 'turn/start', data: { turn: 1 } }, call('old'), result('old'),
      { type: 'turn/start', data: { turn: 2 } }, call('good'), result('good'),
      call('failed'), result('failed', true), call('unfinished'), call('read', 'read'), result('read'),
    ] }
    const current = currentTurnEvents(session)
    assert.equal(current.turn, 2)
    assert.deepEqual(recoverEditedPaths(current.events, '/repo'), ['/repo/src/good.ts'])
  })
  it('reads every file in a successful patch and prefers result paths', () => {
    const events = [call('patch', 'apply_patch', { patch: '*** Add File: a.ts\n+x\n*** Update File: b.ts\n@@\n-x\n+y' }), result('patch')]
    assert.deepEqual(recoverEditedPaths(events, '/repo'), ['/repo/a.ts', '/repo/b.ts'])
    const canonical = [call('wrong'), { type: 'tool/result', data: { message: { callId: 'wrong' }, meta: { path: '/repo/actual.ts' } } }]
    assert.deepEqual(recoverEditedPaths(canonical, '/repo'), ['/repo/actual.ts'])
  })
  it('does not recover editor views as dirty files', () => {
    const events = [call('view', 'str_replace_editor', { command: 'view', path: 'read.ts' }), result('view'),
      call('insert', 'str_replace_editor', { command: 'insert', path: 'changed.ts' }), result('insert')]
    assert.deepEqual(recoverEditedPaths(events, '/repo'), ['/repo/changed.ts'])
  })
  it('does not infer pass from an earlier verification notice', () => {
    const events = [call('A'), result('A'), { type: 'user/message', data: { source: { kind: 'verify-on-edit', summary: 'verify-on-edit: passed' } } }]
    assert.deepEqual(recoverEditedPaths(events, '/repo'), ['/repo/src/A.ts'])
  })
  it('handles live flat toolCallId messages and nested failure flags', () => {
    const events = [call('flat'), { type: 'tool/result', data: { message: { toolCallId: 'flat', isError: false } } },
      call('nested-ok'), { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'nested-ok', isError: false }] } } },
      call('nested-failed'), { type: 'tool/result', data: { message: { source: { callId: 'nested-failed' }, content: [{ type: 'tool-result', toolCallId: 'nested-failed', isError: true }] } } }]
    assert.deepEqual(recoverEditedPaths(events, '/repo'), ['/repo/src/flat.ts', '/repo/src/nested-ok.ts'])
  })
  it('uses eventAt when available and declines an absent turn boundary', () => {
    const events = [{ type: 'turn/start', data: { turn: 3 } }, call('A'), result('A')]
    assert.equal(currentTurnEvents({ seq: events.length, eventAt: i => events[i] }).turn, 3)
    assert.deepEqual(currentTurnEvents({ events: [call('A'), result('A')] }).events, [])
  })
  it('ignores malformed calls and errors with structured failure identity', () => {
    const events = [{ type: 'tool/call', data: { callId: 'x', name: 'edit', arguments: '{' } }, result('x'), call('error'), { ...result('error'), data: { ...result('error').data, error: { code: 'aborted' } } }]
    assert.deepEqual(recoverEditedPaths(events, '/repo'), [])
  })
  it('recovers edits from an installed Session and its restored snapshot', () => {
    const session = Session.create('verification-recovery')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
      content: [{ type: 'tool-call', id: 'edit-A', name: 'edit', arguments: JSON.stringify({ file_path: 'src/A.ts' }) }],
      source: { provider: 'test', model: 'test' },
    }) }, { surfaceOp: 'append' })
    const started = session.append('tool/call', { turn: 1, step: 1, callId: 'edit-A', name: 'edit', arguments: JSON.stringify({ file_path: 'src/A.ts' }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'edit-A', isError: false, content: [{ type: 'text', text: 'edited' }] }) }, { surfaceOp: 'append', sourceEventSeqs: [started.seq] })
    const restored = Session.create('verification-restored', session.events)
    assert.deepEqual(recoverEditedPaths(currentTurnEvents(session).events, '/repo'), ['/repo/src/A.ts'])
    assert.deepEqual(recoverEditedPaths(currentTurnEvents(restored).events, '/repo'), ['/repo/src/A.ts'])
  })
})
