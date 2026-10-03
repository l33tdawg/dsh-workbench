#!/usr/bin/env node
/** Read recorded reliability signals; never infer a passed check from silence. */
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSession, readSession, sessionStartedAt } from './session-audit.mjs'

export const OUTCOMES = ['passed', 'failed', 'timed-out', 'unavailable', 'no-check', 'unparsed', 'cancelled']
const EDITS = new Set(['edit', 'write', 'apply_patch', 'str_replace_editor'])

/** Only plugin-originated notices count; a README or model quote is not delivery. */
function notice(record) {
  if (record?.type !== 'user/message') return undefined
  const data = record.data ?? {}
  return { source: data.source ?? data.message?.source, content: data.content ?? data.message?.content }
}

function commandArgs(call) {
  try { return typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments }
  catch { return undefined }
}

function isEdit(call) {
  if (!EDITS.has(call.name)) return false
  return call.name !== 'str_replace_editor'
    || ['create', 'str_replace', 'insert'].includes(commandArgs(call)?.command)
}

function directPath(call) {
  const args = commandArgs(call)
  const path = args?.file_path ?? args?.path
  return typeof path === 'string' ? path : undefined
}

/** Count observations, not task correctness or human effort. Records stay local. */
export function reliabilityMetrics(records) {
  const counts = {
    toolCalls: 0, successfulEdits: 0, failedEdits: 0, readAfterSuccessfulEdit: 0,
    approvalRequests: 0, approvalAllowed: 0, approvalRejected: 0,
    approvalCancelled: 0, approvalUnavailable: 0,
    verification: Object.fromEntries(OUTCOMES.map(status => [status, 0])),
    legacyVerificationNotices: 0, completionContinuations: 0,
    compactionReminders: 0, duplicateCompactionReminders: 0,
    completedTurns: 0, completedTurnsWithEdits: 0,
    editedTurnsWithoutVerificationNotice: 0, editedTurnsEndingAfterLastObservedCheck: 0,
    editedTurnsWithLastCheckNotPassed: 0, completedTurnsWithOpenCurrentTurnTodos: 0,
  }
  const calls = new Map(), turns = new Map(), editedPaths = new Set()
  let currentTurn, compactionMessages = new Set()
  const turnState = id => {
    if (id === undefined) return undefined
    if (!turns.has(id)) turns.set(id, { lastEdit: -1, lastCheck: -1, status: undefined, todos: undefined })
    return turns.get(id)
  }
  records.forEach((record, index) => {
    const data = record?.data ?? {}
    if (record.type === 'turn/start') {
      currentTurn = data.turn
      turnState(currentTurn)
    }
    const turn = turnState(data.turn ?? currentTurn)
    if (record.type === 'tool/call') {
      counts.toolCalls++
      calls.set(data.callId, { ...data, turn: data.turn ?? currentTurn })
      if (data.name === 'read' && editedPaths.has(directPath(data))) counts.readAfterSuccessfulEdit++
    }
    if (record.type === 'tool/result') {
      const message = data.message ?? {}
      const nested = Array.isArray(message.content)
        ? message.content.find(block => block?.type === 'tool-result') : undefined
      const call = calls.get(message.toolCallId ?? nested?.toolCallId ?? data.callId)
      if (call && isEdit(call)) {
        const failed = message.isError === true || nested?.isError === true || data.error !== undefined
        if (failed) counts.failedEdits++
        else {
          counts.successfulEdits++
          const state = turnState(call.turn)
          if (state) state.lastEdit = index
          const path = directPath(call)
          if (path) editedPaths.add(path)
        }
      }
    }
    if (record.type === 'approval/asked') counts.approvalRequests++
    if (record.type === 'approval/decided') {
      const key = { 'allowed-once': 'approvalAllowed', rejected: 'approvalRejected',
        cancelled: 'approvalCancelled', unavailable: 'approvalUnavailable' }[data.outcome]
      if (key) counts[key]++
    }
    if (record.type === 'todo/write' && turn && Array.isArray(data.todos)) turn.todos = data.todos
    if (record.type === 'compaction/end' && !data.error) compactionMessages = new Set()
    const message = notice(record)
    if (message?.source?.kind === 'verify-on-edit') {
      const match = /^verify-on-edit: (passed|failed|timed-out|unavailable|no-check|unparsed|cancelled)$/.exec(message.source.summary ?? '')
      if (match) {
        const status = match[1]
        counts.verification[status]++
        if (turn) { turn.lastCheck = index; turn.status = status }
      } else counts.legacyVerificationNotices++
    }
    if (message?.source?.kind === 'completion-guard') counts.completionContinuations++
    if (message?.source?.kind === 'compaction-todo') {
      counts.compactionReminders++
      const key = JSON.stringify(message.content)
      if (compactionMessages.has(key)) counts.duplicateCompactionReminders++
      compactionMessages.add(key)
    }
    if (record.type === 'turn/end' && data.reason?.kind === 'completed') {
      counts.completedTurns++
      if (turn?.lastEdit >= 0) {
        counts.completedTurnsWithEdits++
        if (turn.lastCheck < 0) counts.editedTurnsWithoutVerificationNotice++
        else if (turn.lastCheck < turn.lastEdit) counts.editedTurnsEndingAfterLastObservedCheck++
        else if (turn.status !== 'passed') counts.editedTurnsWithLastCheckNotPassed++
      }
      if (turn?.todos?.some(todo => ['pending', 'in_progress'].includes(todo?.status))) {
        counts.completedTurnsWithOpenCurrentTurnTodos++
      }
    }
  })
  return counts
}

export function combineMetrics(items) {
  const total = reliabilityMetrics([])
  for (const item of items) {
    for (const key of Object.keys(total)) {
      if (key === 'verification') for (const status of OUTCOMES) total.verification[status] += item.verification[status]
      else total[key] += item[key]
    }
  }
  return total
}

/** Recursively find only the canonical session files, without following symlinks. */
export function sessionFiles(root) {
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...sessionFiles(path))
    else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') found.push(path)
  }
  return found.sort()
}

export function runCensus({ root, since, until, session } = {}) {
  const measured = [], unreadable = []
  for (const path of sessionFiles(root)) {
    if (session && !path.includes(session)) continue
    try {
      const records = parseSession(readSession(path))
      const started = sessionStartedAt(records)
      if ((since !== undefined && (started === undefined || started < since))
        || (until !== undefined && (started === undefined || started >= until))) continue
      measured.push(reliabilityMetrics(records))
    } catch { unreadable.push(path) }
  }
  return {
    schema: 'dsh.reliability-census.v1', capturedAt: new Date().toISOString(),
    sessions: measured.length, unreadableSessions: unreadable.length,
    selection: { since: since === undefined ? null : new Date(since).toISOString(),
      until: until === undefined ? null : new Date(until).toISOString(), session: session ?? null },
    metrics: combineMetrics(measured),
    limits: [
      'No recorded automatic-check outcome means unknown, not passed or failed. Manual checks are not classified.',
      'Check coverage counters compare record order; they do not prove which file revision a command checked.',
      'Open todos and non-passed checks are review signals, not proof of false completion or missed requirements.',
      'Approval requests include automatic answerers; these counts do not measure human interruptions.',
      'Read-after-edit counts exact direct paths after successful tools; patch-only paths and aliases are excluded.',
      'Date filters select whole sessions by creation time; use fresh sessions for before/after comparisons.',
    ],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = { root: join(process.env.HOME ?? '', '.dsh', 'sessions') }
  let json = false
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--json') { json = true; continue }
    if (!['--root', '--since', '--until', '--session'].includes(key) || args[i + 1] === undefined) {
      console.error('usage: node tools/reliability-census.mjs [--root dir] [--since ISO] [--until ISO] [--session id] [--json]')
      process.exit(2)
    }
    const value = args[++i]
    if (key === '--since' || key === '--until') {
      const date = Date.parse(value)
      if (!Number.isFinite(date)) { console.error(`Invalid date for ${key}`); process.exit(2) }
      options[key.slice(2)] = date
    } else options[key.slice(2)] = value
  }
  if (options.since !== undefined && options.until !== undefined && options.since >= options.until) {
    console.error('--since must precede --until'); process.exit(2)
  }
  try {
    const result = runCensus(options)
    if (json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`${result.sessions} sessions; ${result.unreadableSessions} unreadable`)
      for (const [key, value] of Object.entries(result.metrics)) console.log(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
      for (const limit of result.limits) console.log(`Note: ${limit}`)
    }
    if (result.unreadableSessions) process.exitCode = 1
  } catch (error) { console.error(`Census failed: ${error.code ?? error.name}`); process.exitCode = 1 }
}
