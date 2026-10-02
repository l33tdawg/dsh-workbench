/**
 * Rendering a check's outcome for the model.
 *
 * The report always states the count, the scope, and the source, including when
 * the check passed. A bare "PASS" hides whether the search covered the right
 * tree, which is the failure this tool exists to catch, so a passing line still
 * carries what was searched.
 *
 * @module @l33tdawg/dsh-check-claims/report
 */

/** A verdict for one check. */
export type Verdict = 'pass' | 'fail' | 'unknown'

/** One place a pattern matched. */
export interface SiteValue {
  path: string
  line: number
}

/** One check's result, in the shape the tool returns. */
export interface CheckValue {
  pattern: string
  path: string
  at: string | null
  verdict: Verdict
  count: number
  detail: string
  /** True when the scan did not cover everything, making `count` a floor. */
  incomplete: boolean
  sites: SiteValue[]
}

/** The whole tool result. */
export interface ReportValue {
  checks: CheckValue[]
}

/** Markers chosen so a passing run and a failing one scan differently. */
const MARK: Record<Verdict, string> = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN' }

/**
 * Render every check as one model-facing block.
 *
 * @param value - the checks and their results.
 * @returns a text report naming each check's count, scope, and source.
 */
export function formatReport(value: ReportValue): string {
  const checks = value.checks
  const failed = checks.filter(check => check.verdict === 'fail').length
  const unknown = checks.filter(check => check.verdict === 'unknown').length
  const passed = checks.length - failed - unknown

  const head = `${checks.length} check(s): ${passed} pass, ${failed} fail, ${unknown} undecided`
  const body = checks.map(formatCheck).join('\n\n')
  // The temptation on a FAIL is to loosen the pattern until it matches, which
  // preserves the wrong claim instead of correcting it.
  const tail = failed > 0
    ? '\n\nA FAIL means the code does not support the claim. Fix the claim, not the pattern.'
    : ''

  return `${head}\n\n${body}${tail}`
}

/**
 * Render one check.
 *
 * @param check - the check and its result.
 * @returns the block for this check.
 */
export function formatCheck(check: CheckValue): string {
  const scope = check.at === null ? check.path : `${check.path} @ ${check.at}`
  const head = `[${MARK[check.verdict]}] /${check.pattern}/ in ${scope} - ${check.detail}`
  if (check.sites.length === 0) return head

  const shown = check.sites.map(site => `  ${site.path}:${site.line}`)
  const hidden = check.count - check.sites.length
  const more = hidden > 0 ? [`  ... and ${hidden} more`] : []
  return [head, ...shown, ...more].join('\n')
}
