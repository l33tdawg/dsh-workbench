/**
 * The wording of the notice that fires when no check runs.
 *
 * These assertions are about what the agent is told, which is the whole point
 * of the change: the previous sentence was indistinguishable between "this
 * project declares no check" and "this search did not find the check".
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatNoCheck } from '../src/index.ts'
import { DETECTION_PATHS } from '../src/detect.ts'

describe('formatNoCheck', () => {
  it('keeps the original sentence when nothing was recorded', () => {
    assert.equal(
      formatNoCheck(),
      'No project check is configured or detected; these edits remain unverified.',
    )
  })

  it('names every declaration file it looked for', () => {
    const notice = formatNoCheck({ searched: [...DETECTION_PATHS] })
    for (const path of DETECTION_PATHS) assert.match(notice, new RegExp(path.replace('.', '\\.')))
    assert.match(notice, /\.venv/)
  })

  it('distinguishes a missing check from a withheld one', () => {
    const missing = formatNoCheck({ searched: [] })
    const withheld = formatNoCheck({ searched: [], skipped: { label: 'pytest' } })
    assert.notEqual(missing, withheld)
    assert.match(withheld, /pytest check was available but not run/)
    assert.match(withheld, /slow checks are disabled/)
    assert.match(withheld, /allowSlow/)
    // A withheld check must never be described as absent.
    assert.doesNotMatch(withheld, /None was found/)
  })

  it('says a check outside the known names is not detected', () => {
    assert.match(formatNoCheck({ searched: [] }), /A check outside these names is not detected/)
  })
})
