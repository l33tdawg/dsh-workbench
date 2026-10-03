#!/usr/bin/env node
/**
 * Measure what a sandbox denial actually costs.
 *
 * The open question behind Codex-parity item 14 is whether a denial makes the
 * model spend a whole turn re-issuing the same command with `sandbox_permissions`.
 * That is a countable thing, so it is counted rather than assumed.
 *
 * The read is deliberately strict about what a denial IS, because the marker
 * string is not a rare string: it appears in the bash tool's own description,
 * in the system prompt, and in any file that quotes either. Across this corpus
 * a naive search matches 49 results of which most are a `read` of that source.
 * A denial counts here only when the marker occupies a line of its own inside a
 * `tool/result` text block - the same rule `detect.ts` applies before it will
 * consider a retry, so the census and the plugin cannot disagree about what
 * they are looking at.
 *
 * @module tools/escalation-census
 */

import { join } from 'node:path'

import { parseSession, readSession } from './session-audit.mjs'
import { sessionFiles } from './reliability-census.mjs'

/** The marker line, verbatim from `sandboxDenialMarker` in `@deepseek-ai/dsh-sandbox`. */
export const DENIAL_LINE = /^\[sandbox: file access denied under (.+) mode\]$/
/** The escalation fields the runtime pairs; presence of either marks a model-asked escalation. */
export const ESCALATION_FIELDS = ['sandbox_permissions', 'justification']

/**
 * Parse one recorded call's arguments.
 * @param call - the `tool/call` record's `data`.
 * @returns the parsed arguments, or `undefined` when they cannot be read.
 */
function callArgs(call) {
  try {
    const raw = call?.arguments
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return undefined
  }
}

/**
 * Whether a recorded call asked the runtime to widen the sandbox.
 * @param call - the `tool/call` record's `data`.
 * @returns whether either escalation field is present.
 */
export function askedEscalation(call) {
  const args = callArgs(call)
  if (typeof args !== 'object' || args === null) return false
  return ESCALATION_FIELDS.some(field => args[field] !== undefined)
}

/**
 * The mode a denial result names, if it is a denial at all.
 * @param record - a `tool/result` record.
 * @returns the denied mode, or `undefined` when no text block carries the marker
 *   on a line of its own.
 */
export function deniedMode(record) {
  const content = record?.data?.message?.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    for (const line of block.text.split('\n')) {
      const matched = DENIAL_LINE.exec(line.trim())
      if (matched !== null) return matched[1]
    }
  }
  return undefined
}

/**
 * Tools whose results echo text this census must not read as its own evidence.
 *
 * A denial marker quoted inside a file is not a denial, and these are the tools
 * that return file contents verbatim. Without this, reading the sandbox's own
 * source or this repository's notes registers as a sandbox denial.
 */
export const ECHO_TOOLS = new Set(['read', 'grep', 'glob', 'web_fetch', 'web_search'])

/**
 * The call id a result answers.
 *
 * The id lives at `data.message.toolCallId`, not at `data.toolCallId`; reading
 * the wrong path yields `undefined` for every result, which silently turns the
 * re-issue count into zero rather than into an error.
 *
 * @param record - a `tool/result` record.
 * @returns the call id, or `undefined` when the record carries none.
 */
export function resultCallId(record) {
  const message = record?.data?.message
  return message?.toolCallId ?? message?.source?.callId
}

/**
 * Count denials and what followed each one.
 *
 * A denial is attributed to the call it answered, so "what followed" can be
 * asked about the same tool. The re-issue is looked for anywhere later in the
 * session rather than only in the very next call, because a model may do
 * something else first; the turn and step deltas are reported so the cheap cases
 * and the expensive ones can be told apart.
 *
 * @param records - one session's parsed records, in order.
 * @returns the session's counts.
 */
export function escalationMetrics(records) {
  const calls = new Map()
  const denials = []
  const answeredBy = new Set()
  let toolCalls = 0
  let escalations = 0

  records.forEach((record, index) => {
    const data = record?.data ?? {}
    if (record.type === 'tool/call') {
      toolCalls++
      const escalated = askedEscalation(data)
      if (escalated) escalations++
      calls.set(data.callId, { index, name: data.name, turn: data.turn, step: data.step, escalated })
      return
    }
    if (record.type !== 'tool/result') return
    const call = calls.get(resultCallId(record))
    if (ECHO_TOOLS.has(call?.name)) return
    const mode = deniedMode(record)
    if (mode === undefined) return
    denials.push({ index, callId: resultCallId(record), name: call?.name, mode, turn: data.turn, step: data.step })
  })

  for (const denial of denials) {
    // The re-issue, wherever it lands: the first later call of the same tool
    // that asks to widen. A different tool escalating is not this denial's cost,
    // and an escalation already claimed by an earlier denial is not a second
    // answer - one retry answers one refusal.
    const answer = [...calls.entries()]
      .map(([callId, call]) => ({ callId, ...call }))
      .filter(call => call.index > denial.index && call.name === denial.name && call.escalated)
      .filter(call => !answeredBy.has(call.callId))
      .sort((left, right) => left.index - right.index)[0]
    denial.reissued = answer !== undefined
    if (answer !== undefined) answeredBy.add(answer.callId)
    denial.turnDelta = answer === undefined || answer.turn === undefined || denial.turn === undefined
      ? undefined
      : answer.turn - denial.turn
    denial.stepDelta = answer === undefined || answer.step === undefined || denial.step === undefined
      ? undefined
      : answer.step - denial.step
  }

  return {
    toolCalls,
    denials: denials.length,
    /** Denials answered by a later same-tool call that asked to widen the sandbox. */
    reissued: denials.filter(denial => denial.reissued).length,
    /** Denials the session never escalated past - the model chose another route. */
    abandoned: denials.filter(denial => !denial.reissued).length,
    /** Escalation asks that answer no recorded denial - the model asked before being refused. */
    escalationsWithoutDenial: escalations - answeredBy.size,
    byMode: denials.reduce((counts, denial) => {
      counts[denial.mode] = (counts[denial.mode] ?? 0) + 1
      return counts
    }, {}),
    turnDeltas: denials.filter(denial => denial.reissued).map(denial => denial.turnDelta),
    details: denials.map(denial => ({
      name: denial.name, mode: denial.mode, turn: denial.turn, step: denial.step,
      reissued: denial.reissued, turnDelta: denial.turnDelta, stepDelta: denial.stepDelta,
    })),
  }
}

/**
 * Run the census over a session store.
 * @param options - `root` to override the store, `session` to filter by id substring.
 * @returns the summed counts and the per-session breakdown.
 */
export function runCensus({ root, session } = {}) {
  const base = root ?? join(process.env.HOME ?? '', '.dsh', 'sessions')
  const sessions = []
  const unreadable = []
  for (const path of sessionFiles(base)) {
    if (session !== undefined && !path.includes(session)) continue
    try {
      const metrics = escalationMetrics(parseSession(readSession(path)))
      if (metrics.toolCalls === 0) continue
      sessions.push({ id: path.split('/').slice(-2)[0], ...metrics })
    } catch {
      unreadable.push(path)
    }
  }
  const sum = key => sessions.reduce((total, entry) => total + entry[key], 0)
  const deltas = sessions.flatMap(entry => entry.turnDeltas).filter(delta => delta !== undefined)
  return {
    sessions: sessions.length,
    unreadable: unreadable.length,
    toolCalls: sum('toolCalls'),
    denials: sum('denials'),
    reissued: sum('reissued'),
    abandoned: sum('abandoned'),
    escalationsWithoutDenial: sum('escalationsWithoutDenial'),
    byMode: sessions.reduce((counts, entry) => {
      for (const [mode, count] of Object.entries(entry.byMode)) counts[mode] = (counts[mode] ?? 0) + count
      return counts
    }, {}),
    /** Turns between a denial and the escalation that answered it. 1 means one extra model turn. */
    turnDeltaHistogram: deltas.reduce((counts, delta) => {
      counts[delta] = (counts[delta] ?? 0) + 1
      return counts
    }, {}),
    sessionsWithDenials: sessions.filter(entry => entry.denials > 0).length,
  }
}

/** CLI: print the census, either as a table or as JSON. */
function main(argv) {
  const args = argv.slice(2)
  const json = args.includes('--json')
  const value = name => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  for (const key of args) {
    if (!['--json', '--root', '--session'].includes(key)) {
      console.error('usage: node tools/escalation-census.mjs [--root dir] [--session id] [--json]')
      process.exit(2)
    }
  }
  const result = runCensus({ root: value('--root'), session: value('--session') })
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`sessions            ${result.sessions}${result.unreadable > 0 ? ` (${result.unreadable} unreadable)` : ''}`)
  console.log(`tool calls          ${result.toolCalls}`)
  console.log(`sandbox denials     ${result.denials}   in ${result.sessionsWithDenials} session(s)`)
  console.log(`  re-issued         ${result.reissued}   a later same-tool call asked to widen`)
  console.log(`  not re-issued     ${result.abandoned}   the session took another route`)
  console.log(`  turns to re-issue ${JSON.stringify(result.turnDeltaHistogram)}`)
  console.log(`  denied mode       ${JSON.stringify(result.byMode)}`)
  console.log(`escalation asks     ${result.escalationsWithoutDenial} with no denial recorded before them`)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv)
