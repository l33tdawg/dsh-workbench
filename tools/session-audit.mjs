#!/usr/bin/env node
/**
 * Count undo-class events across recorded DSH sessions.
 *
 * The claim under test is that the harness, not the model, decides whether an
 * agent looks competent. Testing it needs a number that moves when the harness
 * changes and does not move when the model does. This counts four things, all
 * read off the durable session log, all of which mean the agent had to revisit
 * work it had already done:
 *
 *   rework           a file edited three or more times in one session
 *   read-after-edit  a file read after this session already edited it
 *   repeat-call      an identical tool call issued back to back
 *   retry-after-fail an errored call retried with identical arguments
 *
 * None of these is proof of a mistake on its own. A file legitimately edited
 * three times is a refactor. What they measure is rework, and a harness that
 * tells the agent what it broke should reduce it. The number is only meaningful
 * compared against the same corpus under a different harness.
 *
 * Usage:
 *   node session-audit.mjs [--root <sessions dir>] [--json] [--verbose]
 *
 * @module dsh-session-audit
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

const ROOT = value('--root') ?? join(process.env.HOME ?? '', '.dsh', 'sessions')
const AS_JSON = flag('--json')
const VERBOSE = flag('--verbose')

/** Zstd frames start with this magic; a session file is a concatenation of them. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress a multi-frame zstd session log.
 *
 * Node's `zstdDecompressSync` returns only the first frame, which for a session
 * is a 200-byte header. That reads as an empty session rather than an error, so
 * the frames are split on the magic explicitly.
 *
 * @param path - the `.jsonl.zstd` file.
 * @returns the decompressed text.
 */
export function readSession(path) {
  const buf = readFileSync(path)
  const parts = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] !== MAGIC[0] || buf[i + 1] !== MAGIC[1] || buf[i + 2] !== MAGIC[2] || buf[i + 3] !== MAGIC[3]) continue
    try {
      parts.push(zstdDecompressSync(buf.subarray(i)))
    } catch {
      // A magic sequence inside compressed payload, not a frame boundary.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Parse a decompressed session into records, dropping anything malformed. */
export function parseSession(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A truncated tail frame is expected on a live session.
    }
  }
  return records
}

/** The file a filesystem tool call named, if any. */
function pathOf(record) {
  let args
  try {
    args = typeof record.arguments === 'string' ? JSON.parse(record.arguments) : record.arguments
  } catch {
    return undefined
  }
  if (args === null || typeof args !== 'object') return undefined
  const direct = args.file_path ?? args.path
  return typeof direct === 'string' ? direct : undefined
}

const WRITE_TOOLS = new Set(['edit', 'write', 'str_replace_editor'])
const READ_TOOLS = new Set(['read'])

/**
 * Count undo-class events in one session.
 * @param records - the session's parsed records.
 * @returns the counts and the tool-call total they are measured against.
 */
export function audit(records) {
  const calls = []
  for (const record of records) {
    if (record?.type !== 'tool/call') continue
    const data = record.data ?? {}
    let argumentsKey = ''
    try {
      argumentsKey = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? null)
    } catch {
      argumentsKey = '<unserializable>'
    }
    calls.push({
      id: data.callId,
      name: data.name,
      path: pathOf(data),
      key: `${data.name}\u0000${argumentsKey}`,
    })
  }

  // Which calls errored, by call id. Reading this from the result rather than
  // from the following call is what separates "retried because it failed" from
  // "called twice on purpose".
  const failed = new Set()
  for (const record of records) {
    if (record?.type !== 'tool/result') continue
    const data = record.data ?? {}
    const id = data.message?.toolCallId ?? data.callId
    const isError = data.message?.isError === true
      || (Array.isArray(data.message?.content)
        && data.message.content.some(block => block?.type === 'text' && /^\s*Error[:!]/.test(block.text ?? '')))
    if (id !== undefined && isError) failed.add(id)
  }

  const editedCounts = new Map()
  const edits = new Set()
  let rework = 0
  let readAfterEdit = 0
  let repeatCall = 0
  let retryAfterFail = 0

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]

    if (call.name && WRITE_TOOLS.has(call.name) && call.path) {
      const next = (editedCounts.get(call.path) ?? 0) + 1
      editedCounts.set(call.path, next)
      edits.add(call.path)
      // Counted once, at the third edit, so a file edited six times is one
      // rework event rather than four.
      if (next === 3) rework++
    }

    if (call.name && READ_TOOLS.has(call.name) && call.path && edits.has(call.path)) {
      readAfterEdit++
    }

    const previous = calls[i - 1]
    if (previous !== undefined && previous.key === call.key && call.key !== '\u0000') repeatCall++
    // An unchanged retry after a failure is the specific tell: the agent had no
    // new information and tried the same thing anyway.
    if (previous !== undefined
      && previous.key === call.key
      && call.key !== '\u0000'
      && previous.id !== undefined
      && failed.has(previous.id)) {
      retryAfterFail++
    }
  }

  return {
    toolCalls: calls.length,
    filesEdited: edits.size,
    rework,
    readAfterEdit,
    repeatCall,
    retryAfterFail,
    undoEvents: rework + readAfterEdit + repeatCall + retryAfterFail,
  }
}

/** Every session file under a root, largest first. */
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
      else if (entry.name === 'session.v4.jsonl.zstd') {
        try {
          found.push({ path, size: statSync(path).size })
        } catch {
          // Removed between listing and stat.
        }
      }
    }
  }
  walk(root)
  return found.sort((a, b) => b.size - a.size)
}

function main() {
  const files = sessions(ROOT)
  if (files.length === 0) {
    console.error(`no sessions under ${ROOT}`)
    process.exit(2)
  }

  const rows = []
  for (const file of files) {
    try {
      const counts = audit(parseSession(readSession(file.path)))
      if (counts.toolCalls === 0) continue
      rows.push({ id: file.path.split('/').slice(-2)[0], size: file.size, ...counts })
    } catch (error) {
      if (VERBOSE) console.error(`skip ${file.path}: ${error.message}`)
    }
  }

  const total = rows.reduce((acc, row) => {
    for (const key of ['toolCalls', 'filesEdited', 'rework', 'readAfterEdit', 'repeatCall', 'retryAfterFail', 'undoEvents']) {
      acc[key] = (acc[key] ?? 0) + row[key]
    }
    return acc
  }, {})

  if (AS_JSON) {
    console.log(JSON.stringify({ root: ROOT, sessions: rows.length, total, rows }, null, 2))
    return
  }

  console.log(`sessions analysed: ${rows.length}`)
  console.log(`tool calls:        ${total.toolCalls}`)
  console.log()
  console.log('undo-class events')
  console.log(`  rework           ${String(total.rework).padStart(6)}   a file edited 3+ times`)
  console.log(`  read-after-edit  ${String(total.readAfterEdit).padStart(6)}   read after this session edited it`)
  console.log(`  repeat-call      ${String(total.repeatCall).padStart(6)}   identical call back to back`)
  console.log(`  retry-after-fail ${String(total.retryAfterFail).padStart(6)}   unchanged retry`)
  console.log(`  ${'-'.repeat(40)}`)
  console.log(`  total            ${String(total.undoEvents).padStart(6)}`)
  console.log()
  const per100 = total.toolCalls === 0 ? 0 : (100 * total.undoEvents) / total.toolCalls
  console.log(`rate: ${per100.toFixed(1)} undo-class events per 100 tool calls`)
  console.log(`files edited across the corpus: ${total.filesEdited}`)

  if (VERBOSE) {
    console.log()
    console.log('per session (worst first)')
    for (const row of [...rows].sort((a, b) => b.undoEvents - a.undoEvents).slice(0, 15)) {
      console.log(`  ${String(row.undoEvents).padStart(5)}  ${String(row.toolCalls).padStart(5)} calls  ${row.id}`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
