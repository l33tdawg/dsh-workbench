import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { combineMetrics, reliabilityMetrics, runCensus } from './reliability-census.mjs'
import { frameBytes } from './session-audit.mjs'

const start = turn => ({ type: 'turn/start', data: { turn } })
const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const call = (id, name = 'edit', path = 'a.ts') => ({ type: 'tool/call', data: { callId: id, name, arguments: JSON.stringify({ file_path: path }) } })
const result = (id, isError = false) => ({ type: 'tool/result', data: { message: { toolCallId: id, isError, content: [] } } })
const notice = (kind, summary, text = 'bounded output') => ({ type: 'user/message', data: { source: { kind, summary }, content: [{ type: 'text', text }] } })
const check = status => notice('verify-on-edit', `verify-on-edit: ${status}`)

describe('reliability metrics', () => {
  it('does not call silent or legacy checks passed', () => {
    const m = reliabilityMetrics([start(1), call('a'), result('a'), notice('verify-on-edit', 'typecheck failed after an edit'), end(1)])
    assert.equal(m.legacyVerificationNotices, 1)
    assert.equal(m.verification.passed, 0)
    assert.equal(m.editedTurnsWithoutVerificationNotice, 1)
  })
  it('distinguishes a checked final edit from an edit after the last check', () => {
    const clean = [start(1), call('a'), result('a'), check('passed')]
    assert.equal(reliabilityMetrics([...clean, end(1)]).editedTurnsEndingAfterLastObservedCheck, 0)
    assert.equal(reliabilityMetrics([...clean, call('b'), result('b'), end(1)]).editedTurnsEndingAfterLastObservedCheck, 1)
  })
  it('records failure, timeout, no-check and unparsed as distinct outcomes', () => {
    const statuses = ['failed', 'timed-out', 'unavailable', 'no-check', 'unparsed']
    const m = reliabilityMetrics([start(1), call('a'), result('a'), ...statuses.map(check), end(1)])
    for (const status of statuses) assert.equal(m.verification[status], 1)
    assert.equal(m.editedTurnsWithLastCheckNotPassed, 1)
  })
  it('does not mistake quoted reports in model output or file reads for delivered notices', () => {
    const fake = check('passed')
    const m = reliabilityMetrics([{ ...fake, type: 'assistant/message' }, { type: 'tool/result', data: { message: fake.data } }, notice('user', 'verify-on-edit: passed')])
    assert.equal(m.verification.passed, 0)
  })
  it('counts successful direct-path readbacks, not failed edits or reads before edits', () => {
    const m = reliabilityMetrics([call('r', 'read'), call('a'), result('a', true), call('r2', 'read'), call('b'), result('b'), call('r3', 'read')])
    assert.equal(m.readAfterSuccessfulEdit, 1)
    assert.equal(m.successfulEdits, 1)
    assert.equal(m.failedEdits, 1)
  })
  it('also reads nested tool-result blocks from newer SDKs', () => {
    const nested = (id, isError) => ({ type: 'tool/result', data: { message: {
      source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, isError, content: [] }],
    } } })
    const m = reliabilityMetrics([call('a'), nested('a', true), call('b'), nested('b', false)])
    assert.equal(m.failedEdits, 1)
    assert.equal(m.successfulEdits, 1)
  })
  it('counts only mutating str_replace_editor commands as edits', () => {
    const editor = (id, command) => ({ type: 'tool/call', data: {
      callId: id, name: 'str_replace_editor', arguments: JSON.stringify({ command, path: 'a.ts' }),
    } })
    const viewed = reliabilityMetrics([start(1), editor('view', 'view'), result('view'),
      editor('failed-view', 'view'), result('failed-view', true), end(1)])
    assert.equal(viewed.successfulEdits, 0)
    assert.equal(viewed.failedEdits, 0)
    assert.equal(viewed.completedTurnsWithEdits, 0)
    assert.equal(viewed.editedTurnsWithoutVerificationNotice, 0)
    const changed = reliabilityMetrics([start(1),
      ...['create', 'str_replace', 'insert'].flatMap(command => [editor(command, command), result(command)]),
      editor('unknown', 'unknown'), result('unknown'), end(1)])
    assert.equal(changed.successfulEdits, 3)
    assert.equal(changed.completedTurnsWithEdits, 1)
  })
  it('only flags current-turn todos on completed turns', () => {
    const todos = { type: 'todo/write', data: { todos: [{ content: 'remaining', status: 'pending' }] } }
    const m = reliabilityMetrics([start(1), todos, end(1, 'aborted'), start(2), end(2), start(3), todos, end(3)])
    assert.equal(m.completedTurnsWithOpenCurrentTurnTodos, 1)
    assert.equal(m.completedTurns, 2)
  })
  it('recognizes identical compaction notices only within their own boundary', () => {
    const boundary = { type: 'compaction/end', data: {} }
    const reminder = notice('compaction-todo', 'recovery', 'the plan')
    const m = reliabilityMetrics([boundary, reminder, reminder, boundary, reminder])
    assert.equal(m.compactionReminders, 3)
    assert.equal(m.duplicateCompactionReminders, 1)
  })
  it('does not treat a failed compaction as a new lost-context boundary', () => {
    const reminder = notice('compaction-todo', 'recovery', 'the plan')
    const m = reliabilityMetrics([reminder, { type: 'compaction/end', data: { error: 'cancelled' } }, reminder])
    assert.equal(m.duplicateCompactionReminders, 1)
  })
  it('records approval decisions without calling them human prompts', () => {
    const m = reliabilityMetrics([{ type: 'approval/asked', data: { id: 'a' } }, { type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } }])
    assert.equal(m.approvalRequests, 1)
    assert.equal(m.approvalAllowed, 1)
  })
  it('counts continuation notices and combines every outcome', () => {
    const m = reliabilityMetrics([notice('completion-guard', 'Finish pending work'), check('passed')])
    assert.equal(combineMetrics([m, m]).completionContinuations, 2)
    assert.equal(combineMetrics([m, m]).verification.passed, 2)
  })
})

describe('compressed session census', () => {
  it('reads multiple frames and selects whole sessions by creation time', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-census-'))
    try {
      for (const [id, createdAt] of [['old', '2026-10-02T00:00:00Z'], ['new', '2026-10-03T00:00:00Z']]) {
        const dir = join(root, 'workspace', id)
        mkdirSync(dir, { recursive: true })
        const header = { type: 'session', createdAt: Date.parse(createdAt) }
        const body = [start(1), call('a'), result('a'), check('passed'), end(1)]
        writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
          frameBytes(JSON.stringify(header) + '\n'),
          frameBytes(body.map(record => JSON.stringify(record)).join('\n') + '\n'),
        ]))
      }
      const all = runCensus({ root })
      assert.equal(all.sessions, 2)
      assert.equal(all.metrics.verification.passed, 2)
      const after = runCensus({ root, since: Date.parse('2026-10-02T12:00:00Z') })
      assert.equal(after.sessions, 1)
      assert.equal(after.metrics.successfulEdits, 1)
      assert.equal(after.metrics.editedTurnsWithoutVerificationNotice, 0)
      assert.equal(runCensus({ root, session: 'absent' }).sessions, 0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
