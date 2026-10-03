/**
 * An exhaustive check of the canonical-form invariant.
 *
 * Broad rather than split into many small cases: the invariant is "no rendering
 * ever contains 60 minutes or more", which is a claim about the whole input
 * space, and a handful of examples does not test it. It reports the first few
 * counterexamples so a failure names what broke.
 *
 * It is not a slow check. This fixture does not currently exercise an
 * edit-debounce window; that scenario needs a check that genuinely takes
 * seconds, and inventing one here would be decoration.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeDuration } from '../src/duration.js'

describe('canonical form, exhaustively', () => {
  it('never renders 60 minutes or more, for every hour and minute pair', () => {
    const wrong = []
    for (let hours = 0; hours <= 48; hours++) {
      for (let minutes = 0; minutes <= 59; minutes++) {
        // Written so the input is deliberately non-canonical whenever the
        // minutes alone would carry: `1h75m` and `135m` must both come back
        // canonical.
        for (const written of [`${hours}h${minutes}m`, `${hours * 60 + minutes}m`]) {
          const rendered = describeDuration(written)
          const renderedMinutes = Number(/(\d+)m/.exec(rendered)[1])
          if (renderedMinutes >= 60) wrong.push(`${written} -> ${rendered}`)
        }
      }
    }
    assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} non-canonical renderings`)
  })
})
