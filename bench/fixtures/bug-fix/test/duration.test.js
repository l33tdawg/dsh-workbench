import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeDuration, parseDuration } from '../src/duration.js'

describe('parseDuration', () => {
  it('parses a plain hour count', () => {
    assert.deepEqual(parseDuration('2h'), { hours: 2, minutes: 0 })
  })

  it('parses a plain minute count below an hour', () => {
    assert.deepEqual(parseDuration('45m'), { hours: 0, minutes: 45 })
  })

  it('carries minutes past the hour into hours', () => {
    assert.deepEqual(parseDuration('90m'), { hours: 1, minutes: 30 })
  })

  it('carries minutes written alongside hours', () => {
    assert.deepEqual(parseDuration('1h90m'), { hours: 2, minutes: 30 })
  })

  it('treats an exact hour as no minutes', () => {
    assert.deepEqual(parseDuration('3h'), { hours: 3, minutes: 0 })
  })
})

describe('describeDuration', () => {
  it('never renders a minute count of 60 or more', () => {
    assert.equal(describeDuration('90m'), '1h 30m')
    assert.equal(describeDuration('1h90m'), '2h 30m')
    assert.equal(describeDuration('59m'), '0h 59m')
  })
})
