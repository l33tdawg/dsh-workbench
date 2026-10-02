/**
 * Tests for the model-facing result text and the presentation diffs.
 *
 * These are the parts of the tool a user actually sees, so they are pinned here
 * rather than only being observable from a running harness.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planPatch } from '../src/apply.ts'
import type { PlannedChange } from '../src/apply.ts'
import { parsePatch } from '../src/parser.ts'
import { changeDiffs, describeChange, formatApplyOutput, patchTitle } from '../src/report.ts'

/** Plan a patch over an in-memory file map. */
function plan(text: string, files: Record<string, string> = {}): PlannedChange[] {
  return [...planPatch(parsePatch(text), path => files[path]).changes]
}

describe('describeChange', () => {
  it('reports a created file by line count', () => {
    const [change] = plan('*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** End Patch\n')
    assert.equal(describeChange(change), 'Created a.txt (2 lines)')
  })

  it('reports an update by added and removed counts', () => {
    const [change] = plan('*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n-b\n+c\n*** End Patch\n', { 'a.txt': 'a\nb\n' })
    assert.equal(describeChange(change), 'Updated a.txt (1 added, 2 removed)')
  })
})

describe('formatApplyOutput', () => {
  it('lists one line per file', () => {
    const changes = plan(
      '*** Begin Patch\n*** Add File: a.txt\n+one\n*** Update File: b.txt\n@@\n-x\n+y\n*** End Patch\n',
      { 'b.txt': 'x\n' },
    )
    assert.equal(formatApplyOutput(changes), 'Created a.txt (1 lines)\nUpdated b.txt (1 added, 1 removed)')
  })

  // A lenient match applied, but not necessarily where the model meant. Saying
  // so is the only chance to catch it, since the model cannot see the file.
  it('flags a hunk that needed leniency', () => {
    const changes = plan('*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+beta\n*** End Patch\n', { 'a.txt': 'alpha   \n' })
    const text = formatApplyOutput(changes)
    assert.match(text, /Note: a\.txt:1 matched with rstrip tolerance/)
    assert.match(text, /Confirm the edit landed where you intended/)
  })

  it('stays quiet when every hunk matched exactly', () => {
    const changes = plan('*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+beta\n*** End Patch\n', { 'a.txt': 'alpha\n' })
    assert.ok(!formatApplyOutput(changes).includes('Note:'))
  })
})

describe('changeDiffs', () => {
  it('gives a new file no previous content', () => {
    const [change] = plan('*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch\n')
    assert.deepEqual(changeDiffs(change), [{ path: 'a.txt', oldText: null, newText: 'one\n' }])
  })

  it('gives both sides of an update', () => {
    const [change] = plan('*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch\n', { 'a.txt': 'a\n' })
    assert.deepEqual(changeDiffs(change), [{ path: 'a.txt', oldText: 'a\n', newText: 'b\n' }])
  })

  it('differs the updated path', () => {
    const [change] = plan('*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch\n', { 'a.txt': 'a\n' })
    assert.equal(changeDiffs(change)[0].path, 'a.txt')
  })

  it('falls back to whole-file for a very large update', () => {
    // Comfortably past the whole-file threshold, and a real multi-line file so
    // the hunk has something to match.
    const before = `${Array.from({ length: 900 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n')}\n`
    const [change] = plan('*** Begin Patch\n*** Update File: a.txt\n@@\n-line 0 ' + 'x'.repeat(40) + '\n+replaced\n*** End Patch\n', { 'a.txt': before })
    assert.equal(changeDiffs(change)[0].oldText, null)
    assert.equal(changeDiffs(change)[0].newText, change.after)
  })
})

describe('patchTitle', () => {
  it('names a single file', () => {
    const changes = plan('*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch\n', { 'a.txt': 'a\n' })
    assert.equal(patchTitle(changes), 'Patch a.txt')
  })

  it('counts a multi-file patch', () => {
    const changes = plan(
      '*** Begin Patch\n*** Add File: a.txt\n+one\n*** Add File: b.txt\n+two\n*** End Patch\n',
    )
    assert.equal(patchTitle(changes), 'Patch 2 files')
  })
})
