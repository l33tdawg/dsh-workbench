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
import { join, relative, resolve, sep } from 'node:path'
import { SKIPPED_DIRECTORIES, type ScanSource } from './scan.ts'

/** Runs a command and returns its stdout, or throws with stderr attached. */
export type RunCommand = (command: string, args: string[]) => Promise<string>

/**
 * A source reading the live working tree.
 *
 * A path naming a file or directory is normally relative to `root`. An
 * absolute path is read as itself, which is how a claim about a tree outside
 * the workspace is checked: `root` is where a relative path starts, not a fence
 * every read stays behind.
 *
 * Candidates under an absolute path come back relative to `root` when they sit
 * under it, and absolute otherwise, so a caller can always resolve them through
 * the same `root` it passed in.
 *
 * @param root - absolute workspace root.
 * @returns a source whose paths are relative to `root` unless they fall outside
 * it, in which case they are absolute.
 */
export function workingTreeSource(root: string): ScanSource {
  return {
    describe: 'working tree',
    async list(path: string): Promise<string[]> {
      const absolute = resolve(root, path)
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
    async size(path: string): Promise<number | undefined> {
      try {
        const info = statSync(resolve(root, path))
        return info.isFile() ? info.size : undefined
      } catch {
        return undefined
      }
    },
    async read(path: string): Promise<string | undefined> {
      try {
        return readFileSync(resolve(root, path), 'utf8')
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Recursively collect regular files, skipping dependency and build directories.
 * @param directory - absolute directory to walk.
 * @param base - absolute directory the returned paths are relative to.
 * @param found - accumulator.
 */
function walk(directory: string, base: string, found: string[]): void {
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
      walk(absolute, base, found)
    } else if (entry.isFile()) {
      found.push(toPosix(relative(base, absolute)))
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
  /** Sizes taken from the same listing, so measuring costs no extra git call. */
  const sizes = new Map<string, number>()

  return {
    describe: `revision ${revision}`,
    async list(path: string): Promise<string[]> {
      const cached = listings.get(path)
      if (cached !== undefined) return cached
      let out: string
      try {
        out = await run('git', ['ls-tree', '-r', '-l', revision, '--', path])
      } catch {
        return []
      }
      const files: string[] = []
      for (const line of out.split('\n')) {
        // `<mode> <type> <sha> <size>\t<path>`: the long form carries the byte
        // count, which is what makes the bound checkable before the read.
        const tab = line.indexOf('\t')
        if (tab === -1) continue
        const name = line.slice(tab + 1).trim()
        if (name === '') continue
        files.push(name)
        const bytes = Number.parseInt(line.slice(0, tab).trim().split(/\s+/)[3] ?? '', 10)
        if (Number.isSafeInteger(bytes) && bytes >= 0) sizes.set(name, bytes)
      }
      listings.set(path, files)
      return files
    },
    async size(path: string): Promise<number | undefined> {
      const cached = sizes.get(path)
      if (cached !== undefined) return cached
      // A path named as a file is read without listing, so its size comes from
      // the blob itself rather than from a listing that never ran.
      try {
        const out = await run('git', ['cat-file', '-s', `${revision}:${path}`])
        const bytes = Number.parseInt(out.trim(), 10)
        return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined
      } catch {
        return undefined
      }
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
