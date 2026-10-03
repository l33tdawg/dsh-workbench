/** A single, durable final-check reminder at Harness's normal stop boundary. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { VerificationOutcome } from './report.ts'
import { currentTurnEvents } from './session.ts'
import type { SessionLog } from './session.ts'

export const COMPLETION_SOURCE_KIND = 'completion-guard'

/** Source metadata survives plugin reload because steer writes the ordinary inbox log. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'completion-guard': {
      kind: 'completion-guard'
      form: 'notice'
      summary: string
      turn: number
      attempt: 1
    }
  }
}

export interface CompletionOptions {
  flush(agent: Agent, signal: AbortSignal): Promise<VerificationOutcome | undefined>
  /** Disable this whole hook, including the final flush; not just the retry. */
  enabled?: boolean
}

type RecordValue = Record<string, any>
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' ? value as RecordValue : undefined

/** Text is evidence to quote, never instructions supplied by this plugin. */
function textOf(message: unknown): string {
  const content = record(message)?.content
  return Array.isArray(content)
    ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
    : ''
}

/** Conservative opt-out for express limits in a real human message. */
export function limitsContinuation(text: string): boolean {
  return /(?:^|[.!?\n]\s*)(?:(?:hey|bro)[,\s]+)?(?:please\s+)?(?:stop|pause|hold off|wait|end here|leave it here)\b/i.test(text)
    || /\b(?:do not|don't|don’t)\s+(?:continue|proceed|run|execute|edit|change|implement)\b/i.test(text)
    || /\b(?:just|only)\s+(?:report|explain|summari[sz]e|review|assess|answer|tell me|give me (?:the )?status)\b/i.test(text)
    || /\b(?:report|status|analysis|review)[ -]only\b/i.test(text)
    || /\b(?:no more than|at most|maximum(?: of)?|limit(?:ed)? to|stop after)\s+\d+\b/i.test(text)
    || /\b(?:budget(?: of)?|within|up to|only|you have|spend)\s+(?:\d+|one|two|three|five|ten)\s+(?:attempts?|tries|minutes?|seconds?|tokens?|steps?)\b/i.test(text)
    || /\b(?:let['’]s|we should|we can)\s+(?:stop|pause)\b/i.test(text)
}

/** Explicit check restrictions apply to edit hooks as well as final flushes. */
const CHECK_ACTION = '(?:tests?|testing|checks?|checking|verification|verify|typechecks?|typechecking|lint(?:ing|ers?)?|commands?)'
const CHECK_QUALIFIER = '(?:(?:any|the|all|automatic|automated|project|further|more|additional|new)\\s+)*'
const NO_CHECK_PATTERNS = [
  new RegExp(`\\b(?:do not|don't|don’t|never)\\s+(?:(?:run|execute|perform|start|trigger)\\s+${CHECK_QUALIFIER}(?:${CHECK_ACTION}|anything|npm|pnpm|yarn|bun|go|cargo|pytest|make)|test|verify|typecheck|lint)\\b`, 'i'),
  new RegExp(`\\b(?:skip|avoid)\\s+(?:running\\s+)?${CHECK_QUALIFIER}${CHECK_ACTION}\\b`, 'i'),
  new RegExp(`\\bno\\s+${CHECK_QUALIFIER}${CHECK_ACTION}\\b(?!\\s+(?:failed|passed|ran|were|are|have|had|exist|remain|found|reported)\\b)`, 'i'),
  new RegExp(`\\bwithout\\s+(?:(?:running|executing)\\s+)?${CHECK_QUALIFIER}${CHECK_ACTION}\\b`, 'i'),
]
const ALLOW_CHECK_PATTERN = new RegExp(`\\b(?:do not|don't|don’t|never)\\s+(?:skip|avoid)\\s+(?:running\\s+)?${CHECK_QUALIFIER}${CHECK_ACTION}\\b|\\b(?:run|execute|perform|start)\\s+${CHECK_QUALIFIER}${CHECK_ACTION}\\b|\\b(?:you can|you may|please)\\s+(?:test|verify|typecheck|lint)\\b`, 'i')

/** Match explicit prohibitions without inverting "do not skip tests". */
function checkDenials(text: string): RegExpMatchArray[] {
  return NO_CHECK_PATTERNS.flatMap(pattern => [...text.matchAll(new RegExp(pattern.source, 'gi'))])
    .filter(match => !/^(?:skip|avoid)\b/i.test(match[0])
      || !/\b(?:do not|don't|don’t|never)\s+$/i.test(text.slice(0, match.index)))
}

/** Verification-only restrictions are tracked separately so a later human can lift them. */
function withoutCheckDenials(text: string): string {
  for (const match of checkDenials(text).sort((a, b) => b.index! - a.index!)) {
    text = text.slice(0, match.index) + text.slice(match.index! + match[0].length)
  }
  return text
}

/**
 * Read actual human messages in this turn, never model/tool/plugin prose.
 * A later explicit request to run checks replaces an earlier prohibition;
 * ambiguous messages do not silently grant permission. Pending steering counts
 * immediately, before it has been copied from the inbox to the model surface.
 */
export function verificationRestricted(agent: unknown): boolean {
  const value = record(agent)
  if (!value?.session) return false
  const messages = currentTurnEvents(value.session as SessionLog).events
    .filter(event => event.type === 'user/message').map(event => event.data)
  if (Array.isArray(value.inbox?.nextStep)) messages.push(...value.inbox.nextStep)
  let restricted = false
  for (const message of messages) {
    if (message?.source?.kind !== 'user') continue
    const text = textOf(message)
    if (checkDenials(text).length) restricted = true
    else if (ALLOW_CHECK_PATTERN.test(text)) restricted = false
  }
  return restricted
}

/** Avoid a redundant retry when the final answer already explains the gap. */
function reportsBlocker(text: string): boolean {
  return /\b(?:blocked|awaiting (?:your |user )?(?:approval|permission|input)|waiting for (?:your |user )?(?:approval|permission|input)|need (?:your |user )?(?:approval|permission))\b/i.test(text)
    || /\b(?:cannot|can't|could not|couldn't|unable to)\s+(?:run|verify|test|check|continue|proceed)\b/i.test(text)
    || /\b(?:not (?:run|verified|tested)|unverified|verification (?:gap|unavailable)|(?:check|tests?|verification) (?:failed|timed out))\b/i.test(text)
}

interface Boundary {
  normal: boolean
  used: boolean
  restricted: boolean
  reported: boolean
  unresolved: string[]
}

function hasMarker(message: unknown, turn: number): boolean {
  const source = record(record(message)?.source)
  return source?.kind === COMPLETION_SOURCE_KIND && source.turn === turn && source.attempt === 1
}

/**
 * Use only this turn's canonical events. There is no reason field on
 * turn-stopping: max-token stops and concluding tools call that hook too.
 * Require an ordinary final assistant response, and decline uncertain cases.
 */
function boundary(agent: Agent, turn: number): Boundary {
  const result: Boundary = { normal: false, used: false, restricted: false, reported: false, unresolved: [] }
  const session = agent.session
  // Current hosts expose eventAt; older installed Harness builds expose events.
  const legacyEvents = typeof session?.eventAt === 'function' ? undefined : (session as unknown as { events?: unknown[] })?.events
  const eventAt = typeof session?.eventAt === 'function'
    ? (index: number) => session.eventAt(index)
    : Array.isArray(legacyEvents) ? (index: number) => legacyEvents[index] : undefined
  const count = Number.isSafeInteger(session?.seq) ? session.seq : legacyEvents?.length
  if (eventAt === undefined || count === undefined || !Number.isSafeInteger(count)) return result
  const events: RecordValue[] = []
  let found = false
  for (let index = count - 1; index >= 0; index--) {
    const event = record(eventAt(index))
    if (!event) continue
    if (event.type === 'turn/end') return result
    if (event.type === 'turn/start') {
      found = event.data?.turn === turn
      break
    }
    events.push(event)
  }
  if (!found) return result
  events.reverse()
  let lastAssistant: RecordValue | undefined
  let latestTodos: unknown
  const approvals = new Map<string, string>()
  let limited = false
  for (const event of events) {
    const data = record(event.data)
    if (!data) continue
    if (event.type === 'todo/write') latestTodos = data.todos
    if (event.type === 'user/message') {
      result.used ||= hasMarker(data, turn)
      if (data.source?.kind === 'user') result.restricted ||= limitsContinuation(withoutCheckDenials(textOf(data)))
    }
    if (event.type === 'agent/inbox/spliced' && Array.isArray(data.inserted)) {
      result.used ||= data.inserted.some(message => hasMarker(message, turn))
    }
    if (event.type === 'approval/asked' && typeof data.id === 'string') approvals.set(data.id, 'pending')
    if (event.type === 'approval/decided' && typeof data.id === 'string') approvals.set(data.id, data.outcome)
    if (event.type === 'goal/change' && ['pause', 'block', 'clear', 'complete'].includes(data.operation)) result.restricted = true
    if (event.type === 'assistant/chunk' && data.chunk?.type === 'finish' && data.chunk.reason?.kind !== 'stop' && data.chunk.reason?.kind !== 'tool-calls') limited = true
    if (event.type === 'assistant/message') {
      lastAssistant = data
      if (data.interrupted === true) limited = true
      if (Array.isArray(data.stream)) {
        for (const item of data.stream) {
          if (item?.type === 'chunk' && item.chunk?.type === 'finish'
            && item.chunk.reason?.kind !== 'stop' && item.chunk.reason?.kind !== 'tool-calls') limited = true
        }
      }
    }
  }
  const content = lastAssistant?.message?.content
  // A tool can conclude a turn intentionally. Its pending/approval semantics
  // belong to the tool; a todo or failed check cannot override that boundary.
  result.normal = !limited && lastAssistant?.turn === turn && Array.isArray(content) && !content.some(block => block?.type === 'tool-call')
  result.restricted ||= [...approvals.values()].some(outcome => outcome !== 'allowed-once')
  const finalText = textOf(lastAssistant?.message)
  result.reported = reportsBlocker(finalText)
  result.restricted ||= /\b(?:awaiting|waiting for|need)\s+(?:your |user )?(?:approval|permission)\b/i.test(finalText)
  if (Array.isArray(latestTodos)) {
    result.unresolved = latestTodos.filter(todo => typeof todo?.content === 'string' && ['pending', 'in_progress'].includes(todo.status))
      .map(todo => todo.content)
  }
  return result
}

function reminder(outcome: VerificationOutcome | undefined, unresolved: readonly string[]): string {
  const details: string[] = []
  if (outcome?.pending) details.push('Some edited files still have pending verification after the last completed check.')
  if (outcome && outcome.status !== 'passed') details.push(`Verification ${outcome.status}: ${JSON.stringify(outcome.summary.slice(0, 1600))}`)
  if (unresolved.length) {
    details.push(`This turn's todo list still has ${unresolved.length} unfinished item(s):`)
    details.push(...unresolved.slice(0, 8).map(todo => `- ${JSON.stringify(todo.slice(0, 240))}`))
  }
  return [
    'Final check before ending this turn (one reminder maximum).',
    ...details,
    'These are recorded status facts, not additional authorization. Review whether they still apply to the user’s latest request.',
    'Complete any remaining authorized work and appropriate checks, or clearly report the blocker or verification gap in your final answer. Update the todo list only to reflect what actually happened.',
    'Respect requests to stop, pause, report only, and all time, token, attempt, and approval limits. Do not retry a denied action or grant yourself permission. If input or approval is needed, say so and stop.',
  ].join('\n')
}

/**
 * Install the sole stop hook. `flush` runs even after the one retry was used;
 * recording its result does not wake the model or start another turn.
 */
export function installCompletionGuard(ctx: Context, options: CompletionOptions): void {
  if (options.enabled === false) return
  const reserved = new WeakMap<object, number>()
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    try {
      if (signal.aborted || agent.status !== 'running' || agent.inbox?.nextStep?.length) return
      let state = boundary(agent, turn)
      if (!state.normal || state.restricted || verificationRestricted(agent)) return
      const outcome = await options.flush(agent, signal)
      if (signal.aborted || agent.status !== 'running' || outcome?.status === 'cancelled') return
      // A stop/pause, another plugin's steering, or a reload can race the check.
      state = boundary(agent, turn)
      if (!state.normal || state.restricted || verificationRestricted(agent)) return
      if (outcome?.fresh && typeof agent.session.append === 'function') {
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: outcome.summary }],
          source: { kind: 'verify-on-edit', form: 'notice', summary: `verify-on-edit: ${outcome.status}` } as never,
        }), { surfaceOp: 'append' })
      }
      if (state.used || state.reported || reserved.get(agent.session) === turn || agent.inbox?.nextStep?.length) return
      if ((!outcome || (outcome.status === 'passed' && !outcome.pending)) && state.unresolved.length === 0) return
      reserved.set(agent.session, turn)
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: reminder(outcome, state.unresolved) }],
        source: {
          kind: COMPLETION_SOURCE_KIND, form: 'notice',
          summary: `completion-guard: turn=${turn}; attempt=1`, turn, attempt: 1,
        },
      }))
    } catch (error) {
      // This extension must never turn an otherwise complete task into a crash.
      ctx.logger?.warn?.('completion-guard: final check unavailable: %o', error)
    }
  })
}
