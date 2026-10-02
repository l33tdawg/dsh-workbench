/**
 * Line-level diff between two file contents, bounded for a tool result.
 *
 * The model already knows what it asked for. What it cannot see is where the
 * change landed: a literal `edit` matches somewhere in the file, a `write`
 * replaces whatever was there, and a patch hunk may be accepted under a lenient
 * matching rung. This computes the smallest honest answer to "what actually
 * changed" from the before/after pair the tool already returned.
 *
 * Two properties matter:
 *
 * - **It is a real diff, not a restatement of the arguments.** `replace_all`
 *   changes several places, and only the before/after pair knows where they are.
 * - **It is bounded.** A whole-file rewrite must not put the file back into the
 *   context, so an oversized region reports a summary instead of hunks.
 *
 * @module @l33tdawg/dsh-edit-feedback/diff
 */

/** One line of a hunk, in unified-diff form. */
export interface DiffLine {
  /** `' '` context, `'-'` removed, `'+'` added. */
  readonly kind: ' ' | '-' | '+'
  /** The line's text, without its terminator and without the marker. */
  readonly text: string
}

/** One contiguous changed region with its surrounding context. */
export interface Hunk {
  /** 1-based line in the content before the change where this hunk starts. */
  readonly beforeStart: number
  /** Lines from the before content, context included. */
  readonly beforeCount: number
  /** 1-based line in the content after the change where this hunk starts. */
  readonly afterStart: number
  /** Lines from the after content, context included. */
  readonly afterCount: number
  readonly lines: readonly DiffLine[]
}

/** What {@link diffLines} found. */
export type DiffResult =
  | { readonly kind: 'same' }
  | { readonly kind: 'hunks'; readonly hunks: readonly Hunk[] }
  | {
    readonly kind: 'too-large'
    /** Lines in the changed region of the before content, context excluded. */
    readonly beforeLines: number
    /** Lines in the changed region of the after content, context excluded. */
    readonly afterLines: number
  }

/**
 * Largest LCS table this will build.
 *
 * The table is `before * after` 32-bit cells, so this caps it at 16 MB and a few
 * tens of milliseconds, which is the most a tool result may reasonably cost. It
 * is only ever reached by a large rewrite, because the common prefix and suffix
 * are stripped first and an ordinary edit leaves a handful of lines behind.
 */
const MAX_CELLS = 4_000_000

/** One step of an edit script. */
interface Op {
  readonly kind: 'equal' | 'delete' | 'insert'
  readonly text: string
}

/**
 * Split content into lines.
 *
 * A trailing newline is a terminator, not a final empty line: keeping it would
 * report a change to every file whose last line gained or lost its newline,
 * which is not what the reader is looking for.
 *
 * @param text - the file content.
 * @returns its lines, with the terminator removed.
 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Longest common subsequence of two line arrays, as an edit script.
 *
 * @param before - the before lines, already trimmed of their common affixes.
 * @param after - the after lines, already trimmed of their common affixes.
 * @returns the operations that turn `before` into `after`.
 */
function lcsOps(before: readonly string[], after: readonly string[]): Op[] {
  const n = before.length
  const m = after.length
  const width = m + 1
  // dp[i][j] is the LCS length of before[i..] and after[j..], filled backwards
  // so the forward walk below can choose a step without recursing.
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = before[i] === after[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'equal', text: before[i] })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ kind: 'delete', text: before[i] })
      i++
    } else {
      ops.push({ kind: 'insert', text: after[j] })
      j++
    }
  }
  while (i < n) ops.push({ kind: 'delete', text: before[i++] })
  while (j < m) ops.push({ kind: 'insert', text: after[j++] })
  return ops
}

/**
 * Group an edit script into hunks separated by unchanged lines.
 *
 * Runs of changed lines closer together than the context window are merged, and
 * each hunk is padded with up to `context` unchanged lines either side. Line
 * numbers are tracked per side, since an insertion occupies a line in the after
 * content and none in the before content.
 *
 * @param ops - the full edit script, common affixes included.
 * @param context - unchanged lines to keep either side of a change.
 * @returns the hunks, in file order.
 */
function groupHunks(ops: readonly Op[], context: number): Hunk[] {
  const changed: number[] = []
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind !== 'equal') changed.push(i)
  }
  if (changed.length === 0) return []

  // Merge changed positions into ranges, joining two ranges when the unchanged
  // run between them is no larger than the context they would each carry.
  const ranges: Array<readonly [number, number]> = []
  let start = changed[0]
  let end = changed[0]
  for (const at of changed.slice(1)) {
    if (at - end - 1 <= context * 2) {
      end = at
    } else {
      ranges.push([start, end])
      start = at
      end = at
    }
  }
  ranges.push([start, end])

  // Line numbers at each operation, counted separately for each side.
  const beforeAt: number[] = []
  const afterAt: number[] = []
  let beforeLine = 1
  let afterLine = 1
  for (const op of ops) {
    beforeAt.push(beforeLine)
    afterAt.push(afterLine)
    if (op.kind !== 'insert') beforeLine++
    if (op.kind !== 'delete') afterLine++
  }

  return ranges.map(([from, to]) => {
    const first = Math.max(0, from - context)
    const last = Math.min(ops.length - 1, to + context)
    const slice = ops.slice(first, last + 1)
    return {
      beforeStart: beforeAt[first],
      beforeCount: slice.filter(op => op.kind !== 'insert').length,
      afterStart: afterAt[first],
      afterCount: slice.filter(op => op.kind !== 'delete').length,
      lines: slice.map(op => ({
        kind: op.kind === 'equal' ? ' ' as const : op.kind === 'delete' ? '-' as const : '+' as const,
        text: op.text,
      })),
    }
  })
}

/**
 * Diff two file contents by line.
 *
 * @param before - the content before the change.
 * @param after - the content after the change.
 * @param context - unchanged lines to keep either side of each change.
 * @returns the hunks, a `same` verdict, or a `too-large` summary.
 */
export function diffLines(before: string, after: string, context = 2): DiffResult {
  if (before === after) return { kind: 'same' }

  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)

  // Stripping the shared affixes first is what keeps the table small: a
  // one-line edit in a 10,000-line file leaves a two-line problem behind.
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]) prefix++
  let suffix = 0
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix++

  const middleBefore = beforeLines.slice(prefix, beforeLines.length - suffix)
  const middleAfter = afterLines.slice(prefix, afterLines.length - suffix)

  // Both middles empty means the line sequences are identical and only the
  // final terminator differed, which is not a change worth reporting.
  if (middleBefore.length === 0 && middleAfter.length === 0) return { kind: 'same' }

  if (middleBefore.length * middleAfter.length > MAX_CELLS) {
    return { kind: 'too-large', beforeLines: middleBefore.length, afterLines: middleAfter.length }
  }

  const ops: Op[] = [
    ...beforeLines.slice(0, prefix).map(text => ({ kind: 'equal' as const, text })),
    ...lcsOps(middleBefore, middleAfter),
    ...beforeLines.slice(beforeLines.length - suffix).map(text => ({ kind: 'equal' as const, text })),
  ]
  return { kind: 'hunks', hunks: groupHunks(ops, context) }
}

/**
 * Render one hunk's unified-diff header.
 *
 * A side with no lines of its own starts at the line before the change, which is
 * the convention a pure insertion or deletion is read with.
 *
 * @param hunk - the hunk to head.
 * @returns the `@@ -a,b +c,d @@` line.
 */
export function hunkHeader(hunk: Hunk): string {
  const beforeStart = hunk.beforeCount === 0 ? hunk.beforeStart - 1 : hunk.beforeStart
  const afterStart = hunk.afterCount === 0 ? hunk.afterStart - 1 : hunk.afterStart
  return `@@ -${beforeStart},${hunk.beforeCount} +${afterStart},${hunk.afterCount} @@`
}
