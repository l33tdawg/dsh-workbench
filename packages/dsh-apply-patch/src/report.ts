/**
 * Model-facing text and presentation diffs for an applied patch.
 *
 * These helpers are pure and hold no harness dependency, so the wording the
 * model reads and the diff the client renders are both covered by ordinary
 * tests rather than only observable from a running harness.
 *
 * @module @l33tdawg/dsh-apply-patch/report
 */

import type { PlannedChange } from './apply.ts'

/** A diff entry as the client's diff card expects it. */
export interface DiffEntry {
  /** Path the diff applies to. */
  readonly path: string
  /** Previous content, or `null` when the file is new. */
  readonly oldText: string | null
  /** Resulting content. */
  readonly newText: string
}

/** Past this many characters, a change is shown as a whole-file diff instead of a line diff. */
const WHOLE_FILE_THRESHOLD = 16_000

/** Count the lines an added body contributes. */
function bodyLines(content: string): number {
  if (content.length === 0) return 0
  const lines = content.split('\n')
  return content.endsWith('\n') ? lines.length - 1 : lines.length
}

/**
 * Describe one applied change as a single line.
 * @param change - one planned change.
 * @returns the summary line.
 */
export function describeChange(change: PlannedChange): string {
  const verb = change.operation === 'create'
    ? 'Created'
    : change.operation === 'move' ? 'Moved' : 'Updated'
  const destination = change.operation === 'move' ? ` -> ${change.target}` : ''
  const counts = change.operation === 'create'
    ? `${bodyLines(change.after)} lines`
    : `${change.matches.reduce((total, match) => total + match.added, 0)} added, `
      + `${change.matches.reduce((total, match) => total + match.removed, 0)} removed`
  return `${verb} ${change.path}${destination} (${counts})`
}

/**
 * Render the tool result the model reads.
 *
 * A hunk that only matched under a lenient rung is called out explicitly: the
 * patch applied, but "applied" is not the same as "applied where you meant", and
 * the model is the only actor that can check that.
 *
 * @param changes - the applied changes, in patch order.
 * @returns the result text.
 */
export function formatApplyOutput(changes: readonly PlannedChange[]): string {
  const lines = changes.map(describeChange)
  const lenient = changes.flatMap(change =>
    change.matches
      .filter(match => match.match !== 'exact')
      .map(match => `${change.path}:${match.index + 1} matched with ${match.match} tolerance`))
  if (lenient.length > 0) {
    lines.push('', `Note: ${lenient.join('; ')}. Confirm the edit landed where you intended.`)
  }
  return lines.join('\n')
}

/**
 * Build the diff entries for one change.
 *
 * A created file has no previous content. For an update, a very large file is
 * shown whole rather than as a line diff, because the client computes the line
 * diff itself and a multi-megabyte pair would stall it.
 *
 * @param change - one applied change.
 * @returns the diff entries to render.
 */
export function changeDiffs(change: PlannedChange): DiffEntry[] {
  if (change.operation === 'create') {
    return [{ path: change.target, oldText: null, newText: change.after }]
  }
  const before = change.before ?? ''
  if (before.length + change.after.length > WHOLE_FILE_THRESHOLD) {
    return [{ path: change.target, oldText: null, newText: change.after }]
  }
  return [{ path: change.target, oldText: before, newText: change.after }]
}

/**
 * Title the diff card for a whole patch.
 * @param changes - the applied changes.
 * @returns the card title.
 */
export function patchTitle(changes: readonly PlannedChange[]): string {
  if (changes.length === 1) return `Patch ${changes[0].target}`
  return `Patch ${changes.length} files`
}
