#!/usr/bin/env node
/**
 * Count the model-facing skill catalogs across recorded DSH sessions.
 *
 * The `cordis` preset loses the whole skill catalog: the model never learns
 * which skills exist, while `skill("<name>")` still loads any of them by name.
 * That is a harness defect, not a model one, and the evidence for it is a
 * count - sessions of one preset carry a catalog message, sessions of another
 * carry none - so the count is what this tool prints.
 *
 * A catalog is a durable `user/message` whose `source.kind` is `skill-catalog`,
 * written by `@deepseek-ai/dsh-tool-skill` on `agent/pre-step`. Its source
 * carries the catalog entries, so the first catalog of a session also names the
 * skills the model was told about.
 *
 * Sessions are the unit rather than messages, because one session republishing
 * its catalog after a skills change is normal and would inflate a message count.
 *
 * Usage:
 *   node skill-catalog-census.mjs [--root <sessions dir>] [--since <date>]
 *                                 [--preset <id>] [--json] [--verbose]
 *
 *   --since   keep only sessions that STARTED at or after this instant, so the
 *             corpus splits at an install time instead of by a hand-run script
 *   --preset  keep only sessions whose recorded agent preset matches exactly
 *
 * @module dsh-skill-catalog-census
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
const ONLY_PRESET = value('--preset')

/**
 * The `--since` instant, or undefined when the flag is absent.
 *
 * An unparseable value is rejected rather than ignored: silently widening the
 * corpus would make a post-fix measurement read as a pre-fix one, which is the
 * mistake this flag exists to prevent.
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

/** Every `session.v4.jsonl.zstd` under `root`, deepest first is irrelevant here. */
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

/** The durable session header, or undefined when the file has none yet. */
function header(records) {
  for (const record of records) {
    if (record?.type === 'session') return record
  }
  return undefined
}

/**
 * Catalog messages in one session, plus the skill names the first one listed.
 * @param records - the session's parsed records.
 * @returns catalog count, the names of the first catalog, and its workspace.
 */
export function census(records) {
  let catalogs = 0
  let names
  let updates = 0
  for (const record of records) {
    if (record?.type !== 'user/message') continue
    const source = record.data?.source
    if (source?.kind !== 'skill-catalog') continue
    catalogs += 1
    if (source.update === true) updates += 1
    if (names === undefined && Array.isArray(source.entries)) {
      names = source.entries.map(entry => entry?.name).filter(name => typeof name === 'string')
    }
  }
  const head = header(records)
  return {
    catalogs,
    updates,
    names,
    preset: typeof head?.agentPreset === 'string' ? head.agentPreset : undefined,
    cwd: typeof head?.cwd === 'string' ? head.cwd : undefined,
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
  let skippedByPreset = 0
  for (const path of files) {
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
    const row = { id: path.split('/').slice(-2)[0], startedAt, ...census(records) }
    if (ONLY_PRESET !== undefined && row.preset !== ONLY_PRESET) {
      skippedByPreset++
      continue
    }
    rows.push(row)
  }

  const byPreset = new Map()
  for (const row of rows) {
    const key = row.preset ?? '(no preset recorded)'
    const group = byPreset.get(key) ?? { preset: key, sessions: 0, withCatalog: 0, catalogs: 0 }
    group.sessions += 1
    if (row.catalogs > 0) group.withCatalog += 1
    group.catalogs += row.catalogs
    byPreset.set(key, group)
  }
  const groups = [...byPreset.values()].sort((a, b) => b.sessions - a.sessions)

  const spread = { none: 0, one: 0, many: 0 }
  for (const row of rows) {
    if (row.catalogs === 0) spread.none += 1
    else if (row.catalogs === 1) spread.one += 1
    else spread.many += 1
  }

  if (AS_JSON) {
    console.log(JSON.stringify({
      root: ROOT,
      since: SINCE === undefined ? undefined : new Date(SINCE).toISOString(),
      preset: ONLY_PRESET,
      skippedBySince,
      skippedByPreset,
      sessions: rows.length,
      spread,
      byPreset: groups,
      rows,
    }, null, 2))
    return
  }

  console.log(`sessions analysed: ${rows.length}`)
  console.log(`root:              ${ROOT}`)
  if (SINCE !== undefined) {
    console.log(`started at/after:  ${new Date(SINCE).toISOString()} (${skippedBySince} older session(s) skipped)`)
  }
  if (ONLY_PRESET !== undefined) {
    console.log(`preset filter:     ${ONLY_PRESET} (${skippedByPreset} other session(s) skipped)`)
  }
  console.log()
  console.log('skill catalog by preset')
  const width = Math.max(6, ...groups.map(group => group.preset.length))
  console.log(`  ${'preset'.padEnd(width)}  sessions  with catalog  catalogs`)
  for (const group of groups) {
    console.log(`  ${group.preset.padEnd(width)}  ${String(group.sessions).padStart(8)}  ${String(group.withCatalog).padStart(12)}  ${String(group.catalogs).padStart(8)}`)
  }
  console.log()
  console.log('catalogs per session')
  console.log(`  none    ${String(spread.none).padStart(5)}`)
  console.log(`  one     ${String(spread.one).padStart(5)}`)
  console.log(`  two or more ${String(spread.many).padStart(3)}`)

  if (VERBOSE) {
    console.log()
    console.log('per session (newest first)')
    for (const row of [...rows].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 25)) {
      const when = row.startedAt === undefined ? 'unknown' : new Date(row.startedAt).toISOString()
      const names = row.names === undefined ? '' : ` [${row.names.join(', ')}]`
      console.log(`  ${String(row.catalogs).padStart(3)}  ${(row.preset ?? '?').padEnd(9)} ${when}  ${row.id}${names}`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
