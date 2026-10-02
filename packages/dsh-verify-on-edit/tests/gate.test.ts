/**
 * Tests for the gate that decides when a check runs.
 *
 * These matter more than they look. The failure mode that would make the plugin
 * useless is not a wrong report, it is the check quietly never running, or
 * running on every keystroke. Both are decided here.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseDiagnostics } from '../src/parse.ts'
import { relevantDiagnostics, resolveConfig, shouldCheck } from '../src/report.ts'
import type { GateInput } from '../src/report.ts'

const CONFIG = resolveConfig({ debounceMs: 1_000 })

/** A gate input for a successful edit. */
function edit(overrides: Partial<GateInput> = {}): GateInput {
  return {
    toolName: 'edit',
    args: { file_path: 'src/a.ts' },
    isError: false,
    hasAgent: true,
    root: '/repo',
    ...overrides,
  }
}

describe('shouldCheck', () => {
  it('checks after a successful edit', () => {
    const gate = shouldCheck(edit(), 0, CONFIG, 10_000)
    assert.equal(gate.check, true)
    assert.deepEqual(gate.paths, ['/repo/src/a.ts'])
  })

  it('resolves an absolute path unchanged', () => {
    const gate = shouldCheck(edit({ args: { file_path: '/elsewhere/a.ts' } }), 0, CONFIG, 10_000)
    assert.deepEqual(gate.paths, ['/elsewhere/a.ts'])
  })

  it('collects every path from a patch', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Add File: b.ts\n+z\n*** End Patch'
    const gate = shouldCheck(edit({ toolName: 'apply_patch', args: { patch } }), 0, CONFIG, 10_000)
    assert.deepEqual(gate.paths, ['/repo/a.ts', '/repo/b.ts'])
  })

  // A failed edit changed nothing, so a check would report the state before it.
  it('skips when the tool call failed', () => {
    assert.equal(shouldCheck(edit({ isError: true }), 0, CONFIG, 10_000).reason, 'the tool call failed')
  })

  it('skips read-only tools', () => {
    for (const toolName of ['read', 'glob', 'grep', 'bash']) {
      const gate = shouldCheck(edit({ toolName }), 0, CONFIG, 10_000)
      assert.equal(gate.check, false, `${toolName} must not trigger a check`)
    }
  })

  it('skips a direct execute with no agent', () => {
    assert.equal(shouldCheck(edit({ hasAgent: false }), 0, CONFIG, 10_000).reason, 'no agent')
  })

  it('skips a call that named no file', () => {
    assert.equal(shouldCheck(edit({ args: {} }), 0, CONFIG, 10_000).reason, 'the call named no file')
  })

  it('skips inside the debounce window', () => {
    assert.equal(shouldCheck(edit(), 9_500, CONFIG, 10_000).reason, 'within the debounce window')
    assert.equal(shouldCheck(edit(), 9_000, CONFIG, 10_000).check, true)
  })

  // Even a skipped call still reports its paths, so the edit is attributed and
  // the next check covers it.
  it('reports paths even when the debounce suppresses the run', () => {
    const gate = shouldCheck(edit(), 9_500, CONFIG, 10_000)
    assert.equal(gate.check, false)
    assert.deepEqual(gate.paths, ['/repo/src/a.ts'])
  })

  it('skips everything when disabled', () => {
    assert.equal(shouldCheck(edit(), 0, resolveConfig({ enabled: false }), 10_000).reason, 'disabled')
  })
})

describe('relevantDiagnostics', () => {
  const edited = ['/repo/src/app.ts']

  it('keeps an error in an edited file', () => {
    const found = parseDiagnostics('src/app.ts(1,1): error TS1: boom')
    assert.equal(relevantDiagnostics(found, edited).length, 1)
  })

  // The single most important filter. An agent handed a pre-existing failure
  // will go and fix it, which is exactly what it was told not to do.
  it('drops an error in a file the agent never touched', () => {
    const found = parseDiagnostics('src/other.ts(1,1): error TS1: pre-existing')
    assert.deepEqual(relevantDiagnostics(found, edited), [])
  })

  it('drops warnings even in an edited file', () => {
    const found = parseDiagnostics('src/app.ts(1,1): warning TS6133: unused')
    assert.deepEqual(relevantDiagnostics(found, edited), [])
  })

  it('keeps only the attributable subset of a mixed run', () => {
    const found = parseDiagnostics([
      'src/other.ts(1,1): error TS1: theirs',
      'src/app.ts(4,2): error TS2: mine',
      'src/app.ts(9,1): warning TS6133: noise',
    ].join('\n'))
    const kept = relevantDiagnostics(found, edited)
    assert.equal(kept.length, 1)
    assert.equal(kept[0].message, 'TS2: mine')
  })

  it('returns nothing when the session has edited nothing', () => {
    const found = parseDiagnostics('src/app.ts(1,1): error TS1: boom')
    assert.deepEqual(relevantDiagnostics(found, []), [])
  })
})
