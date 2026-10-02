/**
 * Run a project's own check after the agent edits a file, and say so when the
 * edit broke something.
 *
 * This is the difference between an agent that eventually notices a mistake and
 * one that gets told while the file is still open. Nothing here depends on the
 * model behaving well: the check runs because a file changed, and the result
 * comes back whether or not the model thought to look.
 *
 * Three properties keep it from becoming noise:
 *
 * - **Attribution.** Only diagnostics naming a file the agent edited this session
 *   are reported. A check already red for unrelated reasons stays out of the
 *   conversation, because an agent handed someone else's breakage will go fix it.
 * - **Advisory by default.** The edit succeeded, so its result stays a success and
 *   the check rides along as context for the next request. Blocking is available
 *   and off, since a multi-file refactor is legitimately red between steps.
 * - **Bounded.** One check per debounce window, a hard timeout, capped output, and
 *   any failure inside this plugin is swallowed rather than surfaced as a tool
 *   error. A verification plugin must never be why a tool call fails.
 *
 * @module @l33tdawg/dsh-verify-on-edit
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

import { detectCheck } from './detect.ts'
import type { CheckPlan } from './detect.ts'
import { parseDiagnostics, summarize } from './parse.ts'
import type { Diagnostic } from './parse.ts'
import { classifyCheck, formatReport, readProjectFile, relevantDiagnostics, resolveConfig, shouldCheck } from './report.ts'
import type { CheckRecord, CheckRun, Config } from './report.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'verify-on-edit'

/**
 * Services required before activation.
 *
 * `shell` runs the check, so it is genuinely required: without it this plugin
 * has nothing to check with and should not claim to be active. Cordis resolves
 * `ctx.<name>` only for injected services and throws on an undeclared read, so
 * omitting it stops activation rather than degrading quietly.
 */
export const inject = ['tools', 'shell']

/** Label for the injected context, so it never renders as a user prompt in derived history. */
const SOURCE: MessageSource = { kind: 'verify-on-edit' }

/**
 * Session event carrying one check outcome.
 *
 * This is the plugin's only durable trace. `ctx.logger` has no sink in a shipped
 * profile, so a warning about a check that could not run leaves nothing behind,
 * and the report the agent reads exists only when there was something to report.
 * Without this event the plugin's silence is unreadable: a session where every
 * check passed and a session where no check was ever detected look identical.
 */
export const CHECK_EVENT = 'verify-on-edit/check'

/** Per-session bookkeeping. */
interface SessionState {
  /** Paths this session has edited, as reported by the tools. */
  edited: Set<string>
  /** Timestamp of the last completed check. */
  lastRun: number
}

/** What this plugin needs from the shell service. */
interface ShellLike {
  resolve: (request: { command: string, workdir: string, timeoutMs: number }) => unknown
  execute: (spec: unknown) => Promise<{
    result: () => Promise<{
      exitCode: number | null
      stdout?: { text?: string } | undefined
      stderr?: { text?: string } | undefined
    }>
  }>
}

/**
 * Register the check hook.
 * @param ctx - Cordis context carrying the tool registry and shell service.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const shell = (ctx as unknown as { shell?: ShellLike }).shell
  const sessions = new WeakMap<object, SessionState>()
  const plans = new Map<string, CheckPlan>()

  /**
   * The check plan for a project root.
   *
   * A positive result is cached, because a project rarely changes how it wants
   * to be checked. A negative one is not: caching "no check here" would mean a
   * project that gains a `typecheck` script mid-session is never checked again,
   * and the common case for that is an agent adding the script itself. Detection
   * is six small file reads, and it runs at most once per debounce window.
   */
  const planFor = (root: string): CheckPlan | undefined => {
    const cached = plans.get(root)
    if (cached !== undefined) return cached
    const detected = detectCheck(relative => readProjectFile(root, relative), resolved.allowSlow)
    if (detected !== undefined) plans.set(root, detected)
    return detected
  }

  /** Run the check. Returns how it exited and what it printed, or `undefined` when it could not run. */
  const runCheck = async (plan: CheckPlan, root: string): Promise<CheckRun | undefined> => {
    if (shell === undefined) return undefined
    try {
      const spec = shell.resolve({ command: plan.command, workdir: root, timeoutMs: resolved.timeoutMs })
      const execution = await shell.execute(spec)
      const result = await execution.result()
      return {
        exitCode: result.exitCode,
        diagnostics: result.exitCode === 0
          ? []
          : parseDiagnostics(`${result.stdout?.text ?? ''}\n${result.stderr?.text ?? ''}`),
      }
    } catch (error) {
      ctx.logger.warn('verify-on-edit: the check could not run: %o', error)
      return undefined
    }
  }

  /**
   * Append one outcome to the session log.
   *
   * Best-effort by construction. This record is how the plugin explains itself
   * afterwards, and failing to write one must never become a reason a tool call
   * fails — that would trade an invisible silence for a visible break.
   */
  const record = (target: unknown, entry: CheckRecord): void => {
    try {
      const session = target as { append?: (type: string, data: unknown) => unknown } | undefined
      session?.append?.(CHECK_EVENT, entry)
    } catch (error) {
      ctx.logger.warn('verify-on-edit: the check outcome could not be recorded: %o', error)
    }
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    try {
      const agent = exec.agent
      const root = agent?.session.header.cwd ?? ''
      const gate = shouldCheck(
        {
          toolName: exec.name,
          args: exec.arguments,
          isError: result.isError,
          resultValue: result.isError ? undefined : result.value,
          hasAgent: agent !== undefined,
          root,
        },
        sessions.get(agent as object)?.lastRun ?? 0,
        resolved,
        Date.now(),
      )
      if (!gate.check) return downstream

      const state = sessions.get(agent as object) ?? { edited: new Set<string>(), lastRun: 0 }
      sessions.set(agent as object, state)
      for (const path of gate.paths) state.edited.add(path)

      const plan = planFor(root)
      if (plan === undefined) {
        record(agent?.session, classifyCheck(undefined, undefined, 0))
        return downstream
      }

      state.lastRun = Date.now()
      const ran = await runCheck(plan, root)
      if (ran === undefined) {
        record(agent?.session, classifyCheck(plan, undefined, 0))
        return downstream
      }

      const mine = relevantDiagnostics(ran.diagnostics, [...state.edited])
      record(agent?.session, classifyCheck(plan, ran, mine.length))
      if (mine.length === 0) return downstream

      const text = formatReport(plan, summarize(mine, resolved.maxPerFile))
      if (resolved.blocking) return { kind: 'block', feedback: [{ type: 'text', text }] }

      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { ...SOURCE, form: 'notice', summary: `${plan.label} failed after an edit` },
      })
      return { ...downstream, additionalContexts: [...(downstream.additionalContexts ?? []), message] }
    } catch (error) {
      ctx.logger.warn('verify-on-edit: hook error: %o', error)
      return downstream
    }
  })
}

export { detectCheck } from './detect.ts'
export type { CheckPlan } from './detect.ts'
export { parseDiagnostics } from './parse.ts'
export type { Diagnostic } from './parse.ts'
export { formatReport, relevantDiagnostics, resolveConfig, shouldCheck } from './report.ts'
export type { Config, GateInput } from './report.ts'
