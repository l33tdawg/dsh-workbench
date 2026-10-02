/**
 * Parser for the file-oriented patch format used by `apply_patch`.
 *
 * The grammar is a stripped-down diff: a `*** Begin Patch` / `*** End Patch`
 * envelope containing Add, Delete, and Update file sections. Parsing only
 * validates shape and collects hunks; it never touches the filesystem, which is
 * what lets the tool compute every change before committing any of them.
 *
 * Markers are matched leniently (surrounding whitespace is ignored) because a
 * model reproducing the format from a prompt occasionally pads a line.
 *
 * @module @l33tdawg/dsh-apply-patch/parser
 */

/** One `+`, `-`, or context line inside an update hunk. */
export interface HunkLine {
  /** `+` adds, `-` removes, ` ` keeps. */
  readonly kind: '+' | '-' | ' '
  /** Line content without the leading marker. */
  readonly text: string
}

/** One `@@`-delimited region of an update. */
export interface Hunk {
  /** Hunk header text after `@@`, when present. Informational only. */
  readonly header: string | undefined
  /** Lines of the hunk, in file order. */
  readonly lines: readonly HunkLine[]
  /** Whether `*** End of File` terminated this hunk. */
  readonly eof: boolean
}

/** A create, delete, update, or move operation on one file. */
export type FileOp =
  | { readonly kind: 'add', readonly path: string, readonly lines: readonly string[] }
  | { readonly kind: 'delete', readonly path: string }
  | {
      readonly kind: 'update'
      readonly path: string
      readonly moveTo: string | undefined
      readonly hunks: readonly Hunk[]
    }

/** A parsed patch. */
export interface Patch {
  /** File operations in declaration order. */
  readonly ops: readonly FileOp[]
}

/** A parse failure carrying the 1-based input line that caused it. */
export class PatchParseError extends Error {
  /** 1-based line number in the patch text. */
  readonly line: number

  constructor(message: string, line: number) {
    super(`invalid patch at line ${line}: ${message}`)
    this.name = 'PatchParseError'
    this.line = line
  }
}

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File:'
const DELETE = '*** Delete File:'
const UPDATE = '*** Update File:'
const MOVE = '*** Move to:'
const EOF = '*** End of File'

/**
 * Parse patch text into file operations.
 *
 * @param text - The complete patch, with or without a trailing newline.
 * @returns The parsed operations, in declaration order.
 * @throws {PatchParseError} When the envelope or a section is malformed.
 */
export function parsePatch(text: string): Patch {
  if (typeof text !== 'string') throw new PatchParseError('patch must be a string', 1)
  const lines = text.split('\n')
  let index = 0

  /** The current 1-based line number, for diagnostics. */
  const at = () => index + 1

  /** Advance past blank lines. */
  const skipBlank = () => {
    while (index < lines.length && lines[index].trim() === '') index++
  }

  skipBlank()
  if (index >= lines.length || lines[index].trim() !== BEGIN) {
    throw new PatchParseError(`expected "${BEGIN}"`, at())
  }
  index++

  const ops: FileOp[] = []
  for (;;) {
    skipBlank()
    if (index >= lines.length) throw new PatchParseError(`missing "${END}"`, at())
    const marker = lines[index].trim()
    if (marker === END) { index++; break }
    if (marker.startsWith(ADD)) ops.push(readAdd(lines, () => index, i => { index = i }))
    else if (marker.startsWith(DELETE)) ops.push(readDelete(lines, () => index, i => { index = i }))
    else if (marker.startsWith(UPDATE)) ops.push(readUpdate(lines, () => index, i => { index = i }))
    else throw new PatchParseError(`unexpected line ${JSON.stringify(lines[index])}`, at())
  }

  // Trailing content after `*** End Patch` is tolerated only when blank, so a
  // model that appends an explanation does not silently lose it unnoticed.
  for (let i = index; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      throw new PatchParseError('unexpected content after "*** End Patch"', i + 1)
    }
  }

  if (ops.length === 0) throw new PatchParseError('patch contains no file operations', 1)
  return { ops }
}

/** Read the body of an Add section. */
function readAdd(lines: readonly string[], get: () => number, set: (value: number) => void): FileOp {
  const start = get()
  const path = requirePath(lines[start], ADD, start + 1)
  let index = start + 1
  const body: string[] = []
  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === END || trimmed.startsWith('*** ')) break
    if (!line.startsWith('+')) {
      throw new PatchParseError(`add line must start with "+": ${JSON.stringify(line)}`, index + 1)
    }
    body.push(line.slice(1))
    index++
  }
  if (body.length === 0) throw new PatchParseError(`add section for ${path} has no content`, start + 1)
  set(index)
  return { kind: 'add', path, lines: body }
}

/** Read a Delete section. */
function readDelete(lines: readonly string[], get: () => number, set: (value: number) => void): FileOp {
  const start = get()
  const path = requirePath(lines[start], DELETE, start + 1)
  set(start + 1)
  return { kind: 'delete', path }
}

/** Read an Update section, including an optional move and its hunks. */
function readUpdate(lines: readonly string[], get: () => number, set: (value: number) => void): FileOp {
  const start = get()
  const path = requirePath(lines[start], UPDATE, start + 1)
  let index = start + 1
  let moveTo: string | undefined

  if (index < lines.length && lines[index].trim().startsWith(MOVE)) {
    moveTo = requirePath(lines[index], MOVE, index + 1)
    index++
  }

  const hunks: Hunk[] = []
  while (index < lines.length) {
    const trimmed = lines[index].trim()
    if (trimmed === END || trimmed.startsWith(ADD) || trimmed.startsWith(DELETE) || trimmed.startsWith(UPDATE)) break
    if (!trimmed.startsWith('@@')) {
      throw new PatchParseError(`expected "@@" or a new section, found ${JSON.stringify(lines[index])}`, index + 1)
    }
    const header = trimmed.slice(2).trim()
    index++
    const body: HunkLine[] = []
    let eof = false
    while (index < lines.length) {
      const line = lines[index]
      const lineTrimmed = line.trim()
      if (lineTrimmed === EOF) { eof = true; index++; break }
      if (lineTrimmed.startsWith('@@') || lineTrimmed === END
        || lineTrimmed.startsWith(ADD) || lineTrimmed.startsWith(DELETE) || lineTrimmed.startsWith(UPDATE)) break
      if (lineTrimmed === '') {
        // A blank line inside a hunk is a context line for an empty line.
        body.push({ kind: ' ', text: '' })
        index++
        continue
      }
      const marker = line[0]
      if (marker !== '+' && marker !== '-' && marker !== ' ') {
        throw new PatchParseError(`hunk line must start with "+", "-" or " ": ${JSON.stringify(line)}`, index + 1)
      }
      body.push({ kind: marker, text: line.slice(1) })
      index++
    }
    if (body.length === 0 && !eof) {
      throw new PatchParseError(`hunk for ${path} is empty`, index)
    }
    hunks.push({ header: header === '' ? undefined : header, lines: body, eof })
  }

  if (hunks.length === 0 && moveTo === undefined) {
    throw new PatchParseError(`update section for ${path} has no hunks and no move`, start + 1)
  }
  set(index)
  return { kind: 'update', path, moveTo, hunks }
}

/** Extract the path following a section marker. */
function requirePath(line: string, marker: string, lineNumber: number): string {
  const path = line.trim().slice(marker.length).trim()
  if (path === '') throw new PatchParseError(`${marker} requires a path`, lineNumber)
  return path
}
