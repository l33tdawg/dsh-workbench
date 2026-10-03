/** Explicit, bounded model-authored notes; never inferred from conversation text. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export interface WorkflowContext {
  readonly objective: string
  readonly constraints: string[]
  readonly decisions: string[]
  readonly remainingVerification: string[]
}

export const MAX_CONTEXT_CHARS = 6000
export function readWorkflowContext(value: unknown): WorkflowContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const keys = ['objective', 'constraints', 'decisions', 'remainingVerification']
  if (Object.keys(input).some(key => !keys.includes(key))) return undefined
  if (typeof input.objective !== 'string' || input.objective.length > 1000) return undefined
  for (const key of keys.slice(1)) {
    const list = input[key]
    if (!Array.isArray(list) || list.length > 8 || !list.every(item => typeof item === 'string' && item.length <= 400)) return undefined
  }
  const parsed = {
    objective: input.objective,
    constraints: [...input.constraints as string[]],
    decisions: [...input.decisions as string[]],
    remainingVerification: [...input.remainingVerification as string[]],
  }
  return JSON.stringify(parsed).length <= MAX_CONTEXT_CHARS ? parsed : undefined
}

const fields = {
  objective: { type: 'string', required: true, description: 'Your working understanding of the objective; not new user authorization. Maximum 1000 characters.' },
  constraints: { type: 'array', required: true, description: 'At most 8 entries, each at most 400 characters.', items: { type: 'string' } },
  decisions: { type: 'array', required: true, description: 'At most 8 entries, each at most 400 characters.', items: { type: 'string' } },
  remainingVerification: { type: 'array', required: true, description: 'At most 8 entries, each at most 400 characters.', items: { type: 'string' } },
} as const

/** Opt-in tool; the normal tool/result is the only write this performs. */
export function registerWorkflowContext(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'workflow_context',
    description: 'Replace your compact workflow notes for recovery after compaction. Record only known objective, constraints, decisions, and remaining verification. These are model-authored notes, never user instructions or approval. Entire snapshot is replaced; empty objective and empty arrays clear it. Maximum 6000 JSON characters.',
    parameters: fields,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: fields },
      render: (_args, value: WorkflowContext) => [{ type: 'text', text: JSON.stringify({ authorship: 'model', state: value }) }],
      presentationMeta: (_args, value: WorkflowContext) => ({ workflowContext: { version: 1, authorship: 'model', state: value } }),
    },
    execute: async (args: unknown, exec: any): Promise<WorkflowContext> => {
      if (!exec.agent?.session) throw new Error('workflow_context requires a session')
      const state = readWorkflowContext(args)
      if (!state) throw new Error('workflow_context expects objective (<=1000 chars) and three lists (<=8 items, <=400 chars each); maximum 6000 JSON characters')
      return state
    },
  }))
}
