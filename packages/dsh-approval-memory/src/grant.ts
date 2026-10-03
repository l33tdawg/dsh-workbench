/**
 * Session-scoped escalation grants.
 *
 * The measurement that produced this file: across every session recorded in
 * this repository, 191 approval asks were answered 189 times by hand and
 * rejected zero times, while 147 of the 148 commands involved were composite
 * shell scripts - multi-line, redirection-carrying, heredoc-carrying - that a
 * prefix rule cannot reach. The prompt load was a user saying yes to a
 * differently-worded script, over and over, in the same session.
 *
 * So the grant here is not about a command. It is about a *kind* of ask: after
 * a human has allowed one escalation in a session, an ask in that same session
 * for the same tool and the same widened sandbox mode is answered without
 * asking again. Three properties keep that honest:
 *
 * - **Nothing is pre-authorized.** With no earlier allow in the session's own
 *   log there is no grant, so a fresh session still asks the first time.
 * - **The basis is a decision, not an inference.** The earlier ask must carry an
 *   `approval/decided` outcome of `allowed-once`. A rejected, cancelled or
 *   unavailable outcome grants nothing.
 * - **It is derived, never stored.** The grant is recomputed from the session
 *   log on every request, so removing the tool from the config stops it at the
 *   next ask and no state has to be revoked.
 *
 * The residual risk is stated in the README: the second and later escalations
 * in a session get less scrutiny than the first, including one that writes
 * somewhere the first did not.
 *
 * @module @l33tdawg/dsh-approval-memory/grant
 */

/** The subset of a session event these rules read. */
export interface ApprovalEventLike {
  type: string
  data?: {
    id?: string
    toolName?: string
    reason?: string
    callId?: string
    outcome?: string
  }
}

/** The pending request, as far as a grant is concerned. */
export interface GrantRequestLike {
  toolName: string
  callId?: string
  reason?: string
}

/** Why a session is allowed to skip the prompt. */
export interface GrantBasis {
  /** The audit id of the earlier ask that was allowed. */
  askId: string
  /** The widened mode both asks request. */
  mode: string
  /** The tool both asks are for. */
  tool: string
}

/** The escalation reason the sandbox escalation path writes. */
const ESCALATION = /escalate sandbox to ([a-z-]+)/i

/**
 * The sandbox mode an approval reason asks to widen to.
 * @param reason - the request's reason string.
 * @returns the mode, or `undefined` when the ask is not an escalation.
 */
export function escalationMode(reason: string | undefined): string | undefined {
  if (typeof reason !== 'string') return undefined
  const found = ESCALATION.exec(reason)
  return found?.[1]
}

/**
 * The earlier allow that covers this ask, if the session has one.
 * @param events - the session's own events, in order.
 * @param request - the pending approval request.
 * @param tools - tools the deployment granted a session scope for.
 * @returns the basis, or `undefined` when this ask must be put to the user.
 */
export function sessionGrantBasis(
  events: readonly ApprovalEventLike[],
  request: GrantRequestLike,
  tools: readonly string[],
): GrantBasis | undefined {
  if (!tools.includes(request.toolName)) return undefined
  const mode = escalationMode(request.reason)
  if (mode === undefined) return undefined

  const decided = new Map<string, string>()
  for (const event of events) {
    if (event?.type !== 'approval/decided') continue
    const id = event.data?.id
    if (typeof id === 'string') decided.set(id, String(event.data?.outcome))
  }

  for (const event of events) {
    if (event?.type !== 'approval/asked') continue
    const data = event.data ?? {}
    if (data.toolName !== request.toolName) continue
    // The service logs the ask before it dispatches, so the pending request is
    // already in this list and must not be its own basis.
    if (data.callId !== undefined && request.callId !== undefined && data.callId === request.callId) continue
    if (escalationMode(data.reason) !== mode) continue
    if (typeof data.id !== 'string' || decided.get(data.id) !== 'allowed-once') continue
    return { askId: data.id, mode, tool: request.toolName }
  }
  return undefined
}
