/**
 * Remember an approved command prefix, so the same command is not asked about
 * again.
 *
 * The harness grants one decision per request: `ApprovalOutcome` has
 * `allowed-once` and nothing else, and the request itself carries no tool
 * arguments. This plugin supplies both halves of what that leaves out. It
 * answers the `approval/request` waterfall from a rules file of command
 * prefixes, and it reads the pending call's arguments from the session log to
 * decide whether a rule covers it.
 *
 * Three properties make that safe enough to run by default:
 *
 * - **Rules are not where the session can write them.** The file lives under
 *   `~/.dsh`, outside any session workspace, because a rule file inside the
 *   workspace would be a grant the agent could give itself. The profile patch
 *   layer - equally out of reach - can carry inline rules as an alternative.
 * - **A rule covers exactly the command it names.** Shell operators refuse the
 *   match outright, so a prefix cannot be extended into a second command; see
 *   `rules.ts` for the reasoning.
 * - **A rule never weakens `never`.** The service enforces the deterministic
 *   rejection before dispatch, so this listener is not consulted at all under
 *   that policy; it can only answer where a human would otherwise be asked.
 *
 * Every decision it makes is appended to a log file as one JSON line, because
 * `ctx.logger` has no sink in any shipped profile and an auto-approval that
 * leaves no trace is worse than the prompt it replaced.
 *
 * The listener is registered with `prepend`, so it is consulted before the
 * deployment's own answerer (in Desktop, the remote bridge that shows the
 * approval dialog). When no rule matches it calls `next()`, so everything it
 * does not own behaves exactly as it did before it was installed.
 *
 * @module @l33tdawg/dsh-approval-memory
 */

import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { commandFrom, matchRule, parseRules } from './rules.ts'
import type { Rule } from './rules.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'approval-memory'

/**
 * Services required before activation.
 *
 * `sessions` is where the pending call's arguments come from; without it this
 * plugin could match tool names but never commands, which is not a useful
 * degradation.
 */
export const inject = ['sessions']

/** Plugin configuration, as the bundle row declares it. */
export interface Config {
  enabled?: boolean
  /** Where the rules file lives. `~` expands to the home directory. */
  rulesFile?: string
  /** Where decisions are appended, one JSON line each. Empty string disables it. */
  logFile?: string
  /** Rules written in the profile patch layer, merged before the file's. */
  rules?: Rule[]
}

/** Configuration with every default applied. */
export interface ResolvedConfig {
  enabled: boolean
  rulesFile: string
  logFile: string
  rules: Rule[]
}

/** The approval request fields this plugin reads. */
interface ApprovalRequestLike {
  agent: { id: string }
  toolName: string
  callId?: string
  signal?: AbortSignal
}

/** The subset of the sessions service this plugin uses. */
interface SessionsLike {
  get: (id: string) => SessionLike | undefined
}

/** The subset of a Session this plugin uses. */
interface SessionLike {
  ownEvents?: () => readonly EventLike[]
  snapshotEvents?: () => readonly EventLike[]
}

/** The subset of a session event this plugin reads. */
interface EventLike {
  type: string
  data?: { callId?: string, arguments?: string }
}

/**
 * Apply defaults and reject a configuration that cannot work.
 * @param config - the row's config.
 * @returns the resolved configuration.
 * @throws when a path or an inline rule is unusable, so activation reports it.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const path = (value: string | undefined, fallback: string, field: string): string => {
    if (value === undefined) return fallback
    if (typeof value !== 'string') throw new Error(`approval-memory: ${field} must be a string`)
    if (value === '') return ''
    return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  }
  const home = join(homedir(), '.dsh')
  const inline = config.rules ?? []
  if (!Array.isArray(inline)) throw new Error('approval-memory: rules must be an array')
  return {
    enabled: config.enabled ?? true,
    rulesFile: path(config.rulesFile, join(home, 'approval-rules.json'), 'rulesFile'),
    logFile: path(config.logFile, join(home, 'approval-memory.log'), 'logFile'),
    rules: inline,
  }
}

/**
 * Register the answerer.
 * @param ctx - Cordis context carrying the sessions service.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const sessions = (ctx as unknown as { sessions?: SessionsLike }).sessions

  /** Rules read from disk, re-read whenever the file's size or mtime moves. */
  const cache: { key: string, rules: readonly Rule[] } = { key: '', rules: [] }

  /** Append one JSON line. Never throws: a log failure must not decide anything. */
  const write = (fields: Record<string, unknown>): void => {
    if (resolved.logFile === '') return
    try {
      appendFileSync(resolved.logFile, `${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`)
    } catch {
      // Deliberately swallowed; see the doc comment.
    }
  }

  /** The file's rules, or an empty list when it is absent or unusable. */
  const fileRules = (): readonly Rule[] => {
    if (resolved.rulesFile === '') return []
    let key: string
    try {
      const stat = statSync(resolved.rulesFile)
      key = `${stat.mtimeMs}:${stat.size}`
    } catch {
      cache.key = ''
      cache.rules = []
      return cache.rules
    }
    if (key === cache.key) return cache.rules
    try {
      const { rules, problems } = parseRules(readFileSync(resolved.rulesFile, 'utf8'))
      cache.key = key
      cache.rules = rules
      for (const problem of problems) write({ event: 'rule-problem', detail: problem })
    } catch (error) {
      cache.key = key
      cache.rules = []
      write({ event: 'rule-problem', detail: `unreadable: ${(error as Error).message}` })
    }
    return cache.rules
  }

  /** The command a pending call carries, read from the session log by call id. */
  const pendingCommand = (req: ApprovalRequestLike, field: string): string | undefined => {
    if (req.callId === undefined) return undefined
    const session = sessions?.get(req.agent.id)
    if (session === undefined) return undefined
    const events = session.ownEvents?.() ?? session.snapshotEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type !== 'tool/call') continue
      if (event.data?.callId !== req.callId) continue
      const args = event.data?.arguments
      return typeof args === 'string' ? commandFrom(args, field) : undefined
    }
    return undefined
  }

  ctx.on('approval/request', async (req: ApprovalRequestLike, next: () => Promise<string>) => {
    try {
      if (req.signal?.aborted === true) return await next()
      const rules = [...fileRules(), ...resolved.rules]
      if (rules.length === 0) return await next()

      // Rules may read different argument fields, and a field is part of what a
      // rule asserts: a prefix about `command` must not be matched against the
      // value of some other argument. So the rules are grouped by field and
      // each group is matched only against that field's value.
      const byField = new Map<string, Rule[]>()
      for (const rule of rules) {
        const field = rule.field ?? 'command'
        const bucket = byField.get(field) ?? []
        bucket.push(rule)
        byField.set(field, bucket)
      }
      for (const [field, bucket] of byField) {
        const command = pendingCommand(req, field)
        if (command === undefined) continue
        const rule = matchRule(bucket, req.toolName, command)
        if (rule === undefined) continue
        write({ event: 'allowed', tool: req.toolName, rule: rule.prefix, field, command, agent: req.agent.id })
        return 'allowed-once'
      }
      return await next()
    } catch (error) {
      write({ event: 'error', detail: (error as Error).message, tool: req.toolName })
      return await next()
    }
  }, { prepend: true })
}

export { matchRule, parseRules, commandFrom, operatorIn } from './rules.ts'
export type { Rule, RuleSet } from './rules.ts'
