/** Read current-turn evidence from both public Session log APIs. */
import { editedPaths, mutatesFiles, resolveAgainst } from './report.ts'

type Event = { type?: string, data?: any }
export interface SessionLog {
  readonly seq?: number
  readonly events?: readonly Event[]
  eventAt?: (index: number) => Event | undefined
}

export function currentTurnEvents(session: SessionLog): { turn?: number, events: Event[] } {
  const indexed = typeof session.eventAt === 'function' && Number.isSafeInteger(session.seq) && session.seq! >= 0
  const log = indexed ? undefined : session.events
  const count = indexed ? session.seq! : log?.length ?? 0
  const at = indexed ? (index: number) => session.eventAt!(index) : (index: number) => log?.[index]
  const events: Event[] = []
  for (let i = count - 1; i >= 0; i--) {
    const event = at(i)
    if (!event) continue
    if (event.type === 'turn/start') return { turn: event.data?.turn, events: events.reverse() }
    events.push(event)
  }
  return { events: [] }
}

/**
 * A reload loses process memory but not completed tool calls. Re-check their
 * files once rather than inferring that a past notice still verifies the tree.
 */
export function recoverEditedPaths(events: readonly Event[], root: string): string[] {
  const calls = new Map<string, { name: string, arguments: unknown }>()
  const paths = new Set<string>()
  for (const event of events) {
    const data = event.data
    if (event.type === 'tool/call' && typeof data?.callId === 'string') {
      try {
        const args = JSON.parse(data.arguments)
        if (mutatesFiles(data.name, args)) calls.set(data.callId, { name: data.name, arguments: args })
      } catch { /* An unreadable call is not evidence of a successful edit. */ }
    }
    if (event.type !== 'tool/result' || data?.message?.isError === true || data?.error) continue
    const message = data?.message
    const nested = Array.isArray(message?.content)
      ? message.content.filter((block: any) => block?.type === 'tool-result') : []
    const results = nested.length ? nested : [{
      toolCallId: message?.toolCallId ?? message?.callId ?? message?.source?.callId,
      isError: message?.isError,
    }]
    for (const result of results) {
      if (result.isError === true) continue
      const call = calls.get(result.toolCallId)
      if (!call) continue
      for (const path of editedPaths(call.name, call.arguments, data.meta)) paths.add(resolveAgainst(path, root))
    }
  }
  return [...paths]
}
