/**
 * The text an agent reads when no check runs.
 *
 * These notices used to be one sentence that said "nothing is configured or
 * detected", which reads as a statement about the project. It was really a
 * statement about the search, and the two come apart exactly when it matters: a
 * tree with 704 passing tests received a sentence implying it had no checks at
 * all. Naming what was examined makes the notice falsifiable, and naming a
 * check that was found but withheld makes it actionable.
 *
 * Kept free of harness imports so the wording is unit-testable.
 *
 * @module @l33tdawg/dsh-verify-on-edit/message
 */

import { DETECTION_PATHS } from './detect.ts'
import type { Detection } from './detect.ts'

/**
 * Format the `no-check` notice.
 *
 * @param detection - what the detection pass examined, when it was recorded.
 * @returns the notice text, without the plugin's own prefix.
 */
export function formatNoCheck(detection?: Detection): string {
  if (detection === undefined) {
    return 'No project check is configured or detected; these edits remain unverified.'
  }
  const searched = `Searched the session workspace for ${DETECTION_PATHS.join(', ')}, and for a Python environment at .venv or ../.venv.`
  const skipped = detection.skipped
  if (skipped !== undefined) {
    return `${searched} A ${skipped.label} check was available but not run, because slow checks are disabled; `
      + 'these edits remain unverified. Enable `allowSlow`, or name the command with `command`, to run it.'
  }
  return `${searched} None was found, so no check could be selected and these edits remain unverified. `
    + 'A check outside these names is not detected; name it with `command` to run it.'
}
