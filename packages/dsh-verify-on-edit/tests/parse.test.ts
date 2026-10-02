/**
 * Tests for checker output parsing and attribution.
 *
 * The real checkers' formats were taken from their own output, so these cases
 * are the shapes that actually matter rather than invented ones.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { concernsEditedFile, isError, normalizePath, parseDiagnostic, parseDiagnostics, summarize } from '../src/parse.ts'

describe('parseDiagnostic', () => {
  it('reads tsc', () => {
    const d = parseDiagnostic("src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.")
    assert.deepEqual(
      { file: d?.file, line: d?.line, column: d?.column, severity: d?.severity },
      { file: 'src/app.ts', line: 12, column: 5, severity: 'error' },
    )
    assert.match(d?.message ?? '', /TS2322/)
  })

  it('reads cargo short format', () => {
    const d = parseDiagnostic('src/main.rs:12:5: error[E0308]: mismatched types')
    assert.equal(d?.file, 'src/main.rs')
    assert.equal(d?.line, 12)
    assert.equal(d?.severity, 'error')
    // The code is kept: E0308 is a stable identifier the agent can look up.
    assert.equal(d?.message, 'E0308: mismatched types')
  })

  it('reads ruff concise', () => {
    const d = parseDiagnostic('app/handlers.py:41:9: F841 Local variable `x` is assigned to but never used')
    assert.equal(d?.file, 'app/handlers.py')
    assert.equal(d?.line, 41)
    assert.equal(d?.column, 9)
  })

  it('reads go build', () => {
    const d = parseDiagnostic('./cmd/server/main.go:22:5: undefined: handleRequest')
    assert.equal(d?.file, './cmd/server/main.go')
    assert.equal(d?.line, 22)
  })

  it('reads pyright', () => {
    const d = parseDiagnostic('src/util.py:8:1 - error: "foo" is not defined')
    assert.equal(d?.file, 'src/util.py')
    assert.equal(d?.line, 8)
    assert.equal(d?.severity, 'error')
  })

  it('reads a line with no column', () => {
    const d = parseDiagnostic('lib/thing.rb:14: syntax error, unexpected end-of-input')
    assert.equal(d?.file, 'lib/thing.rb')
    assert.equal(d?.line, 14)
    assert.equal(d?.column, undefined)
  })

  it('keeps warnings distinct from errors', () => {
    const d = parseDiagnostic('src/a.ts(3,1): warning TS6133: declared but never read.')
    assert.equal(isError(d!), false)
    assert.equal(d?.severity, 'warning')
  })

  // Continuation lines carry no location. Treating them as diagnostics would
  // attribute a caret run to a file named "^".
  it('ignores source excerpts and caret runs', () => {
    assert.equal(parseDiagnostic('  12 | const x = 1'), undefined)
    assert.equal(parseDiagnostic('     | ^^^^^'), undefined)
    assert.equal(parseDiagnostic('       ~~~~~'), undefined)
  })

  it('ignores prose and blank lines', () => {
    assert.equal(parseDiagnostic(''), undefined)
    assert.equal(parseDiagnostic('Found 3 errors in 2 files.'), undefined)
  })

  it('does not read a URL scheme as a path', () => {
    assert.equal(parseDiagnostic('http://example.com:8080: connection refused'), undefined)
  })
})

describe('parseDiagnostics', () => {
  it('collects every located problem from a mixed run', () => {
    const output = [
      'src/a.ts(1,1): error TS1000: first',
      'src/a.ts(2,1): error TS1001: second',
      ' 2 | bad',
      'src/b.ts(9,3): warning TS6133: third',
      'Found 3 problems.',
    ].join('\n')
    const found = parseDiagnostics(output)
    assert.equal(found.length, 3)
    assert.deepEqual(found.map(d => d.file), ['src/a.ts', 'src/a.ts', 'src/b.ts'])
  })
})

describe('normalizePath', () => {
  it('unifies separators and leading ./', () => {
    assert.equal(normalizePath('./src\\app.ts'), 'src/app.ts')
  })
})

describe('concernsEditedFile', () => {
  const edited = ['/repo/src/app.ts', 'packages/lib/index.ts']

  it('matches an absolute edit against a relative diagnostic', () => {
    const d = parseDiagnostic('src/app.ts(1,1): error TS1: x')!
    assert.equal(concernsEditedFile(d, edited), true)
  })

  it('matches a workspace-relative diagnostic against an absolute edit', () => {
    const d = parseDiagnostic('repo/src/app.ts(1,1): error TS1: x')!
    assert.equal(concernsEditedFile(d, edited), true)
  })

  it('matches a monorepo package path', () => {
    const d = parseDiagnostic('packages/lib/index.ts(1,1): error TS1: x')!
    assert.equal(concernsEditedFile(d, edited), true)
  })

  // The whole point of attribution: an unrelated pre-existing error must not be
  // reported, or the agent wanders off to fix something it was told to leave.
  it('rejects a file the agent never touched', () => {
    const d = parseDiagnostic('src/unrelated.ts(1,1): error TS1: x')!
    assert.equal(concernsEditedFile(d, edited), false)
  })

  it('does not match on a shared basename alone', () => {
    const d = parseDiagnostic('other/place/app.ts(1,1): error TS1: x')!
    assert.equal(concernsEditedFile(d, ['/repo/src/app.ts']), false)
  })
})

describe('summarize', () => {
  it('groups by file and caps each group', () => {
    const found = Array.from({ length: 8 }, (_, i) =>
      parseDiagnostic(`src/a.ts(${i + 1},1): error TS1: problem ${i}`)!)
    const groups = summarize(found, 3)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].items.length, 3)
    assert.equal(groups[0].omitted, 5)
  })

  it('keeps file order stable', () => {
    const found = [
      parseDiagnostic('b.ts(1,1): error TS1: x')!,
      parseDiagnostic('a.ts(1,1): error TS1: x')!,
    ]
    assert.deepEqual(summarize(found).map(g => g.file), ['b.ts', 'a.ts'])
  })
})
