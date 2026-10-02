/** Tests for configuration, path extraction, and the report text. */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseDiagnostic } from '../src/parse.ts'
import { editedPaths, formatReport, readProjectFile, resolveAgainst, resolveConfig } from '../src/report.ts'

describe('resolveConfig', () => {
  it('applies documented defaults', () => {
    assert.deepEqual(resolveConfig(), {
      enabled: true,
      timeoutMs: 60_000,
      debounceMs: 3_000,
      allowSlow: false,
      blocking: false,
      maxPerFile: 5,
    })
  })

  it('keeps explicit values', () => {
    assert.equal(resolveConfig({ timeoutMs: 5_000, blocking: true, maxPerFile: 2 }).timeoutMs, 5_000)
    assert.equal(resolveConfig({ blocking: true }).blocking, true)
  })

  // A zero timeout means "unbounded" to the shell layer, which is the opposite
  // of what the field promises, so it is rejected rather than clamped.
  it('rejects a non-positive timeout instead of meaning unbounded', () => {
    assert.throws(() => resolveConfig({ timeoutMs: 0 }), /timeoutMs must be a positive number/)
    assert.throws(() => resolveConfig({ debounceMs: -1 }), /debounceMs must be a positive number/)
  })

  it('allows disabling the debounce entirely', () => {
    assert.equal(resolveConfig({ debounceMs: 1 }).debounceMs, 1)
  })
})

describe('editedPaths', () => {
  it('reads a single file_path', () => {
    assert.deepEqual(editedPaths('edit', { file_path: 'src/a.ts' }), ['src/a.ts'])
  })

  it('accepts a path field', () => {
    assert.deepEqual(editedPaths('write', { path: 'src/b.ts' }), ['src/b.ts'])
  })

  it('reads every section of a patch', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export {}',
      '*** Update File: src/app.ts',
      '@@',
      '-a',
      '+b',
      '*** Move to: src/main.ts',
      '*** Delete File: src/old.ts',
      '*** End Patch',
    ].join('\n')
    assert.deepEqual(editedPaths('apply_patch', { patch }), [
      'src/new.ts',
      'src/app.ts',
      'src/main.ts',
      'src/old.ts',
    ])
  })

  // A patch with no sections must not fall through to a `patch` field being
  // mistaken for a path.
  it('returns nothing for a patch with no file sections', () => {
    assert.deepEqual(editedPaths('apply_patch', { patch: '*** Begin Patch\n*** End Patch' }), [])
  })

  // The result value describes what the tool did, so it outranks the arguments,
  // which only describe what it was asked to do.
  it('prefers the result value over the arguments', () => {
    assert.deepEqual(
      editedPaths('edit', { file_path: 'asked.ts' }, { path: 'actual.ts', before: '', after: '' }),
      ['actual.ts'],
    )
  })

  it('reads a write result', () => {
    assert.deepEqual(editedPaths('write', {}, { path: 'src/b.ts' }), ['src/b.ts'])
  })

  it('reads every file from an apply_patch result, using the move target', () => {
    const value = { files: [{ path: 'a.ts', target: 'a.ts' }, { path: 'b.ts', target: 'c.ts' }] }
    assert.deepEqual(editedPaths('apply_patch', {}, value), ['a.ts', 'c.ts'])
  })

  it('falls back to the arguments when the value is unusable', () => {
    assert.deepEqual(editedPaths('edit', { file_path: 'a.ts' }, undefined), ['a.ts'])
    assert.deepEqual(editedPaths('edit', { file_path: 'a.ts' }, { unrelated: true }), ['a.ts'])
  })

  it('ignores a malformed files array rather than throwing', () => {
    assert.deepEqual(editedPaths('apply_patch', { patch: '' }, { files: [null, 7, {}] }), [])
  })

  it('prefers patch sections over a stray file_path', () => {
    const patch = '*** Begin Patch\n*** Update File: src/real.ts\n@@\n-a\n+b\n*** End Patch'
    assert.deepEqual(editedPaths('apply_patch', { patch, file_path: 'ignored.ts' }), ['src/real.ts'])
  })

  it('reads a path containing spaces up to the line end', () => {
    assert.deepEqual(editedPaths('apply_patch', { patch: '*** Add File: docs/my notes.md\n+x\n' }), ['docs/my notes.md'])
  })

  it('returns nothing for arguments that name no file', () => {
    assert.deepEqual(editedPaths('edit', {}), [])
    assert.deepEqual(editedPaths('edit', undefined), [])
    assert.deepEqual(editedPaths('edit', { file_path: '' }), [])
  })
})

describe('resolveAgainst', () => {
  it('joins a relative path onto the root', () => {
    assert.equal(resolveAgainst('src/a.ts', '/repo'), '/repo/src/a.ts')
  })

  it('leaves an absolute path alone', () => {
    assert.equal(resolveAgainst('/other/a.ts', '/repo'), '/other/a.ts')
  })
})

describe('readProjectFile', () => {
  it('reads a file that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voe-'))
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"x"}')
      assert.equal(readProjectFile(dir, 'package.json'), '{"name":"x"}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for a missing file rather than throwing', () => {
    assert.equal(readProjectFile('/nonexistent-root-xyz', 'package.json'), undefined)
  })

  it('returns undefined for a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voe-'))
    try {
      mkdirSync(join(dir, 'sub'))
      assert.equal(readProjectFile(dir, 'sub'), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('formatReport', () => {
  const plan = { command: 'npm run typecheck', label: 'typecheck', cost: 'fast' as const }

  it('names the check, the count, and the files', () => {
    const text = formatReport(plan, [{
      file: 'src/a.ts',
      items: [parseDiagnostic('src/a.ts(12,5): error TS2322: bad type')!],
      omitted: 0,
    }])
    assert.match(text, /typecheck fails on 1 problem/)
    assert.match(text, /src\/a\.ts:12 {2}TS2322: bad type/)
  })

  it('pluralizes correctly', () => {
    const two = formatReport(plan, [
      { file: 'a.ts', items: [parseDiagnostic('a.ts(1,1): error TS1: x')!], omitted: 0 },
      { file: 'b.ts', items: [parseDiagnostic('b.ts(1,1): error TS1: x')!], omitted: 0 },
    ])
    assert.match(two, /fails on 2 problems in files you edited/)
  })

  it('reports omitted counts', () => {
    const text = formatReport(plan, [{ file: 'a.ts', items: [], omitted: 7 }])
    assert.match(text, /\.\.\. and 7 more/)
  })

  // The closing instruction is load-bearing: without it the agent treats
  // pre-existing failures as its own and goes off to fix them.
  it('tells the agent not to fix files it did not edit', () => {
    const text = formatReport(plan, [{ file: 'a.ts', items: [], omitted: 1 }])
    assert.match(text, /Leave failures in files you have not edited alone/)
  })

  it('omits a line number when the checker gave none', () => {
    const text = formatReport(plan, [{
      file: 'a.ts',
      items: [{ file: 'a.ts', line: undefined, column: undefined, severity: 'error', message: 'm', raw: 'm' }],
      omitted: 0,
    }])
    assert.match(text, /a\.ts {2}m/)
  })
})
