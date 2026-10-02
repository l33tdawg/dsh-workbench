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
 * Read everything a source covers under a path.
 *
 * A path naming a file is read directly. A directory is walked, and the walk
 * stops with `incomplete: true` once `maxFiles` is reached rather than
 * pretending the remainder does not exist.
 *
 * @param source - the injected I/O.
 * @param path - workspace-relative file or directory to cover.
 * @param limits - bounds for this scan.
 * @returns the files read, and whether the scan was complete.
 */
export async function scan(source: ScanSource, path: string, limits: ScanLimits = DEFAULT_LIMITS): Promise<ScanResult> {
  const candidates = isLikelyFile(path) ? [path] : await source.list(path)
  const files: ScannedFile[] = []
  let skipped = 0

  for (const candidate of candidates) {
    if (files.length >= limits.maxFiles) {
      return {
        files,
        incomplete: true,
        reason: `stopped at the ${limits.maxFiles}-file limit; ${candidates.length} files were in scope`,
        read: files.length,
        skipped,
      }
    }
    const text = await source.read(candidate)
    if (text === undefined) {
      skipped++
      continue
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > limits.maxFileBytes) {
      skipped++
      continue
    }
    // A NUL byte in the first block means binary; counting matches in it would
    // report noise as evidence.
    if (text.includes('\u0000')) {
      skipped++
      continue
    }
    files.push({ path: candidate, text })
  }

  const result: ScanResult = { files, incomplete: false, read: files.length, skipped }
  // A directory that listed nothing is not incomplete, but a path that does not
  // exist is worth distinguishing, so the caller is told which it got.
  if (candidates.length === 0) result.reason = 'nothing to read at this path'
  return result
}
