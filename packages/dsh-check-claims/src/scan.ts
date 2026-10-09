/**
 * Reading the text a claim is about, from the working tree or a revision.
 *
 * The scanner exists because ad-hoc shell searches under-report in ways that
 * look like evidence. A pipeline can truncate, a pattern written as one line
 * cannot match text that wraps, and a search of the working tree answers a
 * question about the working tree even when the claim was about a revision.
 *
 * So the two jobs here are: make the source explicit, and never let a bounded
 * scan report itself as a complete one. A partial count is returned with
 * `incomplete: true` and a reason, which the caller is expected to surface
 * rather than round off.
 *
 * @module @l33tdawg/dsh-check-claims/scan
 */

/** A file's text, keyed by its path relative to the scan root. */
export interface ScannedFile {
  /** Path relative to the scan root, always `/`-separated. */
  path: string
  /** Full text, decoded as UTF-8. */
  text: string
}

/** The outcome of reading everything a scan covers. */
export interface ScanResult {
  /** Files that were read, in listing order. */
  files: ScannedFile[]
  /**
   * True when the scan stopped before covering everything it was asked for, so
   * every count derived from it is a floor. Never silently dropped: a caller
   * that ignores this reports a bounded search as a total.
   */
  incomplete: boolean
  /** Why the scan did not cover everything, when it did not. */
  reason?: string
  /** Files read. */
  read: number
  /** Files skipped because they were binary, oversized, or unreadable. */
  skipped: number
}

/** Directory names never descended into. */
export const SKIPPED_DIRECTORIES: readonly string[] = [
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', 'vendor',
]

/** Bounds on a single scan. */
export interface ScanLimits {
  /** Maximum files to read before declaring the scan incomplete. */
  maxFiles: number
  /** Maximum size of a single file to read, in bytes. */
  maxFileBytes: number
}

/** Defaults chosen to cover a large monorepo without hanging a tool call. */
export const DEFAULT_LIMITS: ScanLimits = { maxFiles: 20_000, maxFileBytes: 2_000_000 }

/** The I/O a scan needs, injected so both sources and tests share one shape. */
export interface ScanSource {
  /** Lists candidate files under a workspace-relative path, `/`-separated. */
  list: (path: string) => Promise<string[]>
  /**
   * One candidate's size in bytes, or `undefined` when it cannot be
   * determined: an unreadable path, or a source that cannot measure at all.
   *
   * Asked before {@link ScanSource.read}, because the size bound is only a
   * bound when it holds first. This runtime ends the process on the decode of
   * a file past its string limit instead of throwing, so a scan that reads and
   * then measures has nothing to catch: it takes the host process down with it.
   */
  size: (path: string) => Promise<number | undefined>
  /** Reads one workspace-relative file, or `undefined` when it cannot be read. */
  read: (path: string) => Promise<string | undefined>
  /** Text describing where this source reads from, for the report. */
  describe: string
}

/** Answer used when a path is a file rather than a directory. */
function isLikelyFile(path: string): boolean {
  const last = path.split('/').pop() ?? ''
  return last.includes('.')
}

/**
 * Strip a scan base from a candidate path, leaving what the caller named.
 *
 * A relative path is already relative to the base and comes back unchanged. An
 * absolute path is reported relative to the base only when it really sits under
 * it: `/w2/f` is not under `/w`, and the separator test is what keeps a
 * sibling directory from being trimmed into a path that reads as inside.
 *
 * @param path - the candidate path.
 * @param base - the absolute scan base, when there is one.
 * @returns the path to report.
 */
function relativize(path: string, base: string | undefined): string {
  if (base === undefined || !path.startsWith('/')) return path
  const prefix = base.endsWith('/') ? base : `${base}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * Read everything a source covers under a path.
 *
 * A path naming a file is read directly. A directory is walked, and the walk
 * stops with `incomplete: true` once `maxFiles` is reached rather than
 * pretending the remainder does not exist.
 *
 * A file over `maxFileBytes` is skipped before it is read, because counting
 * inside a file this tool cannot read is exactly the mistake it exists to
 * prevent: a directory holding one small file and one oversized file would
 * otherwise report the oversized file's contents as absent. Reading it first is
 * not an option: a decode past the runtime's string limit ends the process
 * rather than throwing, so the bound has to hold before the file is opened.
 * Skipping is safe only alongside `incomplete: true`.
 *
 * @param source - the injected I/O.
 * @param path - workspace-relative file or directory to cover.
 * @param base - the scan root `path` is relative to, when that is not the
 * session workspace's own root. Scanning from another base is what makes a
 * claim about an upstream checkout checkable at all.
 * @param limits - bounds for this scan.
 * @returns the files read, and whether the scan was complete.
 */
export async function scan(
  source: ScanSource,
  path: string,
  base: string | undefined = undefined,
  limits: ScanLimits = DEFAULT_LIMITS,
): Promise<ScanResult> {
  const candidates = isLikelyFile(path) ? [path] : await source.list(path)
  const files: ScannedFile[] = []
  let skipped = 0
  let oversized = 0

  for (const candidate of candidates) {
    // Reported relative to the scan base, so a site stays openable from the
    // directory the caller named rather than from the workspace.
    const shown = relativize(candidate, base)
    if (files.length >= limits.maxFiles) {
      return {
        files,
        incomplete: true,
        reason: `stopped at the ${limits.maxFiles}-file limit; ${candidates.length} files were in scope`,
        read: files.length,
        skipped,
      }
    }
    // Measured first, so a file this scan will refuse to count is never read.
    // An unknown size falls through to the check after the read.
    const measured = await source.size(candidate)
    if (measured !== undefined && measured > limits.maxFileBytes) {
      skipped++
      oversized++
      continue
    }
    const text = await source.read(candidate)
    if (text === undefined) {
      skipped++
      continue
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > limits.maxFileBytes) {
      skipped++
      oversized++
      continue
    }
    // A NUL byte in the first block means binary; counting matches in it would
    // report noise as evidence.
    if (text.includes('\u0000')) {
      skipped++
      continue
    }
    files.push({ path: shown, text })
  }

  const result: ScanResult = { files, incomplete: false, read: files.length, skipped }
  // Size is not binary-ness: an oversized file holds text this scan did not
  // read, so its matches are missing from the count rather than noise in it.
  // Leaving `incomplete` false here would turn a bound into a false pass.
  if (oversized > 0) {
    result.incomplete = true
    result.reason =
      `skipped ${oversized} file${oversized === 1 ? '' : 's'} over the ${limits.maxFileBytes}-byte limit`
  }
  // A directory that listed nothing is not incomplete, but a path that does not
  // exist is worth distinguishing, so the caller is told which it got.
  if (candidates.length === 0) result.reason = 'nothing to read at this path'
  return result
}
