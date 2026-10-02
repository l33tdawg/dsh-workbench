/**
 * The diff, on its own.
 *
 * Every case here is a shape a real edit produces: one line replaced, a line
 * inserted or deleted, `replace_all` hitting two places, and a rewrite too large
 * to show. The expectations are written as the read-back text rather than as
 * internal structures, because the text is what the model actually receives.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { diffLines, hunkHeader } from '../src/diff.ts'
import type { Hunk } from '../src/diff.ts'

/**
 * Render a diff result the way the report does, for readable assertions.
 * @param hunks - the hunks to render.
 * @returns the unified-diff text.
 */
function render(hunks: readonly Hunk[]): string {
  return hunks
    .map(hunk => [hunkHeader(hunk), ...hunk.lines.map(line => `${line.kind}${line.text}`)].join('\n'))
    .join('\n')
}

/** Diff two contents and render the hunks, failing on a non-hunk result. */
function diff(before: string, after: string, context = 2): string {
  const result = diffLines(before, after, context)
  assert.equal(result.kind, 'hunks', `expected hunks, got ${result.kind}`)
  if (result.kind !== 'hunks') throw new Error('unreachable')
  return render(result.hunks)
}

describe('diffLines', () => {
  it('reports identical content as unchanged', () => {
    assert.deepEqual(diffLines('a\nb\n', 'a\nb\n'), { kind: 'same' })
  })

  it('treats a missing final newline as the same content', () => {
    // The terminator is not a line. Reporting it would flag every file whose
    // last newline moved, which is never what the reader is looking for.
    assert.deepEqual(diffLines('a\nb\n', 'a\nb'), { kind: 'same' })
  })

  it('reports an empty file gaining content as one insertion', () => {
    assert.equal(diff('', 'a\nb\n'), ['@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'))
  })

  it('reports content emptied as one deletion', () => {
    assert.equal(diff('a\nb\n', ''), ['@@ -1,2 +0,0 @@', '-a', '-b'].join('\n'))
  })

  it('replaces one line inside a file, with context', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\n'
    const after = 'one\ntwo\nTHREE\nfour\nfive\n'
    assert.equal(diff(before, after), [
      '@@ -1,5 +1,5 @@',
      ' one',
      ' two',
      '-three',
      '+THREE',
      ' four',
      ' five',
    ].join('\n'))
  })

  it('honours a zero context window', () => {
    const before = 'one\ntwo\nthree\n'
    const after = 'one\nTWO\nthree\n'
    assert.equal(diff(before, after, 0), ['@@ -2,1 +2,1 @@', '-two', '+TWO'].join('\n'))
  })

  it('merges two changes that are closer than the context window', () => {
    const before = 'a\nb\nc\nd\ne\n'
    const after = 'a\nB\nc\nD\ne\n'
    // Both changes land in one hunk because the run between them is not longer
    // than the context they would each carry.
    assert.equal(diff(before, after), [
      '@@ -1,5 +1,5 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '-d',
      '+D',
      ' e',
    ].join('\n'))
  })

  it('splits two changes that are further apart than the context window', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    const after = [...lines]
    after[1] = 'CHANGED 1'
    after[18] = 'CHANGED 18'
    const result = diffLines(lines.join('\n'), after.join('\n'), 2)
    assert.equal(result.kind, 'hunks')
    if (result.kind !== 'hunks') throw new Error('unreachable')
    assert.equal(result.hunks.length, 2)
    assert.equal(result.hunks[0].beforeStart, 1)
    assert.equal(result.hunks[1].beforeStart, 17)
  })

  it('counts an insertion as zero before-lines', () => {
    const before = 'a\nc\n'
    const after = 'a\nb\nc\n'
    assert.equal(diff(before, after), [
      '@@ -1,2 +1,3 @@',
      ' a',
      '+b',
      ' c',
    ].join('\n'))
  })

  it('counts a deletion as zero after-lines', () => {
    const before = 'a\nb\nc\n'
    const after = 'a\nc\n'
    assert.equal(diff(before, after), [
      '@@ -1,3 +1,2 @@',
      ' a',
      '-b',
      ' c',
    ].join('\n'))
  })

  it('handles a change at the very start of a file', () => {
    const before = 'first\nkeep\n'
    const after = 'FIRST\nkeep\n'
    assert.equal(diff(before, after), [
      '@@ -1,2 +1,2 @@',
      '-first',
      '+FIRST',
      ' keep',
    ].join('\n'))
  })

  it('handles a change at the very end of a file', () => {
    const before = 'keep\nlast\n'
    const after = 'keep\nLAST\n'
    assert.equal(diff(before, after), [
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-last',
      '+LAST',
    ].join('\n'))
  })

  it('summarizes a rewrite too large to diff', () => {
    const before = Array.from({ length: 2100 }, (_, i) => `before ${i}`).join('\n')
    const after = Array.from({ length: 2100 }, (_, i) => `after ${i}`).join('\n')
    const result = diffLines(before, after, 2)
    assert.equal(result.kind, 'too-large')
    if (result.kind !== 'too-large') throw new Error('unreachable')
    assert.equal(result.beforeLines, 2100)
    assert.equal(result.afterLines, 2100)
  })

  it('still diffs a large file whose one change is small', () => {
    // Stripping the shared affixes first is what makes this cheap: 4,000 lines
    // leave a two-line problem behind, not a 16-million-cell one.
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`)
    const after = [...lines]
    after[2000] = 'CHANGED'
    const result = diffLines(lines.join('\n'), after.join('\n'), 2)
    assert.equal(result.kind, 'hunks')
    if (result.kind !== 'hunks') throw new Error('unreachable')
    assert.equal(result.hunks.length, 1)
    assert.equal(result.hunks[0].beforeStart, 1999)
  })

  it('keeps carriage returns intact', () => {
    const result = diffLines('a\r\nb\r\n', 'a\r\nB\r\n')
    assert.equal(result.kind, 'hunks')
    if (result.kind !== 'hunks') throw new Error('unreachable')
    assert.deepEqual(result.hunks[0].lines.at(-1), { kind: '+', text: 'B\r' })
  })
})
