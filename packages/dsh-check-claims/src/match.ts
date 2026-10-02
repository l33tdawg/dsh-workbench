/**
 * Counting matches and judging them against an expectation.
 *
 * Two rules shape this file, both learned from searches that produced confident
 * wrong answers:
 *
 *   The count is exact and is never capped. A preview of where the matches are
 *   may be bounded, and says so, but a bounded preview must not become a
 *   bounded count.
 *
 *   A scan that did not cover everything yields `incomplete`, which fails an
 *   expectation rather than passing it. "I found 0 of the 0 files I looked at"
 *   is not evidence of absence.
 *
 * @module @l33tdawg/dsh-check-claims/match
 */

import type { ScanResult } from './scan.ts'

/** Where one match was found. */
export interface MatchSite {
  /** Path relative to the scan root. */
  path: string
  /** 1-based line of the match start. */
  line: number
}

/** The outcome of counting one pattern across a scan. */
export interface CountResult {
  /** Total matches. Exact whenever `incomplete` is false. */
  count: number
  /** A bounded sample of where matches were found, for judging the search. */
  sites: MatchSite[]
  /** Files that contained at least one match. */
  filesMatched: number
  /** Files actually examined. Zero means nothing was looked at. */
  filesScanned: number
  /** True when the underlying scan was partial, making `count` a floor. */
  incomplete: boolean
  /** Why the scan was partial, when it was. */
  reason?: string
}

/** How many match sites to report before summarising the rest. */
export const SITE_LIMIT = 8

/** Read a regex flag string into something `RegExp` accepts. */
function normalizeFlags(flags: string | undefined): string {
  const set = new Set((flags ?? '').replace(/[gy]/g, '').split(''))
  set.add('g')
  return [...set].join('')
}

/**
 * Count matches of a pattern across scanned files.
 *
 * @param scan - the files to search.
 * @param pattern - regular expression source.
 * @param flags - optional regex flags; `g` is always added.
 * @returns the exact count, a bounded site preview, and the scan's completeness.
 * @throws {Error} when the pattern is not a valid regular expression.
 */
export function countMatches(scan: ScanResult, pattern: string, flags?: string): CountResult {
  let regex: RegExp
  try {
    regex = new RegExp(pattern, normalizeFlags(flags))
  } catch (error: unknown) {
    throw new Error(`invalid pattern /${pattern}/: ${(error as Error).message}`)
  }

  let count = 0
  let filesMatched = 0
  const sites: MatchSite[] = []

  for (const file of scan.files) {
    let fileHits = 0
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(file.text)) !== null) {
      count++
      fileHits++
      if (sites.length < SITE_LIMIT) {
        sites.push({ path: file.path, line: lineAt(file.text, match.index) })
      }
      // A zero-length match cannot advance lastIndex on its own, so step past it
      // rather than spinning.
      if (match[0] === '') regex.lastIndex++
      if (regex.lastIndex > file.text.length) break
    }
    if (fileHits > 0) filesMatched++
  }

  return {
    count,
    sites,
    filesMatched,
    filesScanned: scan.files.length,
    incomplete: scan.incomplete,
    ...scan.reason === undefined ? {} : { reason: scan.reason },
  }
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

/** The verdict for one check. */
export type Verdict = 'pass' | 'fail' | 'unknown'

/** One expectation and what the scan found. */
export interface Judgement {
  verdict: Verdict
  /** Human-readable explanation, always naming the actual count. */
  detail: string
}

/**
 * Judge a count against an expectation.
 *
 * A partial scan is judged by what the unread remainder could still change. The
 * true count is at least what was found, so a minimum already met holds and a
 * maximum already exceeded fails. An exact expectation never holds, because the
 * remainder can only add matches: absence from a partial read is the mistake
 * this tool exists to prevent, and it is the one a bounded search reports most
 * confidently.
 *
 * @param result - the counted matches.
 * @param expectation - exact count, minimum count, or neither.
 * @returns the verdict and an explanation.
 */
export function judge(
  result: CountResult,
  expectation: { expect?: number, atLeast?: number },
): Judgement {
  const { expect, atLeast } = expectation
  const where = result.incomplete ? ` (partial scan: ${result.reason ?? 'incomplete'})` : ''

  if (expect !== undefined && atLeast !== undefined) {
    return { verdict: 'unknown', detail: 'expect and atLeast are mutually exclusive' }
  }

  if (expect === undefined && atLeast === undefined) {
    return { verdict: 'unknown', detail: `found ${result.count}${where}; no expectation was given` }
  }

  // Nothing examined is not evidence of anything. A path that does not exist
  // otherwise satisfies "expect 0" trivially, which is the same false
  // confidence a truncated pipeline produces.
  if (result.filesScanned === 0) {
    return {
      verdict: 'unknown',
      detail: `examined no files at this path, so there is nothing to count`,
    }
  }

  if (expect !== undefined) {
    if (result.incomplete) {
      // Only "too many already" is decidable; every other case is open.
      return result.count > expect
        ? { verdict: 'fail', detail: `found ${result.count} so far, expected exactly ${expect}${where}` }
        : { verdict: 'unknown', detail: `found ${result.count} so far, expected exactly ${expect}${where}` }
    }
    return result.count === expect
      ? { verdict: 'pass', detail: `found ${result.count}, expected ${expect}` }
      : { verdict: 'fail', detail: `found ${result.count}, expected ${expect}` }
  }

  const floor = atLeast as number
  if (result.count >= floor) {
    // The count can only grow, so a minimum already met cannot be overturned.
    return { verdict: 'pass', detail: `found ${result.count}, needed at least ${floor}${where}` }
  }
  return result.incomplete
    ? { verdict: 'unknown', detail: `found ${result.count} so far, needed at least ${floor}${where}` }
    : { verdict: 'fail', detail: `found ${result.count}, needed at least ${floor}` }
}
