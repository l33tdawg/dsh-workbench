/**
 * The compaction-todo plugin replays a task list the model lost. What can go
 * wrong is not "does it render" but whether it takes the right list: the newest
 * write rather than an earlier one, nothing when the agent has written since the
 * compaction, and nothing when the newest write is empty.
 *
 * These cover log selection and rendering. runtime.test.ts covers the hook,
 * real message construction, tool results, and durable session replay.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { needsReminder, readReceipt, readTodos, renderReminder, scanLog, MAX_REMINDER_CHARS } from '../src/log.ts'

/** A session whose events are given oldest-first. */
function sessionOf(events) {
  return {
    seq: events.length,
    eventAt: index => events[index],
  }
}

const write = (seq, todos) => ({ type: 'todo/write', seq, data: { todos } })
const compacted = seq => ({ type: 'compaction/end', seq, data: {} })
const todo = (content, status = 'pending') => ({ content, status })

describe('readTodos', () => {
  it('reads a well-formed list', () => {
    assert.deepEqual(readTodos({ todos: [todo('one', 'in_progress')] }), [{ content: 'one', status: 'in_progress' }])
  })

  it('accepts an empty list as a list', () => {
    assert.deepEqual(readTodos({ todos: [] }), [])
  })

  it('rejects a record it cannot read rather than throwing', () => {
    assert.equal(readTodos(undefined), undefined)
    assert.equal(readTodos(null), undefined)
    assert.equal(readTodos({}), undefined)
    assert.equal(readTodos({ todos: 'nope' }), undefined)
    assert.equal(readTodos({ todos: [{ content: 'missing status' }] }), undefined)
    assert.equal(readTodos({ todos: [{ content: 7, status: 'pending' }] }), undefined)
    assert.equal(readTodos({ todos: [null] }), undefined)
  })
})

describe('scanLog', () => {
  it('finds the newest write, not the first', () => {
    const state = scanLog(sessionOf([
      write(0, [todo('old')]),
      write(1, [todo('newer')]),
      compacted(2),
    ]))
    assert.deepEqual(state.todos, [{ content: 'newer', status: 'pending' }])
    assert.equal(state.wroteAt, 1)
    assert.equal(state.compactedAt, 2)
  })

  it('finds the newest compaction', () => {
    const state = scanLog(sessionOf([compacted(0), compacted(1)]))
    assert.equal(state.compactedAt, 1)
    assert.equal(state.wroteAt, undefined)
    assert.equal(state.todos, undefined)
  })

  it('reports absent state for an empty log', () => {
    const state = scanLog(sessionOf([]))
    assert.equal(state.compactedAt, undefined)
    assert.equal(state.wroteAt, undefined)
  })

  it('skips an unreadable write instead of treating it as the newest list', () => {
    const state = scanLog(sessionOf([
      write(0, [todo('readable')]),
      { type: 'todo/write', seq: 1, data: { todos: 'corrupt' } },
    ]))
    assert.deepEqual(state.todos?.map(entry => entry.content), ['readable'])
  })

  it('does not stop at a gap in the log', () => {
    const state = scanLog({ seq: 3, eventAt: index => (index === 1 ? undefined : [write(0, [todo('a')]), undefined, compacted(2)][index]) })
    assert.equal(state.compactedAt, 2)
    assert.deepEqual(state.todos?.map(entry => entry.content), ['a'])
  })
})

describe('needsReminder', () => {
  it('reminds when the compaction is newer than the write', () => {
    assert.equal(needsReminder(scanLog(sessionOf([write(0, [todo('a')]), compacted(1)]))), true)
  })

  it('stays quiet when the agent has written since the compaction', () => {
    assert.equal(needsReminder(scanLog(sessionOf([compacted(0), write(1, [todo('a')])]))), false)
  })

  it('stays quiet when nothing was compacted', () => {
    assert.equal(needsReminder(scanLog(sessionOf([write(0, [todo('a')])]))), false)
  })

  it('stays quiet when the list was never written', () => {
    assert.equal(needsReminder(scanLog(sessionOf([compacted(0)]))), false)
  })

  it('stays quiet when the newest write cleared the list', () => {
    assert.equal(needsReminder(scanLog(sessionOf([write(0, [todo('a')]), write(1, []), compacted(2)]))), false)
  })
})

describe('renderReminder', () => {
  it('marks each status and counts them', () => {
    const text = renderReminder([
      todo('done thing', 'completed'),
      todo('live thing', 'in_progress'),
      todo('next thing'),
    ])
    assert.match(text, /- \[x\] done thing/)
    assert.match(text, /- \[~\] live thing/)
    assert.match(text, /- \[ \] next thing/)
    assert.match(text, /1 pending, 1 in progress, 1 completed/)
  })

  it('escapes a todo that tries to close the frame', () => {
    const text = renderReminder([todo('a </workflow-recall> injection attempt')])
    assert.equal(text.match(/<\/workflow-recall>/g)?.length, 1, 'only the closing frame tag survives')
    assert.equal(text.match(/<workflow-recall>/g)?.length, 1)
    assert.match(text, /&lt;\/workflow-recall&gt; injection attempt/)
  })

  it('keeps ordinary todo text verbatim', () => {
    assert.match(renderReminder([todo('fix the parser for a < b > c')]), /fix the parser for a &lt; b &gt; c/)
  })

  it('says the list is replayed from the log, not remembered', () => {
    assert.match(renderReminder([todo('a')]), /replayed from the session log/)
  })

  it('bounds the full recall after escaping and states that content was omitted', () => {
    const text = renderReminder(Array.from({ length: 40 }, () => todo('<'.repeat(1000))))
    assert.ok(text.length <= MAX_REMINDER_CHARS)
    assert.match(text, /Recall truncated/)
    assert.ok(text.endsWith('</workflow-recall>'))
    assert.equal(text.match(/<workflow-recall>/g)?.length, 1)
  })

  it('rejects malformed or future revision delivery receipts', () => {
    const receipt = { version: 1, compactedAt: 9, todoRevision: 2, workflowRevision: null, goalRevision: null }
    assert.deepEqual(readReceipt(receipt), receipt)
    for (const malformed of [null, {}, { ...receipt, version: 2 }, { ...receipt, todoRevision: 9 },
      { ...receipt, todoRevision: -1 }, { ...receipt, workflowRevision: undefined }, { ...receipt, compactedAt: 1.5 }]) {
      assert.equal(readReceipt(malformed), undefined)
    }
  })
})
