/**
 * Refuse the first file-mutating tool call of a turn until that turn's recall
 * has run.
 *
 * The gate is a `tools/pre-execute` policy because that is the only seam that
 * can stop a call: `PreToolDecision` has `allow`, `deny`, `cancel`, and `ask`,
 * and input rewriting is deliberately excluded there because arguments are
 * already logged and presented. `tools/execute` cannot substitute — it may
 * change only `exec.signal`, and `ToolExecution.arguments` is readonly.
 *
 * @module @l33tdawg/dsh-recall-gate
 */
import type { Context } from '@deepseek-ai/cordis'
import { gate, resolveConfig } from './recall.ts'
import type { Config, SessionEvent } from './recall.ts'

export const name = 'recall-gate'

interface AgentLike {
  session?: {
    readonly seq?: number
    readonly events?: readonly SessionEvent[]
    eventAt?: (index: number) => SessionEvent | undefined
  }
}

interface PreToolExecution {
  readonly name?: unknown
  readonly arguments?: unknown
  readonly agent?: AgentLike
}

/**
 * Read the session's events through whichever Session log API is available.
 *
 * Both public shapes are supported because a restored session may expose only
 * the indexed one. An unreadable log returns nothing rather than throwing: the
 * caller then treats the turn as unrecollected, which is the conservative
 * direction — a gate that cannot see a recall should still refuse the write,
 * because the alternative is allowing a mutation on no evidence.
 *
 * @param session - the agent's session, when it has one.
 * @returns the events, oldest first.
 */
function sessionEvents(session: AgentLike['session']): readonly SessionEvent[] {
  if (session === undefined) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.eventAt !== 'function' || !Number.isSafeInteger(session.seq) || session.seq! < 0) return []
  const events: SessionEvent[] = []
  for (let index = 0; index < session.seq!; index++) {
    const event = session.eventAt(index)
    if (event !== undefined) events.push(event)
  }
  return events
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  ctx.on('tools/pre-execute', async (exec: PreToolExecution, next: () => Promise<unknown>) => {
    const decision = await next()
    // Any decision the pipeline already reached stands. A denial here must not
    // overwrite a sandbox refusal or an approval that never came.
    if ((decision as { kind?: unknown } | undefined)?.kind !== 'allow') return decision
    if (typeof exec.name !== 'string') return decision
    const verdict = gate(
      { name: exec.name, args: exec.arguments },
      sessionEvents(exec.agent?.session),
      resolved,
    )
    return verdict.kind === 'deny' ? { kind: 'deny', reason: verdict.reason } : decision
  })
}

export { gate, matchesToolName, mutatesFiles, recalledInTurn, resolveConfig, currentTurn } from './recall.ts'
export type { Config, PendingCall, ResolvedConfig, SessionEvent, Verdict } from './recall.ts'
