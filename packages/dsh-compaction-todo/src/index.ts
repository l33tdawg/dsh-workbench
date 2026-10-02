/**
 * Keep the todo list inside the model's context across a compaction.
 *
 * WHAT THIS IS FOR. `todo_write` appends `todo/write` to the durable session log
 * and registers a `todos` projection, so the plan survives on disk. Compaction
 * then replaces the model's context window with a summary, and the summary does
 * not carry the list. The tool result the model was working from is gone, no
 * read-back tool exists, and the agent continues without its plan. That is "the
 * agent misses things" by construction rather than by model failure.
 *
 * HOW IT WORKS. Two listeners, no new tool:
 *
 * - `session/event` mirrors the newest `todo/write` per session. A todo list is
 *   one record whose later writes replace earlier ones, so the newest write is
 *   the whole list. The tool's own `todos` projection clears at `turn/start`,
 *   which is why this tracks the durable record instead.
 * - `agent/pre-step` notices when the newest `compaction/end` is newer than the
 *   newest `todo/write` and puts the list back.
 *
 * WHO LEADS. The injection is driven by the session log, not by memory. Anything
 * held only in this process can disagree with the session after a resume, a
 * fork, a reload, or a second DSH process appending to the same log, so the log
 * is the authority and the mirror is only a cache. A write this process missed
 * cannot make the injection wrong; the next step re-reads the log.
 *
 * WHY IT RE-INJECTS ON EVERY STEP UNTIL THE LIST MOVES. Whether a message a
 * plugin contributes at `agent/pre-step` is durable or single-step is not
 * documented, and a reminder that survives exactly one step is close to
 * useless. Re-reminding on each step until the agent writes a new list needs no
 * such assumption, and each reminder is the same bounded block. Once the agent
 * writes again, the newest write is newer than the compaction and the block
 * stops.
 *
 * WHAT IT DOES NOT DO. It never invents a plan, never merges two lists, and
 * never re-injects a list the agent has since replaced with an empty write: the
 * newest write wins, including when the newest write is empty.
 *
 * @module @l33tdawg/dsh-compaction-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { needsReminder, readTodos, renderReminder, scanLog, type SessionLike, type StoredTodo } from './log.ts'

export { needsReminder, readTodos, renderReminder, scanLog } from './log.ts'
export type { LogState, SessionLike, StoredTodo } from './log.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'compaction-todo'

/** Services this plugin reads; every `ctx.<name>` below must appear here. */
export const inject = ['tools'] as const

/** Message source kind, so the injected reminder is identifiable in the log. */
export const SOURCE_KIND = 'compaction-todo'

/** The minimal agent surface this plugin reads. */
export interface AgentLike {
  readonly session: SessionLike
}

/** A session's cached list, mirrored from its own event feed. */
interface Cache {
  readonly todos: readonly StoredTodo[]
}

/**
 * Install the tracking and re-injection listeners.
 * @param ctx - Cordis context carrying the session event feed.
 */
export function apply(ctx: Context): void {
  const cache = new Map<string, Cache>()

  const idOf = (session: unknown): string | undefined => {
    const id = (session as { header?: { id?: unknown } } | undefined)?.header?.id
    return typeof id === 'string' ? id : undefined
  }

  ctx.on('session/event', (session: unknown, event: unknown) => {
    const record = event as { type?: string; data?: unknown } | undefined
    if (record?.type !== 'todo/write') return
    const id = idOf(session)
    if (id === undefined) return
    const todos = readTodos(record.data)
    if (todos === undefined) return
    cache.set(id, { todos })
  })

  ctx.on('session/disposed', (session: unknown) => {
    const id = idOf(session)
    if (id !== undefined) cache.delete(id)
  })

  ctx.on('agent/pre-step', async (payload: { agent: AgentLike }, next: () => Promise<unknown>) => {
    const decision = await next()
    try {
      const session = payload.agent?.session
      if (session === undefined) return decision
      const state = scanLog(session)
      if (!needsReminder(state)) return decision
      const mirrored = cache.get(idOf(session) ?? '')
      // The log is authoritative. The mirror only covers a write that landed
      // after the scan above, which the next step would pick up in any case.
      const todos = state.todos ?? mirrored?.todos ?? []
      if (todos.length === 0) return decision
      const message = createUserMessage({
        content: [{ type: 'text', text: renderReminder(todos) }],
        source: { kind: SOURCE_KIND },
      })
      const reason = decision as { messages?: unknown[] } | undefined
      const messages = Array.isArray(reason?.messages) ? [...reason.messages, message] : [message]
      // Say so on the way out. A reminder that fired and one that never fired
      // look identical from the outside otherwise, and the Desktop app shows no
      // host logger output, so this line is the only trace a live session
      // leaves. It records the decision, not delivery.
      ctx.logger?.info?.(
        'compaction-todo: re-injected %d todo(s) after compaction at seq %d (newest write at seq %d)',
        todos.length,
        state.compactedAt,
        state.wroteAt,
      )
      return { ...(reason ?? {}), messages }
    } catch (error) {
      // A reminder is not worth failing a turn over.
      ctx.logger?.warn?.('compaction-todo: could not re-inject the todo list: %o', error)
      return decision
    }
  })
}
