/**
 * The two places a claim can be about: the working tree, or a named revision.
 *
 * Keeping them as separate sources is the point. A claim about upstream
 * verified against the working tree answers a different question whenever the
 * tree carries local edits, and the answer looks identical. Naming the revision
 * makes the difference visible in the report.
 *
 * @module @l33tdawg/dsh-check-claims/sources
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { SKIPPED_DIRECTORIES, type ScanSource } from './scan.ts'

/** Runs a command and returns its stdout, or throws with stderr attached. */
export type RunCommand = (command: string, args: string[]) => Promise<string>

/**
 * A source reading the live working tree.
 *
 * @param root - absolute workspace root.
 * @returns a source whose paths are relative to `root`.
 */
export function workingTreeSource(root: string): ScanSource {
  return {
    describe: 'working tree',
    async list(path: string): Promise<string[]> {
      const absolute = join(root, path)
      let info
      try {
        info = statSync(absolute)
      } catch {
        return []
      }
      if (info.isFile()) return [toPosix(relative(root, absolute))]
      if (!info.isDirectory()) return []
      const found: string[] = []
      walk(absolute, root, found)
      return found
    },
    async read(path: string): Promise<string | undefined> {
      try {
        return readFileSync(join(root, path), 'utf8')
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Recursively collect regular files, skipping dependency and build directories.
 * @param directory - absolute directory to walk.
 * @param root - absolute root the returned paths are relative to.
 * @param found - accumulator.
 */
function walk(directory: string, root: string, found: string[]): void {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.includes(entry.name)) continue
      walk(absolute, root, found)
    } else if (entry.isFile()) {
      found.push(toPosix(relative(root, absolute)))
    }
  }
}

/** Windows separators in a path, if any. */
function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * A source reading one git revision.
 *
 * `list` and `read` both go through git rather than the filesystem, so a claim
 * about a revision is answered from that revision's content and not from
 * whatever happens to be checked out.
 *
 * @param revision - any revision git accepts, such as `origin/master` or a SHA.
 * @param run - runs a command in the repository and returns stdout.
 * @returns a source whose paths are repository-relative.
 */
export function revisionSource(revision: string, run: RunCommand): ScanSource {
  /** Cache listing results: one ls-tree per path is enough. */
  const listings = new Map<string, string[]>()

  return {
    describe: `revision ${revision}`,
    async list(path: string): Promise<string[]> {
      const cached = listings.get(path)
      if (cached !== undefined) return cached
      let out: string
      try {
        out = await run('git', ['ls-tree', '-r', '--name-only', revision, '--', path])
      } catch {
        return []
      }
      const files = out.split('\n').map(line => line.trim()).filter(line => line !== '')
      listings.set(path, files)
      return files
    },
    async read(path: string): Promise<string | undefined> {
      try {
        return await run('git', ['show', `${revision}:${path}`])
      } catch {
        return undefined
      }
    },
  }
}
