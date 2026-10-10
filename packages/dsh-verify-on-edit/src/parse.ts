/**
 * Parse compiler and linter output into diagnostics with a file path.
 *
 * Located diagnostics let the report prioritize edited files while keeping
 * failures in untouched consumers visible. Paths alone do not establish which
 * changes caused a failure.
 *
 * Five shapes cover the checkers worth supporting:
 *
 *   tsc        src/app.ts(12,5): error TS2322: ...
 *   cargo      src/main.rs:12:5: error[E0308]: ...
 *   ruff, go   src/app.py:12:5: F401 ...
 *   pyright    src/app.py:12:5 - error: ...
 *   pytest     /abs/path/test_app.py:12: assert 4 == 5
 *
 * `pytest` reaches the `path:line:` shape by running with `--tb=line`; its
 * default traceback puts the location on its own `-->` line and the message
 * several lines later, which no single-line pattern can join back together.
 *
 * @module @l33tdawg/dsh-verify-on-edit/parse
 */

/** One problem reported by a checker. */
export interface Diagnostic {
  /** Path exactly as the checker printed it, which may be relative to the check's cwd. */
  readonly file: string
  /** 1-based line, when the checker reported one. */
  readonly line: number | undefined
  /** 1-based column, when the checker reported one. */
  readonly column: number | undefined
  /** Severity as printed, lowercased. `error` when the checker did not say. */
  readonly severity: string
  /** The message, with the location prefix removed. */
  readonly message: string
  /** The whole original line, for display. */
  readonly raw: string
}

/** `path(line,col):` — tsc, and anything mimicking it. */
const PAREN = /^(?<file>[^()\s][^()]*?)\((?<line>\d+),(?<col>\d+)\):\s*(?<rest>.+)$/

/** `path:line:col:` — cargo, ruff, go, eslint in unix format. */
const COLON = /^(?<file>[^\s:][^:]*?):(?<line>\d+):(?<col>\d+):\s*(?<rest>.+)$/

/** `path:line:` — checkers that omit the column. */
const COLON_NO_COL = /^(?<file>[^\s:][^:]*?):(?<line>\d+):\s*(?<rest>.+)$/

/** `path:line:col - ` — pyright. */
const DASH = /^(?<file>[^\s:][^:]*?):(?<line>\d+):(?<col>\d+)\s+-\s+(?<rest>.+)$/

/** Strip a `error TS2322:` / `error[E0308]:` / `error:` prefix, keeping any diagnostic code. */
function splitSeverity(rest: string): { severity: string, message: string } {
  // The code matters: `TS2322` and `E0308` are stable identifiers the agent can
  // look up, so only the severity word itself is removed.
  const match = /^(?<severity>error|warning|note|info|help)\s*(?:\[(?<bracket>[^\]]+)\]|(?<code>[A-Z]{1,4}\d+))?\s*:?\s*(?<message>.*)$/i.exec(rest)
  if (!match?.groups) return { severity: 'error', message: rest }
  const { severity, bracket, code, message } = match.groups as
    { severity: string, bracket?: string, code?: string, message: string }
  const identifier = bracket ?? code
  const body = message.trim()
  return {
    severity: severity.toLowerCase(),
    message: identifier === undefined ? body : (body.length === 0 ? identifier : `${identifier}: ${body}`),
  }
}

/**
 * Parse one line of checker output.
 * @param line - a single output line.
 * @returns the diagnostic, or `undefined` when the line is not a located problem.
 */
export function parseDiagnostic(line: string): Diagnostic | undefined {
  const text = line.trimEnd()
  if (text.length === 0) return undefined
  // A continuation line (a source excerpt, a caret run) never names a location.
  if (/^\s*(\^+|~+|\||\d+\s*\|)/.test(text)) return undefined
  // A URL is not a path. Rejecting the whole line here is narrower than
  // inspecting the captured "file", which would also reject `b.ts`.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return undefined

  for (const pattern of [PAREN, DASH, COLON, COLON_NO_COL]) {
    const match = pattern.exec(text)
    if (!match?.groups) continue
    const { file, line: lineNo, rest } = match.groups as { file: string, line: string, col?: string, rest: string }
    const column = (match.groups as { col?: string }).col
    if (rest.trim().length === 0) continue
    const { severity, message } = splitSeverity(rest)
    return {
      file,
      line: Number(lineNo),
      column: column === undefined ? undefined : Number(column),
      severity,
      message: message.trim(),
      raw: text,
    }
  }
  return undefined
}

/**
 * Parse a whole checker run.
 * @param output - combined stdout and stderr.
 * @returns every located diagnostic, in output order.
 */
export function parseDiagnostics(output: string): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const line of output.split('\n')) {
    const diagnostic = parseDiagnostic(line)
    if (diagnostic !== undefined) found.push(diagnostic)
  }
  return found
}

/** Whether a diagnostic is an error rather than a warning or note. */
export function isError(diagnostic: Diagnostic): boolean {
  return diagnostic.severity === 'error'
}

/**
 * Normalize a path for comparison: strip a leading `./`, and unify separators.
 * Checkers disagree about all three, and a mismatch here silently drops the
 * diagnostic that mattered.
 * @param path - a path as printed by a checker or reported by a tool.
 * @returns the comparable form.
 */
export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

/**
 * Whether a diagnostic concerns one of the files the agent edited.
 *
 * Matching is by suffix so a checker reporting `src/app.ts` against an edit
 * recorded as `/repo/src/app.ts` still attributes correctly, and so a monorepo
 * package path resolves against a workspace-relative one.
 *
 * @param diagnostic - the parsed diagnostic.
 * @param edited - absolute or workspace-relative paths the agent has edited.
 * @returns whether this diagnostic is attributable to the agent's work.
 */
export function concernsEditedFile(diagnostic: Diagnostic, edited: readonly string[]): boolean {
  const target = normalizePath(diagnostic.file)
  return edited.some(path => {
    const candidate = normalizePath(path)
    return candidate === target || candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`)
  })
}

/**
 * Group diagnostics by file and cap how many are shown, so a check that fails
 * broadly does not push a wall of text into the next request.
 * @param diagnostics - the diagnostics to summarize.
 * @param perFile - maximum entries to keep per file.
 * @returns a bounded, grouped summary.
 */
export function summarize(
  diagnostics: readonly Diagnostic[],
  perFile = 5,
): { file: string, items: Diagnostic[], omitted: number }[] {
  const groups = new Map<string, Diagnostic[]>()
  for (const diagnostic of diagnostics) {
    const key = normalizePath(diagnostic.file)
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [diagnostic])
    else bucket.push(diagnostic)
  }
  return [...groups].map(([file, items]) => ({
    file,
    items: items.slice(0, perFile),
    omitted: Math.max(0, items.length - perFile),
  }))
}
