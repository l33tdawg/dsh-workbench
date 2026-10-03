import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { agendaLine, agendaTotal } from '../src/agenda.js'

describe('agendaTotal', () => {
  it('adds written durations', () => {
    assert.equal(agendaTotal(['45m', '2h', '1h30m']), 255)
  })

  it('is zero for an empty agenda', () => {
    assert.equal(agendaTotal([]), 0)
  })

  it('sums to the same total however the entries are written', () => {
    assert.equal(agendaTotal(['90m']), agendaTotal(['1h30m']))
    assert.equal(agendaTotal(['1h90m']), agendaTotal(['2h30m']))
  })
})

describe('agendaLine', () => {
  it('reports the count and the total', () => {
    assert.equal(agendaLine(['1h', '30m']), '2 entries, 90 minutes')
  })
})
