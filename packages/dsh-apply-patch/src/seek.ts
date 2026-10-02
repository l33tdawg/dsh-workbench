/**
 * Context location for patch hunks.
 *
 * A hunk describes where a change goes by quoting the lines around it, not by
 * line number, so applying it means finding that quoted block. Models reproduce
 * quoted context imperfectly — trailing spaces, a tab rendered as spaces,
 * typographic punctuation — so a single exact-match rule rejects patches a human
 * would consider correct.
 *
 * Two properties matter, and the two reference harnesses each get one of them:
 *
 * - **Tolerance.** Codex descends a ladder of decreasing strictness so a patch
 *   written against slightly different whitespace still applies.
 * - **Uniqueness.** DSH refuses an ambiguous anchor outright rather than editing
 *   the first of several identical sites, which is how a correct-looking patch
 *   lands on the wrong line.
 *
 * This module takes both. Each rung is tried in order, and a rung is accepted
 * only when it matches **exactly one** position at or after the cursor. An
 * ambiguous rung is rejected rather than guessed at, and the caller reports the
 * competing positions so the model can add discriminating context.
 *
 * @module @l33tdawg/dsh-apply-patch/seek
 */

/** How a match was found, from strictest to loosest. */
export type MatchKind = 'exact' | 'rstrip' | 'trim' | 'punctuation'

/** The outcome of locating a hunk's context. */
export type SeekResult =
  | {
      readonly kind: 'found'
      /** 0-based index of the first matched line. */
      readonly index: number
      /** Which rung matched. `exact` means no leniency was needed. */
      readonly match: MatchKind
    }
  | {
      readonly kind: 'missing'
      /** The strictest rung that found nothing, for diagnostics. */
      readonly tried: MatchKind
    }
  | {
      readonly kind: 'ambiguous'
      /** Which rung matched more than once. */
      readonly match: MatchKind
      /** Every 0-based position the rung matched, in ascending order. */
      readonly positions: readonly number[]
    }

/** Fold the punctuation a model is most likely to substitute. */
function normalise(line: string): string {
  return line
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018-\u201B]/g, '\'')
    .replace(/[\u201C-\u201F]/g, '"')
}

/** Compare two lines under one strictness level. */
function equalAt(actual: string, pattern: string, kind: MatchKind): boolean {
  if (kind === 'exact') return actual === pattern
  if (kind === 'rstrip') return actual.trimEnd() === pattern.trimEnd()
  if (kind === 'trim') return actual.trim() === pattern.trim()
  return normalise(actual) === normalise(pattern)
}

const LADDER: readonly MatchKind[] = ['exact', 'rstrip', 'trim', 'punctuation']

/** Every position at or after `from` where `pattern` matches under `kind`. */
function positionsAt(
  lines: readonly string[],
  pattern: readonly string[],
  from: number,
  kind: MatchKind,
): number[] {
  const found: number[] = []
  const last = lines.length - pattern.length
  for (let index = Math.max(0, from); index <= last; index++) {
    let matched = true
    for (let offset = 0; offset < pattern.length; offset++) {
      if (!equalAt(lines[index + offset], pattern[offset], kind)) {
        matched = false
        break
      }
    }
    if (matched) found.push(index)
  }
  return found
}

/**
 * Locate a hunk's context, requiring an unambiguous match.
 *
 * `from` is the running cursor: earlier hunks in the same file have already
 * consumed the text before it, so a block that legitimately appears twice can be
 * targeted by two successive hunks. Ambiguity is therefore judged only among
 * positions the current hunk could still mean.
 *
 * @param lines - The file's lines, without terminators.
 * @param pattern - Context and removed lines, without their `+`/`-`/` ` markers.
 * @param from - 0-based line the search may start at.
 * @param eof - Prefer a match anchored at the end of the file.
 * @returns Whether the context was found, missing, or ambiguous.
 */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  from: number,
  eof = false,
): SeekResult {
  if (pattern.length === 0) {
    // A pure insertion has no anchor; the caller decides where it lands.
    return { kind: 'found', index: Math.min(Math.max(0, from), lines.length), match: 'exact' }
  }
  if (pattern.length > lines.length) return { kind: 'missing', tried: 'exact' }

  if (eof) {
    const start = Math.max(from, lines.length - pattern.length)
    const anchored = seekFrom(lines, pattern, start, start)
    if (anchored !== undefined) return anchored
  }

  let strictestFailure: MatchKind = 'exact'
  for (const kind of LADDER) {
    const result = seekFrom(lines, pattern, from, undefined, kind)
    if (result === undefined) { strictestFailure = kind; continue }
    return result
  }
  return { kind: 'missing', tried: strictestFailure }
}

/**
 * Try one rung, optionally confined to a single starting position.
 * @returns The outcome, or `undefined` when this rung found nothing.
 */
function seekFrom(
  lines: readonly string[],
  pattern: readonly string[],
  from: number,
  only: number | undefined,
  kind: MatchKind = 'exact',
): SeekResult | undefined {
  const positions = (only === undefined ? positionsAt(lines, pattern, from, kind) : [only])
    .filter(index => only === undefined || matchesAt(lines, pattern, index, kind))
  if (positions.length === 0) return undefined
  if (positions.length > 1) return { kind: 'ambiguous', match: kind, positions }
  return { kind: 'found', index: positions[0], match: kind }
}

/** Whether `pattern` matches `lines` exactly at `index` under `kind`. */
function matchesAt(
  lines: readonly string[],
  pattern: readonly string[],
  index: number,
  kind: MatchKind,
): boolean {
  for (let offset = 0; offset < pattern.length; offset++) {
    if (!equalAt(lines[index + offset], pattern[offset], kind)) return false
  }
  return true
}
