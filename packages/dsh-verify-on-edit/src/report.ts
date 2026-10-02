/**
 * Configuration, path extraction, and the report the agent reads.
 *
 * Kept free of harness imports so the whole decision surface is unit-testable
 * without a running harness. `index.ts` owns only the wiring.
 *
 * @module @l33tdawg/dsh-verify-on-edit/report
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { CheckPlan } from './detect.ts'
import { concernsEditedFile, isError } from './parse.ts'
import type { Diagnostic } from './parse.ts'

/**
 * Filesystem tools whose success means a file on disk changed.
 *
 * `str_replace_editor` is listed because it ships as an opt-in alternative to
 * `edit`+`write`; a deployment mounts one family or the other, never both.
 */
export const MUTATING_TOOL_NAMES: readonly string[] = [
  'edit',
  'write',
  'apply_patch',
  'str_replace_editor',
]

/** Plugin configuration. */
export interface Config {
  /** Whether the check runs at all. */
  enabled?: boolean
  /** Hard limit for one check run. */
  timeoutMs?: number
  /** Minimum gap between checks, so a burst of edits triggers one run. */
  debounceMs?: number
  /** Whether `test`-class scripts may be selected. Off by default: slow, and often already red. */
  allowSlow?: boolean
  /** Whether a broken check turns the edit into an error result. Off by default. */
  blocking?: boolean
  /** Maximum diagnostics shown per file. */
  maxPerFile?: number
}

/** Resolved configuration with every default applied. */
export interface ResolvedConfig {
  enabled: boolean
  timeoutMs: number
  debounceMs: number
  allowSlow: boolean
  blocking: boolean
  maxPerFile: number
}

/**
 * Fill in defaults, and reject values that would make the plugin useless.
 *
 * A zero timeout would mean "unbounded" to the shell layer, which is the
 * opposite of what the field promises, so it is rejected rather than clamped.
 *
 * @param config - raw plugin configuration.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const positive = (value: number | undefined, fallback: number, field: string): number => {
    if (value === undefined) return fallback
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`verify-on-edit: ${field} must be a positive number`)
    }
    return value
  }
  return {
    enabled: config.enabled ?? true,
    timeoutMs: positive(config.timeoutMs, 60_000, 'timeoutMs'),
    debounceMs: positive(config.debounceMs, 3_000, 'debounceMs'),
    allowSlow: config.allowSlow ?? false,
    blocking: config.blocking ?? false,
    maxPerFile: positive(config.maxPerFile, 5, 'maxPerFile'),
  }
}

/**
 * Extract the file paths a completed tool call actually changed.
 *
 * The result's canonical `value` is the authoritative source: `edit` and `write`
 * report `{ path }`, `apply_patch` reports `{ files: [{ path, target }] }`. It
 * describes what the tool did rather than what it was asked to do, which matters
 * for a patch that moves a file or a call that fails after writing.
 *
 * The argument fallback exists for tools that report no structured value. It is
 * a fallback and not the primary path, because reading a patch out of its own
 * text is a guess where the tool already knows the answer.
 *
 * @param toolName - the tool that ran.
 * @param args - the call's arguments, used only when the value is unhelpful.
 * @param value - the result's canonical value, when the execution succeeded.
 * @returns the paths, or an empty list when none can be determined.
 */
export function editedPaths(toolName: string, args: unknown, value?: unknown): string[] {
  const fromValue = pathsFromValue(value)
  if (fromValue.length > 0) return fromValue

  if (typeof args !== 'object' || args === null) return []
  const record = args as Record<string, unknown>
  const patch = record.patch
  if (typeof patch === 'string') {
    const found: string[] = []
    for (const line of patch.split('\n')) {
      const section = /^\*\*\* (?:Add|Update|Delete) File:[ \t]*(.+?)[ \t]*$/.exec(line)
      if (section) found.push(section[1])
      const move = /^\*\*\* Move to:[ \t]*(.+?)[ \t]*$/.exec(line)
      if (move) found.push(move[1])
    }
    if (found.length > 0) return found
  }
  const direct = record.file_path ?? record.path
  if (typeof direct === 'string' && direct.length > 0) return [direct]
  return []
}

/** Read paths out of a tool's canonical result value. */
function pathsFromValue(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>

  // apply_patch: one entry per file, with `target` differing on a move.
  if (Array.isArray(record.files)) {
    const found: string[] = []
    for (const entry of record.files) {
      if (typeof entry !== 'object' || entry === null) continue
      const file = entry as Record<string, unknown>
      const path = file.target ?? file.path
      if (typeof path === 'string' && path.length > 0) found.push(path)
    }
    if (found.length > 0) return found
  }

  // edit, write, str_replace_editor.
  if (typeof record.path === 'string' && record.path.length > 0) return [record.path]
  return []
}

/**
 * Resolve a path against the session workspace.
 * @param path - absolute or workspace-relative path.
 * @param root - the session's working directory.
 * @returns the absolute path.
 */
export function resolveAgainst(path: string, root: string): string {
  return isAbsolute(path) ? path : join(root, path)
}

/**
 * Read a project file for detection, or `undefined` when absent.
 *
 * Deliberately plain filesystem access rather than `ctx.fs`: these are harness
 * reads of small config files, not model-facing operations, and a workspace that
 * is not present locally should make detection return nothing rather than throw.
 *
 * @param root - the project root.
 * @param relative - the file to read.
 * @returns the file's text, or `undefined`.
 */
export function readProjectFile(root: string, relative: string): string | undefined {
  const path = join(root, relative)
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/** One file's diagnostics, already capped. */
export interface ReportGroup {
  file: string
  items: Diagnostic[]
  omitted: number
}

/** Why a tool call did or did not trigger a check. */
export interface CheckGate {
  /** Whether to run the check now. */
  readonly check: boolean
  /** The paths this call touched, already resolved against the workspace root. */
  readonly paths: string[]
  /** A short explanation, for tests and for logging a skipped call. */
  readonly reason: string
}

/** What the hook knows about the completed call. */
export interface GateInput {
  /** The tool that ran. */
  readonly toolName: string
  /** The call's arguments. */
  readonly args: unknown
  /** Whether the tool result was an error. */
  readonly isError: boolean
  /** The result's canonical value, the authoritative record of what changed. */
  readonly resultValue?: unknown
  /** Whether the call belongs to an agent (a direct `ctx.tools.execute()` has none). */
  readonly hasAgent: boolean
  /** The session workspace root. */
  readonly root: string
}

/**
 * Decide whether a completed tool call should trigger a check.
 *
 * Pure, so the debounce and filtering rules can be tested directly rather than
 * inferred from a fake shell. Every early return names itself, because "the
 * check silently stopped running" is the failure mode that would make this
 * plugin useless without anyone noticing.
 *
 * @param input - what the hook observed.
 * @param lastRun - timestamp of the previous check, or 0.
 * @param config - resolved configuration.
 * @param now - current timestamp.
 * @returns the gate decision and the resolved paths.
 */
export function shouldCheck(
  input: GateInput,
  lastRun: number,
  config: ResolvedConfig,
  now: number,
): CheckGate {
  if (!config.enabled) return { check: false, paths: [], reason: 'disabled' }
  if (input.isError) return { check: false, paths: [], reason: 'the tool call failed' }
  if (!input.hasAgent) return { check: false, paths: [], reason: 'no agent' }
  if (!MUTATING_TOOL_NAMES.includes(input.toolName)) {
    return { check: false, paths: [], reason: `${input.toolName} does not modify files` }
  }
  const paths = editedPaths(input.toolName, input.args, input.resultValue)
    .map(path => resolveAgainst(path, input.root))
  if (paths.length === 0) return { check: false, paths: [], reason: 'the call named no file' }
  if (now - lastRun < config.debounceMs) {
    return { check: false, paths, reason: 'within the debounce window' }
  }
  return { check: true, paths, reason: 'a file changed' }
}

/**
 * Filter a check's output down to what the agent is responsible for.
 *
 * Errors only, and only in files this session edited. Warnings are excluded
 * because they are usually pre-existing, and unrelated files are excluded
 * because an agent handed someone else's breakage will go and fix it.
 *
 * @param diagnostics - every parsed diagnostic from the run.
 * @param edited - paths this session has edited.
 * @returns the diagnostics worth reporting.
 */
export function relevantDiagnostics(
  diagnostics: readonly Diagnostic[],
  edited: readonly string[],
): Diagnostic[] {
  return diagnostics.filter(diagnostic => isError(diagnostic) && concernsEditedFile(diagnostic, edited))
}

/**
 * What one check attempt did.
 *
 * Silence used to be the only record, and it was ambiguous. The plugin says
 * nothing when the check passes, when no check was detected, and when the check
 * could not run at all, so a session log could not distinguish "the edit was
 * clean" from "this plugin never engaged here" — and a count of reports could
 * not be turned into a rate. Naming each case is what makes the silence
 * readable after the fact.
 */
export type CheckOutcome =
  /** The check ran and passed. */
  | 'clean'
  /** The check ran and failed, but named no file this session edited. */
  | 'unrelated'
  /** The check ran, failed, and named at least one edited file. */
  | 'failed'
  /** The check ran and failed, and printed nothing that parsed as a diagnostic. */
  | 'unparsed'
  /** No check could be detected for this project. */
  | 'no-check'
  /** The check could not be started, or started and did not exit normally. */
  | 'unrunnable'

/** One bounded record of a check attempt, written to the session log. */
export interface CheckRecord {
  /** What happened. */
  readonly outcome: CheckOutcome
  /** The check's own label, absent when none was detected. */
  readonly label?: string
  /** How many diagnostics named a file this session edited. */
  readonly reported?: number
}

/** How a completed check process exited, and what it printed. */
export interface CheckRun {
  /** The exit code, or `null` when the process did not exit normally. */
  readonly exitCode: number | null
  /** Everything the run printed that parsed as a diagnostic. */
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Classify one check attempt.
 *
 * Pure, so every branch is testable without a shell. The order matters twice
 * over: a check that exited zero is clean whatever it printed, and a check that
 * failed while printing nothing parsable is `unparsed` rather than `clean`,
 * because reporting a broken check as a passing one is the worst answer this
 * function could give.
 *
 * @param plan - the detected check, or `undefined` when none was found.
 * @param ran - the completed run, or `undefined` when it could not be run.
 * @param reported - diagnostics attributed to a file this session edited.
 * @returns the record to append to the session log.
 */
export function classifyCheck(
  plan: CheckPlan | undefined,
  ran: CheckRun | undefined,
  reported: number,
): CheckRecord {
  if (plan === undefined) return { outcome: 'no-check' }
  if (ran === undefined || ran.exitCode === null) return { outcome: 'unrunnable', label: plan.label }
  if (ran.exitCode === 0) return { outcome: 'clean', label: plan.label, reported: 0 }
  if (ran.diagnostics.length === 0) return { outcome: 'unparsed', label: plan.label, reported: 0 }
  if (reported === 0) return { outcome: 'unrelated', label: plan.label, reported: 0 }
  return { outcome: 'failed', label: plan.label, reported }
}

/**
 * Render the context message the agent reads after a broken check.
 *
 * The closing instruction is not decoration. An agent handed a list of compiler
 * errors will try to fix all of them, including the ones that predate its
 * change, and that is worse than saying nothing.
 *
 * @param plan - the check that ran.
 * @param groups - grouped, capped diagnostics.
 * @returns the message text.
 */
export function formatReport(plan: CheckPlan, groups: readonly ReportGroup[]): string {
  const total = groups.reduce((sum, group) => sum + group.items.length + group.omitted, 0)
  const plural = total === 1 ? '' : 's'
  const lines = [
    `[verify-on-edit] ${plan.label} fails on ${total} problem${plural} in `
    + `${groups.length === 1 ? 'a file' : 'files'} you edited.`,
    '',
  ]
  for (const group of groups) {
    for (const item of group.items) {
      const at = item.line === undefined ? '' : `:${item.line}`
      lines.push(`  ${group.file}${at}  ${item.message}`)
    }
    if (group.omitted > 0) lines.push(`  ${group.file}  ... and ${group.omitted} more`)
  }
  lines.push(
    '',
    'Fix these before moving on, or say why they are expected. Leave failures in files you have '
    + 'not edited alone: they predate your change.',
  )
  return lines.join('\n')
}
