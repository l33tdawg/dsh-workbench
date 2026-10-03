/** Recover explicit workflow state once per compaction, using durable receipts. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { receiptFor, reminderParts, renderReminder, scanLog, type Receipt, type SessionLike } from './log.ts'
import { registerWorkflowContext } from './workflow.ts'

export { needsReminder, readTodos, renderReminder, scanLog, reminderParts } from './log.ts'
export type { LogState, SessionLike, StoredTodo } from './log.ts'
export const name = 'compaction-todo'
export const inject = ['tools'] as const
export const SOURCE_KIND = 'compaction-todo'
export interface Config { workflowContext?: boolean }
export interface AgentLike { readonly session: SessionLike }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'compaction-todo': {
      kind: 'compaction-todo'
      form: 'recall'
      continuity: Receipt
    }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.workflowContext !== undefined && typeof config.workflowContext !== 'boolean') {
    throw new Error('compaction-todo: workflowContext must be a boolean')
  }
  if (config.workflowContext) registerWorkflowContext(ctx)
  ctx.on('agent/pre-step', async (payload: { agent: AgentLike }, next: () => Promise<unknown>) => {
    const decision = await next()
    try {
      const session = payload.agent?.session
      if (!session) return decision
      const state = scanLog(session, config)
      const parts = reminderParts(state)
      if (!parts.todos && !parts.workflow && !parts.goal) return decision
      const message = createUserMessage({
        content: [{ type: 'text', text: renderReminder(parts.todos ?? [], parts) }],
        source: { kind: SOURCE_KIND, form: 'recall', continuity: receiptFor(state, parts) },
      })
      const existing = decision as { messages?: unknown[] } | undefined
      return { ...(existing ?? {}), messages: [...(existing?.messages ?? []), message] }
    } catch (error) {
      ctx.logger?.warn?.('compaction-todo: could not recover workflow state: %o', error)
      return decision
    }
  })
}
