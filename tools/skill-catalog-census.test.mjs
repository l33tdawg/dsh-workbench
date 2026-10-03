/**
 * Tests for the skill catalog census.
 *
 * The census is the evidence for a claim about which agent preset loses the
 * skill catalog, so its counting has to be pinned to the record shape the
 * harness actually writes. Everything here is a pure function over parsed
 * records; the log decompression underneath is covered by session-audit's tests.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { census } from './skill-catalog-census.mjs'

/** A session header, as the log's first record. */
function header(agentPreset) {
  return { type: 'session', id: 'session-test', cwd: '/tmp/workspace', agentPreset }
}

/** A durable user message. */
function user(source) {
  return { type: 'user/message', data: { source } }
}

/** A catalog message carrying the given names. */
function catalog(names, update) {
  return user({
    kind: 'skill-catalog',
    form: 'catalog',
    ...(update === true ? { update: true } : {}),
    entries: names.map(name => ({ name, description: `${name} does something` })),
  })
}

describe('census', () => {
  it('counts no catalog in a session without one', () => {
    const counts = census([header('cordis'), user({ kind: 'user' }), user({ kind: 'skill-invocation', name: 'find-skills' })])
    assert.equal(counts.catalogs, 0)
    assert.equal(counts.names, undefined)
    assert.equal(counts.preset, 'cordis')
  })

  it('counts a catalog and reads its entries', () => {
    const counts = census([header('standard'), catalog(['find-skills', 'office-docx'])])
    assert.equal(counts.catalogs, 1)
    assert.deepEqual(counts.names, ['find-skills', 'office-docx'])
  })

  it('counts a republish as a second catalog and keeps the first entry list', () => {
    const counts = census([header('cordis'), catalog(['find-skills']), catalog(['find-skills', 'office-docx'], true)])
    assert.equal(counts.catalogs, 2)
    assert.equal(counts.updates, 1)
    assert.deepEqual(counts.names, ['find-skills'])
  })

  it('ignores a catalog record whose entries are unreadable', () => {
    const counts = census([header('cordis'), user({ kind: 'skill-catalog', entries: 'not-an-array' })])
    assert.equal(counts.catalogs, 1)
    assert.equal(counts.names, undefined)
  })

  it('ignores a skill invocation, which is a different record', () => {
    const counts = census([header('cordis'), user({ kind: 'skill-invocation', name: 'find-skills', form: 'instructions' })])
    assert.equal(counts.catalogs, 0)
  })

  it('reports a session with no recorded preset', () => {
    const counts = census([header(undefined), catalog(['find-skills'])])
    assert.equal(counts.preset, undefined)
    assert.equal(counts.catalogs, 1)
  })
})
