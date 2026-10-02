/**
 * Plan a patch against a set of files without touching them.
 *
 * `planPatch` is pure: it reads current content through a caller-supplied
 * function and returns the complete set of resulting file states. Nothing is
 * written here. That split is what makes `apply_patch` safe to offer — every
 * hunk is resolved and every new body computed before the first byte reaches
 * disk, so a patch that fails on its fourth file leaves the tree untouched.
 * Codex's `apply_patch` applies hunks as it goes and stops at the first error
 * with earlier files already changed; this one does not.
 *
 * @module @l33tdawg/dsh-apply-patch/apply
 */

import type { FileOp, Patch } from './parser.ts'
import { seekSequence } from './seek.ts'
import type { MatchKind } from './seek.ts'

/** One file's planned end state. */
export interface PlannedChange {
  /** Path as written in the patch. */
  readonly path: string
  /** Destination path: `moveTo` when the operation renames, else `path`. */
  readonly target: string
  /** Current content, or `null` when the operation creates the file. */
  readonly before: string | null
  /** Resulting content. */
  readonly after: string
  /** Whether the file is new, rewritten in place, or renamed. */
  readonly operation: 'create' | 'update' | 'move'
  /** How each hunk was located, in application order. */
  readonly matches: readonly HunkOutcome[]
}

/** How one hunk landed. */
export interface HunkOutcome {
  /** 0-based line the hunk matched at. */
  readonly index: number
  /** Which matching rung succeeded; anything but `exact` means leniency was used. */
  readonly match: MatchKind
  /** Lines the hunk removed. */
  readonly removed: number
  /** Lines the hunk added. */
  readonly added: number
}

/** The complete plan for a patch. */
export interface PatchPlan {
  /** Planned changes in declaration order. */
  readonly changes: readonly PlannedChange[]
}

/** A failure that prevents the whole patch from applying. */
export class PatchApplyError extends Error {
  /** Path the failure concerns. */
  readonly path: string

  constructor(message: string, path: string) {
    super(message)
    this.name = 'PatchApplyError'
    this.path = path
  }
}

/** Read a file's text, or return `undefined` when it does not exist. */
export type ReadFile = (path: string) => string | undefined

/**
 * Resolve every operation in a patch into a planned end state.
 *
 * @param patch - A parsed patch.
 * @param read - Reads current content; must return `undefined` for a missing file.
 * @returns The complete plan.
 * @throws {PatchApplyError} When any operation cannot be applied. No partial plan is returned.
 */
export function planPatch(patch: Patch, read: ReadFile): PatchPlan {
  const changes: PlannedChange[] = []
  const written = new Set<string>()

  for (const op of patch.ops) {
    // Two operations may not target one path: the second would compute its
    // content from a state the first already replaced, which is invisible here
    // because nothing is written between them. Checked before planning so the
    // report names the duplication rather than a confusing match failure.
    if (op.kind !== 'add' && written.has(op.path)) {
      throw new PatchApplyError(`the patch writes ${op.path} more than once`, op.path)
    }
    const change = planOp(op, read, written)
    if (written.has(change.target)) {
      throw new PatchApplyError(`the patch writes ${change.target} more than once`, change.path)
    }
    written.add(change.target)
    if (change.operation === 'move') written.add(change.path)
    changes.push(change)
  }

  return { changes }
}

/** Resolve one operation. */
function planOp(op: FileOp, read: ReadFile, written: ReadonlySet<string>): PlannedChange {
  if (op.kind === 'add') {
    const existing = read(op.path)
    // Refuse rather than overwrite. Codex's `*** Add File` silently replaces an
    // existing file; a create that quietly destroys content is never what the
    // model meant.
    if (existing !== undefined) {
      throw new PatchApplyError(`${op.path} already exists; patch it with an Update section instead`, op.path)
    }
    if (written.has(op.path)) {
      throw new PatchApplyError(`${op.path} is added twice in one patch`, op.path)
    }
    return {
      path: op.path,
      target: op.path,
      before: null,
      after: ensureTrailingNewline(op.lines),
      operation: 'create',
      matches: [],
    }
  }

  if (op.kind === 'delete') {
    // The harness `fs` service has no remove operation, so this tool cannot
    // express a deletion without bypassing the sandbox and version fence that
    // every other write goes through. Refuse and say what to do instead.
    throw new PatchApplyError(
      `this tool cannot delete ${op.path}: the harness filesystem service exposes no remove operation. `
      + 'Delete it with the bash tool instead (`rm -- <path>`), then continue editing.',
      op.path,
    )
  }

  const existing = read(op.path)
  if (existing === undefined) {
    throw new PatchApplyError(`${op.path} does not exist, so it cannot be updated`, op.path)
  }

  const endsWithNewline = existing.endsWith('\n')
  let lines = existing.split('\n')
  // A trailing newline shows up as a final empty element. That element is not a
  // real line, so hold it aside while hunks are applied and restore it after.
  if (endsWithNewline) lines = lines.slice(0, -1)

  const matches: HunkOutcome[] = []
  let cursor = 0

  for (const [position, hunk] of op.hunks.entries()) {
    const oldSide = hunk.lines.filter(line => line.kind !== '+').map(line => line.text)
    const newSide = hunk.lines.filter(line => line.kind !== '-').map(line => line.text)
    const where = hunk.header === undefined ? '' : ` (near "${hunk.header}")`

    if (oldSide.length === 0) {
      // A hunk with no context and no removed lines says what to insert but not
      // where. Codex resolves this by inserting at its running cursor, which
      // silently prepends to the file when the hunk is first. Refuse instead:
      // the model can say where it meant, and a wrong-guess insertion is far
      // more expensive to notice than a rejected patch.
      if (hunk.eof !== true) {
        throw new PatchApplyError(
          `hunk ${position + 1} of ${op.path}${where} inserts without any context to locate it. `
          + 'Quote the surrounding lines, or end the hunk with "*** End of File" to append.',
          op.path,
        )
      }
      lines = [...lines, ...newSide]
      matches.push({ index: lines.length - newSide.length, match: 'exact', removed: 0, added: newSide.length })
      cursor = lines.length
      continue
    }

    const found = seekSequence(lines, oldSide, cursor, hunk.eof === true)
    if (found.kind === 'missing') {
      throw new PatchApplyError(
        `hunk ${position + 1} of ${op.path}${where} does not match the file. `
        + 'Re-read the file and quote its current lines exactly, including surrounding context.',
        op.path,
      )
    }
    if (found.kind === 'ambiguous') {
      const shown = found.positions.slice(0, 5).map(index => index + 1).join(', ')
      const more = found.positions.length > 5 ? `, and ${found.positions.length - 5} more` : ''
      throw new PatchApplyError(
        `hunk ${position + 1} of ${op.path}${where} matches ${found.positions.length} places `
        + `(lines ${shown}${more}). Add surrounding context so the hunk identifies one location.`,
        op.path,
      )
    }

    matches.push({
      index: found.index,
      match: found.match,
      // Count the lines that actually changed, not whole hunks. Counting
      // context on both sides makes a one-line edit report "3 added, 3 removed",
      // which reads as a much larger change than it was.
      removed: hunk.lines.filter(line => line.kind === '-').length,
      added: hunk.lines.filter(line => line.kind === '+').length,
    })
    lines = [
      ...lines.slice(0, found.index),
      ...newSide,
      ...lines.slice(found.index + oldSide.length),
    ]
    cursor = found.index + newSide.length
  }

  const target = op.moveTo ?? op.path
  if (op.moveTo !== undefined) {
    // A rename needs the source removed, and the harness `fs` service exposes no
    // remove operation. Writing the destination alone would leave the source in
    // place — a silent copy where the model asked for a move, which is exactly
    // the class of quiet wrong answer this tool exists to avoid.
    throw new PatchApplyError(
      `this tool cannot move ${op.path} to ${op.moveTo}: the harness filesystem service exposes `
      + 'no remove operation, so a rename would leave the original behind. '
      + `Move it with the bash tool instead (\`mv -- ${op.path} ${op.moveTo}\`), then patch it.`,
      op.path,
    )
  }

  return {
    path: op.path,
    target,
    before: existing,
    after: lines.join('\n') + (endsWithNewline ? '\n' : ''),
    operation: 'update',
    matches,
  }
}

/** Join added lines, always terminating the final line. */
function ensureTrailingNewline(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`
}
