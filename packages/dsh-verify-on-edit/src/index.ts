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
import { formatReport, readProjectFile, relevantDiagnostics, resolveConfig, shouldCheck } from './report.ts'
import type { Config } from './report.ts'

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
  const plans = new Map<string, CheckPlan | undefined>()

  /** Cached check plan for a project root; detection reads config files once. */
  const planFor = (root: string): CheckPlan | undefined => {
    if (!plans.has(root)) {
      plans.set(root, detectCheck(relative => readProjectFile(root, relative), resolved.allowSlow))
    }
    return plans.get(root)
  }

  /** Run the check. Returns its diagnostics, or `undefined` when it could not run. */
  const runCheck = async (plan: CheckPlan, root: string): Promise<Diagnostic[] | undefined> => {
    if (shell === undefined) return undefined
    try {
      const spec = shell.resolve({ command: plan.command, workdir: root, timeoutMs: resolved.timeoutMs })
      const execution = await shell.execute(spec)
      const result = await execution.result()
      if (result.exitCode === 0) return []
      return parseDiagnostics(`${result.stdout?.text ?? ''}\n${result.stderr?.text ?? ''}`)
    } catch (error) {
      ctx.logger.warn('verify-on-edit: the check could not run: %o', error)
      return undefined
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
      if (plan === undefined) return downstream

      state.lastRun = Date.now()
      const diagnostics = await runCheck(plan, root)
      if (diagnostics === undefined) return downstream

      const mine = relevantDiagnostics(diagnostics, [...state.edited])
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
