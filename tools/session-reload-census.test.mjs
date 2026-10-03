/**
 * Tests for the reload census.
 *
 * The census is the evidence for what a profile edit does to a running
 * session, so its reading of the record has to be pinned: a tool entry is a
 * bare string in some sessions and a full schema in others, and a session with
 * one request can never show a change. Everything here is a pure function over
 * parsed records; the frame walking underneath is covered by session-audit's
 * tests.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { census, reloads } from './session-reload-census.mjs'

/** A session header, as the log's first record. */
function header(agentPreset) {
  return { type: 'session', id: 'session-test', cwd: '/tmp/workspace', agentPreset }
}

/** A request header carrying the given tools, as names or as schema objects. */
function request(tools, reason, at) {
  return {
    type: 'request/header',
    time: at,
    data: { reason, header: { tools } },
  }
}

describe('reloads', () => {
  it('finds no change in a session whose tool set holds still', () => {
    const { requests, changes } = reloads([
      header('cordis'),
      request(['read', 'bash'], 'initial', 1),
      request(['bash', 'read'], 'series', 2),
    ])
    assert.equal(requests.length, 2)
    assert.deepEqual(changes, [])
  })

  it('reports a removal with the surviving count', () => {
    const { changes } = reloads([
      request(['read', 'bash', 'edit', 'apply_patch'], 'initial', 1),
      request(['apply_patch'], 'change', 2),
    ])
    assert.equal(changes.length, 1)
    assert.equal(changes[0].tools, 1)
    assert.equal(changes[0].reason, 'change')
    assert.deepEqual(changes[0].removed, ['bash', 'edit', 'read'])
    assert.deepEqual(changes[0].added, [])
  })

  it('reports an addition as an addition, not as a mixed change', () => {
    const { changes } = reloads([
      request(['read', 'bash'], 'initial', 1),
      request(['read', 'bash', 'check_claims'], 'change', 2),
    ])
    assert.deepEqual(changes[0].added, ['check_claims'])
    assert.deepEqual(changes[0].removed, [])
  })

  it('reads a tool entry that is a full schema rather than a name', () => {
    const { requests } = reloads([
      request(['read'], 'initial', 1),
      request([{ name: 'read', description: 'Read a file' }, { name: 'bash' }], 'change', 2),
    ])
    assert.deepEqual(requests[1].tools, ['read', 'bash'])
  })

  it('ignores a request header with no tool list', () => {
    const { requests, changes } = reloads([
      request(['read'], 'initial', 1),
      { type: 'request/header', time: 2, data: { reason: 'series' } },
      request(['bash'], 'change', 3),
    ])
    assert.equal(requests.length, 2)
    assert.deepEqual(changes[0].added, ['bash'])
    assert.deepEqual(changes[0].removed, ['read'])
  })

  it('finds no change in a session with a single request', () => {
    const { changes } = reloads([request(['read'], 'initial', 1)])
    assert.deepEqual(changes, [])
  })
})

describe('census', () => {
  it('carries the preset, workspace and request count beside the changes', () => {
    const row = census([
      header('standard'),
      request(['read', 'bash'], 'initial', 1),
      request(['read'], 'resume', 2),
    ])
    assert.equal(row.preset, 'standard')
    assert.equal(row.cwd, '/tmp/workspace')
    assert.equal(row.requests, 2)
    assert.equal(row.changes.length, 1)
    assert.equal(row.firstRequestAt, 1)
    assert.equal(row.lastRequestAt, 2)
    assert.deepEqual(row.requestTimes, [1, 2])
  })

  it('bounds the span a change could have fallen inside', () => {
    const row = census([
      header('cordis'),
      request(['read'], 'initial', 1000),
      request(['read'], 'series', 2000),
      request(['read', 'bash'], 'change', 3000),
    ])
    assert.equal(row.firstRequestAt, 1000)
    assert.equal(row.lastRequestAt, 3000)
    assert.equal(row.changes[0].at, 3000)
  })

  it('reports no preset when the header has none', () => {
    const row = census([header(undefined), request(['read'], 'initial', 1), request([], 'change', 2)])
    assert.equal(row.preset, undefined)
    assert.deepEqual(row.changes[0].removed, ['read'])
  })
})
