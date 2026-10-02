/**
 * Configuration, result-shape reading, and the bounded rendering that turns a
 * tool's before/after pair into the text the model reads.
 *
 * Nothing here imports the harness, so every decision below is unit-testable
 * without booting one. The shapes it reads are the ones the tools declare in
 * their own output schemas; an unrecognized value yields no feedback rather than
 * a guess.
 *
 * @module @l33tdawg/dsh-edit-feedback/report
 */

import { diffLines, hunkHeader } from './diff.ts'
import type { DiffResult, Hunk } from './diff.ts'

/** Plugin configuration as written in the loader row. */
export interface Config {
  /** Whether the feedback is attached at all. */
  enabled?: boolean
  /** Tools whose results are enriched. */
  tools?: string[]
  /** Unchanged lines kept either side of a change. */
  context?: number
  /** Most hunks shown before the rest are counted and dropped. */
  maxHunks?: number
  /** Most lines emitted in the whole block, hunk headers included. */
  maxLines?: number
  /** Longest line echoed before it is clipped. */
  maxLineLength?: number
}

/** Configuration with every default applied. */
export interface ResolvedConfig {
  enabled: boolean
  tools: readonly string[]
  context: number
  maxHunks: number
  maxLines: number
  maxLineLength: number
}

/**
 * Tools whose results carry a diffable before/after pair.
 *
 * `str_replace_editor` is deliberately absent: its result is a single string, so
 * there is nothing to diff against and a guess would be worse than silence.
 */
export const DEFAULT_TOOLS: readonly string[] = ['edit', 'write', 'apply_patch']

/** Defaults, exported so the cordis row and the tests agree on one source. */
export const DEFAULTS: ResolvedConfig = {
  enabled: true,
  tools: DEFAULT_TOOLS,
  context: 2,
  maxHunks: 6,
  maxLines: 60,
  maxLineLength: 400,
}

/**
 * Apply defaults to a plugin configuration.
 * @param config - the loader row's config.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    enabled: config.enabled ?? DEFAULTS.enabled,
    tools: config.tools ?? DEFAULTS.tools,
    context: Math.max(0, config.context ?? DEFAULTS.context),
    maxHunks: Math.max(1, config.maxHunks ?? DEFAULTS.maxHunks),
    maxLines: Math.max(1, config.maxLines ?? DEFAULTS.maxLines),
    maxLineLength: Math.max(20, config.maxLineLength ?? DEFAULTS.maxLineLength),
  }
}

/** One file's before and after content, as a tool reported it. */
export interface Change {
  readonly path: string
  readonly before: string
  readonly after: string
}

/** Whether a value is a plain object, read structurally. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the before/after pairs out of a tool result value.
 *
 * Two shapes are recognized, both taken from the tools' own output schemas:
 * `edit` and `write` return `{ path, before, after }` for one file, and
 * `apply_patch` returns `{ files: [...] }` where each entry carries a `target`
 * and the same pair.
 *
 * A change with no `before` is a creation. There is nothing to compare it
 * against and the model just supplied the content, so it is dropped: echoing a
 * new file back would spend context to repeat what the model already wrote.
 *
 * @param toolName - the tool that produced the value.
 * @param value - the tool result's structured value.
 * @param tools - the tool names this plugin enriches.
 * @returns the diffable changes, in the order the tool reported them.
 */
export function changesFrom(toolName: string, value: unknown, tools: readonly string[]): Change[] {
  if (!tools.includes(toolName) || !isRecord(value)) return []

  if (toolName === 'apply_patch') {
    const files = value.files
    if (!Array.isArray(files)) return []
    const changes: Change[] = []
    for (const file of files) {
      if (!isRecord(file)) continue
      const path = typeof file.target === 'string'
        ? file.target
        : typeof file.path === 'string' ? file.path : undefined
      if (path === undefined || typeof file.before !== 'string' || typeof file.after !== 'string') continue
      changes.push({ path, before: file.before, after: file.after })
    }
    return changes
  }

  if (typeof value.path !== 'string' || typeof value.before !== 'string' || typeof value.after !== 'string') {
    return []
  }
  return [{ path: value.path, before: value.before, after: value.after }]
}

/** One change paired with the diff computed for it. */
interface Entry {
  readonly path: string
  readonly diff: DiffResult
}

/**
 * Clip a line to the configured width.
 * @param text - the source line.
 * @param width - the longest line echoed.
 * @returns the line, marked when it was cut.
 */
function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width)}  ... [${text.length - width} more characters]`
}

/**
 * Render the changes as bounded unified-diff text.
 *
 * The output never names a `read` call. The whole point of showing the model
 * where its edit landed is to remove the reason it re-reads the file, and a
 * truncation footer that says "read the rest" would reinstate exactly that.
 *
 * @param changes - the diffable changes, in tool order.
 * @param config - the resolved configuration.
 * @returns the feedback text, or `undefined` when nothing changed.
 */
export function formatFeedback(changes: readonly Change[], config: ResolvedConfig): string | undefined {
  const entries: Entry[] = []
  for (const change of changes) {
    const diff = diffLines(change.before, change.after, config.context)
    if (diff.kind === 'same') continue
    entries.push({ path: change.path, diff })
  }
  if (entries.length === 0) return undefined

  const multi = new Set(entries.map(entry => entry.path)).size > 1
  const out: string[] = []
  let budget = config.maxLines
  let hunksShown = 0
  let hunksOmitted = 0
  let linesOmitted = 0

  for (const entry of entries) {
    if (entry.diff.kind === 'too-large') {
      const summary = `--- ${entry.path}: rewritten, ${entry.diff.beforeLines} lines before and `
        + `${entry.diff.afterLines} after; too large to show here`
      if (budget > 0) {
        out.push(summary)
        budget--
      } else {
        linesOmitted++
      }
      continue
    }
    if (entry.diff.kind !== 'hunks') continue

    let headed = false
    for (const hunk of entry.diff.hunks) {
      // A hunk needs its header plus at least one line to say anything, and the
      // hunk cap is a separate budget from the line cap.
      if (budget < 2 || hunksShown >= config.maxHunks) {
        hunksOmitted++
        linesOmitted += hunk.lines.length
        continue
      }
      if (multi && !headed) {
        out.push(`--- ${entry.path}`)
        headed = true
      }
      out.push(hunkHeader(hunk))
      budget--
      hunksShown++
      let shown = 0
      for (const line of hunk.lines) {
        if (budget <= 0) break
        out.push(`${line.kind}${clip(line.text, config.maxLineLength)}`)
        budget--
        shown++
      }
      if (shown < hunk.lines.length) linesOmitted += hunk.lines.length - shown
    }
  }

  const missing: string[] = []
  if (hunksOmitted > 0) missing.push(`${hunksOmitted} more hunk${hunksOmitted === 1 ? '' : 's'}`)
  if (linesOmitted > 0) missing.push(`${linesOmitted} more changed line${linesOmitted === 1 ? '' : 's'}`)
  if (missing.length > 0) out.push(`... ${missing.join(' and ')} not shown`)

  return out.length > 0 ? out.join('\n') : undefined
}

export type { Hunk }
