/**
 * Decide whether a pending tool call may run before the turn's recall has.
 *
 * The gate exists for one failure mode: an agent edits a tree that a committed
 * memory names as another session's, because it wrote before consulting memory.
 * Nothing in the call itself reveals that, so the only available signal is
 * ordering — the recall either ran in this turn or it did not.
 *
 * Kept free of harness imports so the whole decision surface is unit-testable.
 *
 * @module @l33tdawg/dsh-recall-gate/recall
 */

/**
 * Tool names that perform a recall.
 *
 * Matched by name and by `__`-separated suffix, because an MCP-imported tool
 * arrives namespaced: the SAGE tool registered as `sage_turn` is dispatched here
 * as `mcp__sage__sage_turn`.
 */
export const DEFAULT_RECALL_TOOLS: readonly string[] = ['sage_turn']

/**
 * Tool names whose success means a file on disk changed.
 *
 * Duplicated from `dsh-verify-on-edit` rather than imported: the two plugins
 * ship independently, and a profile may mount one without the other.
 */
export const DEFAULT_WRITE_TOOLS: readonly string[] = ['edit', 'write', 'apply_patch', 'str_replace_editor']

/** Plugin configuration. */
export interface Config {
  /** Whether the gate runs at all. */
  enabled?: boolean
  /** Tool names that satisfy the gate for the turn. */
  recallTools?: string[]
  /** Tool names that trigger the gate. */
  writeTools?: string[]
}

/** Resolved configuration with every default applied. */
export interface ResolvedConfig {
  enabled: boolean
  recallTools: readonly string[]
  writeTools: readonly string[]
}

/** One event from a session log, as far as this plugin reads it. */
export interface SessionEvent {
  readonly type?: string
  readonly data?: unknown
}

/** What a pending call is, as far as this plugin reads it. */
export interface PendingCall {
  readonly name: string
  readonly args: unknown
}

/** The gate's verdict on one call. */
export type Verdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny', readonly reason: string }

/**
 * Fill in defaults, rejecting values that would make the gate useless.
 *
 * An empty tool list is rejected rather than defaulted: `recallTools: []` would
 * deny every write forever and `writeTools: []` would never deny anything, and
 * both are more likely to be a mistake in a profile than an intention.
 *
 * @param config - raw plugin configuration.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const list = (value: string[] | undefined, fallback: readonly string[], field: string): readonly string[] => {
    if (value === undefined) return fallback
    if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item === '')) {
      throw new Error(`recall-gate: ${field} must be a non-empty array of tool names`)
    }
    return value
  }
  return {
    enabled: config.enabled ?? true,
    recallTools: list(config.recallTools, DEFAULT_RECALL_TOOLS, 'recallTools'),
    writeTools: list(config.writeTools, DEFAULT_WRITE_TOOLS, 'writeTools'),
  }
}

/**
 * Whether a dispatched tool name is one of the configured names.
 *
 * An MCP tool reaches the dispatch pipeline namespaced as
 * `mcp__<server>__<tool>`, so a comparison against the bare name alone would
 * miss every imported tool. Matching any `__`-separated segment keeps the
 * default working whether a tool is native (`sage_turn`), imported
 * (`mcp__sage__sage_turn`), or lives inside a namespace of its own
 * (`mcp__fs__apply_patch`).
 *
 * @param name - the dispatched tool name.
 * @param candidates - the configured names.
 * @returns whether any segment equals a configured name.
 */
export function matchesToolName(name: string, candidates: readonly string[]): boolean {
  if (candidates.includes(name)) return true
  return name.split('__').some(segment => candidates.includes(segment))
}

/**
 * Whether a completed call changed a file.
 *
 * `str_replace_editor` is the one write tool that also has read-only commands,
 * so its `command` argument decides. Every other configured write tool mutates
 * on success.
 *
 * @param name - the dispatched tool name.
 * @param args - the call's parsed arguments.
 * @returns whether the call is a mutation.
 */
export function mutatesFiles(name: string, args: unknown): boolean {
  if (name !== 'str_replace_editor' && !name.endsWith('__str_replace_editor')) return true
  if (typeof args !== 'object' || args === null) return false
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' && ['create', 'str_replace', 'insert'].includes(command)
}

/**
 * Extract the agent's current turn.
 *
 * A turn boundary is the `turn/start` event. Events before the newest one belong
 * to earlier turns and cannot satisfy this turn's gate, which is the point: a
 * recall last turn is not a recall of the memory that changed since.
 *
 * @param events - the session's events, oldest first.
 * @returns the current turn's id and its events after the boundary.
 */
export function currentTurn(events: readonly SessionEvent[]): { turn?: number, events: SessionEvent[] } {
  let boundary = -1
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === 'turn/start') { boundary = index; break }
  }
  const current = events.slice(boundary + 1)
  const data = boundary === -1 ? undefined : events[boundary]?.data
  const turn = typeof data === 'object' && data !== null ? (data as { turn?: number }).turn : undefined
  return { turn, events: current }
}

/**
 * Whether a recall has *completed* in this turn.
 *
 * An attempt is not a recall. The call must have a matching result, and that
 * result must not be an error, because neither a recall still in flight nor one
 * that failed read a memory.
 *
 * The result id is read from `message.toolCallId` first and `callId` second:
 * the durable log records both, depending on which variant of the session
 * format wrote the record, and matching only one would leave every recall in a
 * session written the other way counting as incomplete.
 *
 * @param events - the current turn's events.
 * @param recallTools - the configured recall tool names.
 * @returns whether a recall completed.
 */
export function recalledInTurn(events: readonly SessionEvent[], recallTools: readonly string[]): boolean {
  const results = new Map<string, boolean>()
  const calls: { id: string, name: string }[] = []
  for (const event of events) {
    const data = event.data
    if (typeof data !== 'object' || data === null) continue
    const record = data as {
      callId?: unknown
      name?: unknown
      message?: { toolCallId?: unknown, isError?: unknown }
    }
    if (event.type === 'tool/call') {
      if (typeof record.name === 'string') {
        // A call with no id cannot be paired with its result, so it can never
        // be taken as proof that a recall completed.
        calls.push({ id: typeof record.callId === 'string' ? record.callId : '', name: record.name })
      }
      continue
    }
    if (event.type !== 'tool/result') continue
    const id = record.message?.toolCallId ?? record.callId
    if (typeof id !== 'string') continue
    results.set(id, record.message?.isError !== true)
  }
  return calls.some(call => call.id !== ''
    && matchesToolName(call.name, recallTools)
    && results.get(call.id) === true)
}

/**
 * Decide whether a pending call may run.
 *
 * @param call - the pending call.
 * @param events - the session's events, oldest first.
 * @param config - the resolved configuration.
 * @returns the verdict, with a reason the model can act on when denying.
 */
export function gate(call: PendingCall, events: readonly SessionEvent[], config: ResolvedConfig): Verdict {
  if (!config.enabled) return { kind: 'allow' }
  const writes = matchesToolName(call.name, config.writeTools)
  if (!writes || !mutatesFiles(call.name, call.args)) return { kind: 'allow' }
  const turn = currentTurn(events)
  if (recalledInTurn(turn.events, config.recallTools)) return { kind: 'allow' }
  const recalls = config.recallTools.map(tool => `\`${tool}\``).join(' or ')
  return {
    kind: 'deny',
    reason: `This turn has not recalled its memory yet, and this call changes a file. `
      + `Call ${recalls} first, then retry this call. A committed memory may name this tree as `
      + `another session's work, or carry a decision this edit would contradict; recall is what `
      + `surfaces that before the write rather than after.`,
  }
}
