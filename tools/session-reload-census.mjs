#!/usr/bin/env node
/**
 * Count tool-surface changes inside recorded DSH sessions.
 *
 * A `request/header` record is written once per model request and carries the
 * tool list the harness sent. Two consecutive headers in one session therefore
 * say whether the session's tools changed while it ran - which is what a
 * profile reload does, and the question discussion 8635 is about.
 *
 * The reason field is the harness's own label for why the header was written:
 * `initial`, `series` (same turn chain), `resume` (the session was re-attached)
 * and `change` (the tool surface differed from the previous request). A
 * `change` is the observable; it is not evidence about the profile file on its
 * own. Correlating one with a profile write means comparing its instant with
 * the write's mtime, which is why `--verbose` prints both clocks.
 *
 * What a change cannot say: which file caused it, or whether the change was a
 * reload at all. A tool appearance can also come from a plugin mounting itself,
 * and an agent's own tool set can change when its preset is re-applied. The
 * count is the measurement; the cause is read from the harness source.
 *
 * Usage:
 *   node session-reload-census.mjs [--root <sessions dir>] [--since <date>]
 *                                  [--session <id substring>] [--json]
 *                                  [--verbose]
 *
 *   --since    keep only sessions that STARTED at or after this instant
 *   --session  keep only sessions whose directory name contains this substring
 *
 * @module dsh-session-reload-census
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readSession, parseSession, sessionStartedAt } from './session-audit.mjs'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

const ROOT = value('--root') ?? join(process.env.HOME ?? '', '.dsh', 'sessions')
const AS_JSON = flag('--json')
const VERBOSE = flag('--verbose')
const ONLY_SESSION = value('--session')

/**
 * The `--since` instant, or undefined when the flag is absent.
 *
 * An unparseable value is rejected rather than ignored: a mistyped date that
 * silently widened the corpus would present a pre-reload session as a
 * post-reload one, which is the error this flag exists to prevent.
 */
const SINCE = (() => {
  const raw = value('--since')
  if (raw === undefined) return undefined
  const at = Date.parse(raw)
  if (Number.isNaN(at)) {
    console.error(`--since is not a date: ${raw}`)
    process.exit(2)
  }
  return at
})()

/** Every `session.v4.jsonl.zstd` under `root`. */
function sessions(root) {
  const found = []
  const walk = dir => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.v4.jsonl.zstd') found.push(path)
    }
  }
  walk(root)
  return found
}

/** A tool entry as a name: the log writes bare strings and full schemas. */
function toolName(tool) {
  if (typeof tool === 'string') return tool
  return typeof tool?.name === 'string' ? tool.name : undefined
}

/**
 * One session's requests and the changes between them.
 *
 * @param records - the session's parsed records.
 * @returns every readable request, then each consecutive pair whose tool set
 * differs, with `added` and `removed` sorted so two runs compare equal.
 */
export function reloads(records) {
  const requests = []
  for (const record of records) {
    if (record?.type !== 'request/header') continue
    const tools = record.data?.header?.tools
    if (!Array.isArray(tools)) continue
    requests.push({
      at: typeof record.time === 'number' ? record.time : record.createdAt,
      reason: typeof record.data?.reason === 'string' ? record.data.reason : undefined,
      tools: tools.map(toolName).filter(name => name !== undefined),
    })
  }

  const changes = []
  for (let index = 1; index < requests.length; index++) {
    const previous = new Set(requests[index - 1].tools)
    const current = new Set(requests[index].tools)
    const added = [...current].filter(name => !previous.has(name)).sort()
    const removed = [...previous].filter(name => !current.has(name)).sort()
    if (added.length === 0 && removed.length === 0) continue
    changes.push({
      at: requests[index].at,
      reason: requests[index].reason,
      tools: current.size,
      added,
      removed,
    })
  }
  return { requests, changes }
}

/**
 * One session's reload picture, with the identity a reader needs to trust it.
 * @param records - the session's parsed records.
 * @returns preset, workspace, request count and the changes between requests.
 */
export function census(records) {
  const header = records.find(record => record?.type === 'session')
  const { requests, changes } = reloads(records)
  const instants = requests.map(request => request.at).filter(at => typeof at === 'number')
  return {
    preset: typeof header?.agentPreset === 'string' ? header.agentPreset : undefined,
    cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
    requests: requests.length,
    // Every request instant, so a reader can put a profile write between two
    // of them instead of trusting the bounds. The span a change would have had
    // to fall inside matters: a session whose last request precedes a write
    // cannot witness it.
    requestTimes: instants,
    firstRequestAt: instants.length === 0 ? undefined : Math.min(...instants),
    lastRequestAt: instants.length === 0 ? undefined : Math.max(...instants),
    changes,
  }
}

function main() {
  const files = sessions(ROOT)
  if (files.length === 0) {
    console.error(`no sessions under ${ROOT}`)
    process.exit(2)
  }

  const rows = []
  let skippedBySince = 0
  let skippedBySession = 0
  for (const path of files) {
    const id = path.split('/').slice(-2)[0]
    if (ONLY_SESSION !== undefined && !id.includes(ONLY_SESSION)) {
      skippedBySession++
      continue
    }
    let records
    try {
      records = parseSession(readSession(path))
    } catch (error) {
      if (VERBOSE) console.error(`skip ${path}: ${error.message}`)
      continue
    }
    const startedAt = sessionStartedAt(records)
    if (SINCE !== undefined && (startedAt === undefined || startedAt < SINCE)) {
      skippedBySince++
      continue
    }
    const row = { id, startedAt, ...census(records) }
    if (row.requests < 2) continue
    rows.push(row)
  }

  const withChanges = rows.filter(row => row.changes.length > 0)
  const additive = withChanges.filter(row => row.changes.every(change => change.removed.length === 0))
  const subtractive = withChanges.filter(row => row.changes.some(change => change.removed.length > 0))

  if (AS_JSON) {
    console.log(JSON.stringify({
      root: ROOT,
      since: SINCE === undefined ? undefined : new Date(SINCE).toISOString(),
      session: ONLY_SESSION,
      skippedBySince,
      skippedBySession,
      sessionsAnalysed: rows.length,
      sessionsWithChanges: withChanges.length,
      rows,
    }, null, 2))
    return
  }

  console.log(`sessions analysed:        ${rows.length}`)
  console.log(`root:                     ${ROOT}`)
  if (SINCE !== undefined) console.log(`started at/after:         ${new Date(SINCE).toISOString()} (${skippedBySince} older session(s) skipped)`)
  if (ONLY_SESSION !== undefined) console.log(`session filter:           ${ONLY_SESSION} (${skippedBySession} other session(s) skipped)`)
  console.log(`sessions with a change:   ${withChanges.length}`)
  console.log(`  additive only           ${additive.length}`)
  console.log(`  at least one removal    ${subtractive.length}`)
  console.log()

  if (withChanges.length > 0) {
    console.log('changes (newest session first)')
    for (const row of [...withChanges].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))) {
      console.log(`  ${row.id}  preset=${row.preset ?? '?'}  ${row.cwd ?? ''}`)
      for (const change of row.changes) {
        const when = typeof change.at === 'number' ? new Date(change.at).toISOString() : '?'
        console.log(`    ${when}  ${String(change.tools).padStart(3)} tools  reason=${change.reason ?? '?'}`)
        if (change.added.length > 0) console.log(`      + ${change.added.join(' ')}`)
        if (change.removed.length > 0) console.log(`      - ${change.removed.join(' ')}`)
      }
    }
    console.log()
  }

  if (VERBOSE) {
    console.log('per session (newest first)')
    for (const row of [...rows].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))) {
      const when = row.startedAt === undefined ? 'unknown' : new Date(row.startedAt).toISOString()
      const reasons = [...new Set(row.changes.map(change => change.reason ?? '?'))]
      const span = row.firstRequestAt === undefined
        ? ''
        : `  requests ${new Date(row.firstRequestAt).toISOString()} .. ${new Date(row.lastRequestAt).toISOString()}`
      console.log(`  ${String(row.changes.length).padStart(3)} changes  ${String(row.requests).padStart(3)} requests  ${when}  ${(row.preset ?? '?').padEnd(9)} ${row.id}${span}${reasons.length === 0 ? '' : `  [${reasons.join(',')}]`}`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
