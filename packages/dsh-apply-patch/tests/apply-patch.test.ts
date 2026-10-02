/**
 * Parser and application tests.
 *
 * The application core is pure, so these run against an in-memory file map. The
 * assertions pin the two properties the design trades on: a patch either applies
 * completely or not at all, and a hunk that matches more than one place is
 * refused rather than guessed at.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PatchApplyError, planPatch } from '../src/apply.ts'
import type { ReadFile } from '../src/apply.ts'
import { PatchParseError, parsePatch } from '../src/parser.ts'

/** Build a `ReadFile` over a plain object of path → content. */
function reader(files: Record<string, string>): ReadFile {
  return path => files[path]
}

/** Parse and plan in one step. */
function plan(text: string, files: Record<string, string> = {}) {
  return planPatch(parsePatch(text), reader(files))
}

/** Capture the error a thunk throws. */
function failure(thunk: () => unknown): Error {
  try {
    thunk()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the call to throw')
}

describe('parser', () => {
  it('parses a minimal envelope', () => {
    const patch = parsePatch('*** Begin Patch\n*** Delete File: a.txt\n*** End Patch\n')
    assert.equal(patch.ops.length, 1)
    assert.deepEqual(patch.ops[0], { kind: 'delete', path: 'a.txt' })
  })

  it('accepts a missing trailing newline', () => {
    const patch = parsePatch('*** Begin Patch\n*** Delete File: a.txt\n*** End Patch')
    assert.equal(patch.ops.length, 1)
  })

  it('tolerates surrounding whitespace on markers', () => {
    const patch = parsePatch('  *** Begin Patch  \n  *** Delete File: a.txt  \n  *** End Patch  \n')
    assert.equal(patch.ops.length, 1)
  })

  it('reads add lines verbatim, including a lone plus', () => {
    const patch = parsePatch('*** Begin Patch\n*** Add File: a.txt\n+one\n+\n+three\n*** End Patch\n')
    assert.deepEqual(patch.ops[0], { kind: 'add', path: 'a.txt', lines: ['one', '', 'three'] })
  })

  it('reads hunks, headers, and the end-of-file marker', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@ function name',
      ' keep',
      '-old',
      '+new',
      '*** End of File',
      '*** End Patch',
      '',
    ].join('\n')
    const patch = parsePatch(text)
    assert.equal(patch.ops.length, 1)
    const op = patch.ops[0]
    assert.equal(op.kind, 'update')
    if (op.kind !== 'update') return
    assert.equal(op.hunks.length, 1)
    assert.equal(op.hunks[0].header, 'function name')
    assert.equal(op.hunks[0].eof, true)
    assert.deepEqual(op.hunks[0].lines, [
      { kind: ' ', text: 'keep' },
      { kind: '-', text: 'old' },
      { kind: '+', text: 'new' },
    ])
  })

  it('reads a move', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-x\n+y\n*** End Patch\n'
    const op = parsePatch(text).ops[0]
    assert.equal(op.kind, 'update')
    if (op.kind !== 'update') return
    assert.equal(op.moveTo, 'b.txt')
  })

  it('rejects a missing envelope', () => {
    assert.match(failure(() => parsePatch('*** Update File: a.txt\n')).message, /expected "\*\*\* Begin Patch"/)
  })

  it('rejects an unterminated envelope', () => {
    assert.match(failure(() => parsePatch('*** Begin Patch\n*** Delete File: a.txt\n')).message, /missing "\*\*\* End Patch"/)
  })

  it('rejects content after the end marker', () => {
    const text = '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch\nDone!\n'
    assert.match(failure(() => parsePatch(text)).message, /unexpected content after/)
  })

  it('rejects an empty patch', () => {
    assert.match(failure(() => parsePatch('*** Begin Patch\n*** End Patch\n')).message, /no file operations/)
  })

  it('rejects an add line without a plus', () => {
    const text = '*** Begin Patch\n*** Add File: a.txt\nplain\n*** End Patch\n'
    assert.match(failure(() => parsePatch(text)).message, /add line must start with "\+"/)
  })

  it('rejects a section marker without a path', () => {
    const text = '*** Begin Patch\n*** Update File:\n@@\n-a\n+b\n*** End Patch\n'
    assert.match(failure(() => parsePatch(text)).message, /requires a path/)
  })

  it('rejects an update with no hunks and no move', () => {
    assert.match(failure(() => parsePatch('*** Begin Patch\n*** Update File: a.txt\n*** End Patch\n')).message, /no hunks and no move/)
  })

  it('reports the offending line number', () => {
    const error = failure(() => parsePatch('*** Begin Patch\n*** Nonsense\n*** End Patch\n')) as PatchParseError
    assert.equal(error.line, 2)
  })
})

describe('create', () => {
  it('creates a file and terminates the last line', () => {
    const result = plan('*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** End Patch\n')
    assert.equal(result.changes.length, 1)
    assert.equal(result.changes[0].after, 'one\ntwo\n')
    assert.equal(result.changes[0].before, null)
    assert.equal(result.changes[0].operation, 'create')
  })

  // Codex's `*** Add File` silently replaces an existing file. Refusing is the
  // whole point of routing creates through this tool.
  it('refuses to overwrite an existing file', () => {
    const text = '*** Begin Patch\n*** Add File: a.txt\n+new\n*** End Patch\n'
    assert.match(failure(() => plan(text, { 'a.txt': 'old\n' })).message, /already exists/)
  })

  it('refuses to add one path twice', () => {
    const text = '*** Begin Patch\n*** Add File: a.txt\n+one\n*** Add File: a.txt\n+two\n*** End Patch\n'
    assert.match(failure(() => plan(text)).message, /added twice|more than once/)
  })
})

describe('delete', () => {
  // The harness `fs` service exposes no remove operation, so the tool refuses
  // deletions rather than bypassing the sandbox and version fence.
  it('refuses, pointing at the bash tool', () => {
    const message = failure(() => plan('*** Begin Patch\n*** Delete File: a.txt\n*** End Patch\n', { 'a.txt': 'x\n' })).message
    assert.match(message, /cannot delete/)
    assert.match(message, /bash tool/)
  })
})

describe('update', () => {
  it('replaces a unique line', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n-beta\n+gamma\n*** End Patch\n'
    const change = plan(text, { 'a.txt': 'alpha\nbeta\n' }).changes[0]
    assert.equal(change.after, 'alpha\ngamma\n')
    assert.equal(change.operation, 'update')
    assert.equal(change.matches[0].match, 'exact')
  })

  it('preserves a missing trailing newline', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch\n'
    assert.equal(plan(text, { 'a.txt': 'a' }).changes[0].after, 'b')
  })

  it('preserves a present trailing newline', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch\n'
    assert.equal(plan(text, { 'a.txt': 'a\n' }).changes[0].after, 'b\n')
  })

  it('applies several hunks in one file', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-one',
      '+ONE',
      '@@',
      '-three',
      '+THREE',
      '*** End Patch',
      '',
    ].join('\n')
    assert.equal(plan(text, { 'a.txt': 'one\ntwo\nthree\n' }).changes[0].after, 'ONE\ntwo\nTHREE\n')
  })

  // A context-free hunk says what to insert but not where. Codex inserts at its
  // running cursor, which silently prepends to the file when the hunk is first.
  it('refuses a context-free hunk that does not append', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n+tail\n*** End Patch\n'
    const message = failure(() => plan(text, { 'a.txt': 'head\n' })).message
    assert.match(message, /inserts without any context/)
    assert.match(message, /End of File/)
  })

  it('appends at end of file when the hunk says so', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n+tail\n*** End of File\n*** End Patch\n'
    assert.equal(plan(text, { 'a.txt': 'head\n' }).changes[0].after, 'head\ntail\n')
  })

  it('refuses a missing file', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch\n'
    assert.match(failure(() => plan(text)).message, /does not exist/)
  })

  it('refuses a hunk that matches nothing', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n-absent\n+present\n*** End Patch\n'
    assert.match(failure(() => plan(text, { 'a.txt': 'other\n' })).message, /does not match the file/)
  })

  it('names the hunk header in the failure', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@ def gone():\n-absent\n+present\n*** End Patch\n'
    assert.match(failure(() => plan(text, { 'a.txt': 'other\n' })).message, /near "def gone\(\):"/)
  })
})

describe('uniqueness', () => {
  // This is the property Codex's apply_patch does not have: it takes the first
  // match and edits it, even when several sites are identical.
  it('refuses an ambiguous anchor and lists the candidates', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n-same\n+changed\n*** End Patch\n'
    const message = failure(() => plan(text, { 'a.txt': 'same\nmiddle\nsame\n' })).message
    assert.match(message, /matches 2 places/)
    assert.match(message, /lines 1, 3/)
    assert.match(message, /Add surrounding context/)
  })

  it('disambiguates when context narrows the match to one site', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      ' first',
      '-same',
      '+changed',
      '*** End Patch',
      '',
    ].join('\n')
    const change = plan(text, { 'a.txt': 'same\nmiddle\nfirst\nsame\n' }).changes[0]
    assert.equal(change.after, 'same\nmiddle\nfirst\nchanged\n')
  })

  // Two bare `-same` hunks against `same\nsame\n` are refused: neither hunk on
  // its own identifies a site. A real patch quotes enough context to say which
  // is which, and then both apply.
  it('refuses successive bare hunks against identical lines', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-same',
      '+first',
      '@@',
      '-same',
      '+second',
      '*** End Patch',
      '',
    ].join('\n')
    assert.match(failure(() => plan(text, { 'a.txt': 'same\nsame\n' })).message, /matches 2 places/)
  })

  it('applies successive context-bearing hunks to repeated blocks in order', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      ' start',
      '-same',
      '+first',
      '@@',
      ' middle',
      '-same',
      '+second',
      '*** End Patch',
      '',
    ].join('\n')
    const file = 'start\nsame\nmiddle\nsame\n'
    assert.equal(plan(text, { 'a.txt': file }).changes[0].after, 'start\nfirst\nmiddle\nsecond\n')
  })
})

describe('tolerance ladder', () => {
  it('matches despite trailing whitespace, and reports the rung', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+beta\n*** End Patch\n'
    const change = plan(text, { 'a.txt': 'alpha   \n' }).changes[0]
    assert.equal(change.after, 'beta\n')
    assert.equal(change.matches[0].match, 'rstrip')
  })

  it('matches despite leading indentation differences', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n-    indented\n+flat\n*** End Patch\n'
    const change = plan(text, { 'a.txt': '\tindented\n' }).changes[0]
    assert.equal(change.after, 'flat\n')
    assert.equal(change.matches[0].match, 'trim')
  })

  it('matches typographic punctuation against ASCII', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n-// a - b\n+// c\n*** End Patch\n'
    const change = plan(text, { 'a.txt': '// a \u2014 b\n' }).changes[0]
    assert.equal(change.after, '// c\n')
    assert.equal(change.matches[0].match, 'punctuation')
  })
})

describe('move', () => {
  // A rename needs the source removed, and `fs` has no remove operation. Writing
  // only the destination would leave a silent copy.
  it('refuses, pointing at the bash tool', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-a\n+b\n*** End Patch\n'
    const message = failure(() => plan(text, { 'a.txt': 'a\n' })).message
    assert.match(message, /cannot move a\.txt to b\.txt/)
    assert.match(message, /bash tool/)
    assert.match(message, /leave the original behind/)
  })
})

describe('atomicity', () => {
  // Nothing is written by planPatch, so a failure anywhere yields no plan at
  // all. Codex's apply_patch stops mid-way with earlier files already changed.
  it('yields no plan when a later operation fails', () => {
    const text = [
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+created',
      '*** Update File: missing.txt',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
      '',
    ].join('\n')
    assert.throws(() => plan(text), PatchApplyError)
  })

  it('rejects two operations targeting one path', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-a',
      '+b',
      '*** Update File: a.txt',
      '@@',
      '-b',
      '+c',
      '*** End Patch',
      '',
    ].join('\n')
    assert.match(failure(() => plan(text, { 'a.txt': 'a\n' })).message, /more than once/)
  })

  it('exposes the error path', () => {
    const text = '*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** End Patch\n'
    const error = failure(() => plan(text, { 'a.txt': 'other\n' })) as PatchApplyError
    assert.equal(error.path, 'a.txt')
    assert.equal(error.name, 'PatchApplyError')
  })
})
