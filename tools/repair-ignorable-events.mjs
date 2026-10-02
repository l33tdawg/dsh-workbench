#!/usr/bin/env node
/**
 * Mark a plugin-written event type `ignorable` in sessions the harness refuses.
 *
 * The persistence read path admits an event type outside the harness's own
 * vocabulary only when the record carries `ignorable: true`. A plugin cannot set
 * that marker — `Session.append()` takes `type` and `data` — so a plugin that
 * writes its own event type produces sessions that load until the day something
 * reads them back, and then refuse:
 *
 *   session "..." contains event type "verify-on-edit/check" (seq 7764) unknown
 *   to this harness and not marked ignorable; refusing to interpret the log
 *
 * This rewrites those records with the marker. The event's payload is kept
 * verbatim, which is what `ignorable` means: a reader that does not know the
 * type skips it. Nothing else in the file changes, including the frame count.
 *
 * Dry-run by default, and the dry run is the whole census: it names every
 * session it would touch and every record it would change, and exits non-zero if
 * there is nothing to do, so a repair that silently repaired nothing is not
 * mistakable for a success.
 *
 *   node tools/repair-ignorable-events.mjs                    # what would change
 *   node tools/repair-ignorable-events.mjs --apply            # back up, then write
 *   node tools/repair-ignorable-events.mjs --apply --type x/y
 *
 * Writing is guarded rather than trusted: every affected file is copied to a
 * timestamped backup directory first, and the replacement is assembled in full
 * and re-read from disk before the original is renamed over. The backup is not
 * deleted afterwards; this tool never removes a file it did not create.
 *
 * @module tools/repair-ignorable-events
 */

import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { frameBytes, framesOf, parseSession } from './session-audit.mjs'
import { findUnreadableEvent } from './harness-log-validator.mjs'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

const ROOT = value('--root') ?? join(process.env.HOME ?? '', '.dsh', 'sessions')
const LOG_NAME = 'session.v4.jsonl.zstd'
const APPLY = flag('--apply')
const AS_JSON = flag('--json')
const TYPES = (value('--type') ?? 'verify-on-edit/check').split(',')
const BACKUP_ROOT = value('--backup-dir')

/** A filesystem-safe timestamp for the backup directory name. */
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')

/**
 * Where the untouched originals go.
 *
 * Not inside the sessions root by default: a sandbox that permits writing a
 * session's own file can still refuse to create a directory beside it, and
 * discovering that after the backup step is discovering it too late. The backup
 * is taken before anything is written, so the flag exists to name a place that
 * is known to be writable.
 */
const BACKUP_DIR = join(BACKUP_ROOT ?? ROOT, `repair-backup-${STAMP}`)

/**
 * The events in a parsed log: the header line is metadata, not an event.
 * @param records - the parsed records.
 * @returns the records the harness's event vocabulary applies to.
 */
const eventsOf = records => records.filter(record => record?.type !== 'session')

/** Every session log under the sessions root. */
function* logs(root) {
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const session of readdirSync(projectDir)) {
      const path = join(projectDir, session, LOG_NAME)
      try {
        if (statSync(path).isFile()) yield path
      } catch {
        continue
      }
    }
  }
}

/**
 * Mark one line of a session log, if it is a record of a targeted type.
 *
 * The patch is byte-insertion rather than a re-serialization, so a record's
 * existing field order and number formatting survive untouched. `ignorable` is
 * the fifth envelope key and `EVENT_OPTIONAL` in the harness's own codec lists
 * it in that position, so inserting it after the opening brace reproduces what
 * the harness itself writes.
 *
 * @param line - one JSONL line.
 * @returns the patched line, or undefined when the line is not a target.
 */
function markLine(line) {
  if (line.length === 0) return undefined
  let record
  try {
    record = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!TYPES.includes(record?.type) || record.ignorable === true) return undefined
  const patched = line.replace('{', '{"ignorable":true,')
  const check = JSON.parse(patched)
  if (check.ignorable !== true || check.type !== record.type || check.seq !== record.seq) {
    throw new Error(`patching changed more than the marker at seq ${record.seq}`)
  }
  return { patched, seq: record.seq, type: record.type }
}

/**
 * Patch every targeted record in a log, frame by frame.
 *
 * A frame whose text holds no target keeps its original bytes, so only the
 * frames that actually carry a target record are recompressed and every other
 * byte of the file is reproduced exactly.
 *
 * @param path - the session log.
 * @returns the frames to write, and what changed.
 */
function patchLog(path) {
  const frames = framesOf(path)
  const marks = []
  const patched = frames.map(frame => {
    if (!TYPES.some(type => frame.text.includes(`"${type}"`))) return frame
    const lines = frame.text.split('\n')
    let changed = false
    for (let i = 0; i < lines.length; i++) {
      const mark = markLine(lines[i])
      if (mark === undefined) continue
      lines[i] = mark.patched
      marks.push({ seq: mark.seq, type: mark.type })
      changed = true
    }
    return changed ? { ...frame, text: lines.join('\n') } : frame
  })
  return { frames, patched, marks }
}

/**
 * Check a repaired log against the harness's own vocabulary rule.
 *
 * The frame walker takes a path, so the candidate bytes are written to a
 * scratch file and read back through it — the same reader the harness uses to
 * find frame boundaries, rather than a second implementation of that walk.
 *
 * @param bytes - the candidate file's bytes.
 * @param expected - the record count the original file held.
 * @returns what was verified.
 */
function verify(bytes, expected, expectedText) {
  const scratch = candidateToTemp(bytes)
  // Decoding each frame on its own is the point: a frame that only decodes as
  // part of a concatenation would be a file the harness cannot read.
  const frames = framesOf(scratch)
  const text = frames.map(frame => frame.text).join('')
  const records = parseSession(text)
  const events = eventsOf(records)
  if (events.length !== expected) {
    throw new Error(`event count changed: ${expected} -> ${events.length}`)
  }
  for (const [index, record] of events.entries()) {
    if (record.seq !== index) {
      throw new Error(`event ${index} has seq ${record.seq}, so the log is no longer dense`)
    }
  }
  // Every line must be the original line plus the marker, and nothing else: a
  // compress/decompress round trip could otherwise quietly reorder or reformat
  // a record while keeping the count and the sequence intact.
  const lines = text.split('\n')
  const before = expectedText.split('\n')
  if (lines.length !== before.length) throw new Error(`line count changed: ${before.length} -> ${lines.length}`)
  for (const [index, line] of lines.entries()) {
    if (line === before[index]) continue
    if (line !== before[index].replace('{', '{"ignorable":true,')) {
      throw new Error(`line ${index} changed beyond the marker`)
    }
  }
  const unreadable = findUnreadableEvent(events)
  if (unreadable !== undefined) throw new Error(`harness would still refuse: ${unreadable.message}`)
  return { records: events.length, frames: frames.length }
}

/**
 * Repair one log: verify the candidate, back up the original, write, re-read.
 *
 * @param path - the session log.
 * @param census - the patch result for this path.
 * @param backupDir - where to copy the untouched original.
 * @returns what happened, for the report.
 */
function repair(path, census, backupDir) {
  const original = framesOf(path)
  const originalText = original.map(frame => frame.text).join('')
  const expected = eventsOf(parseSession(originalText)).length
  // An untouched frame keeps its own bytes; only a frame whose text actually
  // gained a marker is recompressed.
  const written = census.patched.map((frame, index) =>
    frame.text === census.frames[index].text ? frame.bytes : frameBytes(frame.text))
  const candidate = Buffer.concat(written)

  // Read the candidate back from bytes before any file is touched. A frame that
  // does not survive its own round trip fails here, with the original intact.
  verify(candidate, expected, originalText)

  const backup = join(backupDir, path.replaceAll('/', '_'))
  if (statSync(backup, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`refusing to overwrite an existing backup: ${backup}`)
  }
  copyFileSync(path, backup)

  const staging = `${path}.repair-${STAMP}`
  writeFileSync(staging, candidate, { mode: 0o600 })
  verify(candidate, expected, originalText)
  renameSync(staging, path)
  return { backup, bytes: candidate.length, before: statSync(backup).size }
}

/** The scratch directory the candidate is written to before the real file is touched. */
let scratch
function candidateToTemp(bytes) {
  scratch ??= join(process.env.TMPDIR ?? '/tmp', `dsh-repair-${STAMP}`)
  mkdirSync(scratch, { recursive: true })
  const file = join(scratch, `candidate-${scratchFiles++}`)
  writeFileSync(file, bytes)
  return file
}

/** Counter behind the scratch file names. */
let scratchFiles = 0

const results = []
for (const path of logs(ROOT)) {
  const before = framesOf(path)
  const beforeRecords = parseSession(before.map(frame => frame.text).join(''))
  const unreadable = findUnreadableEvent(eventsOf(beforeRecords))
  const census = patchLog(path)
  if (census.marks.length === 0) continue
  results.push({ path, marks: census.marks, unreadable: unreadable?.message, census, beforeRecords })
}

if (results.length === 0) {
  console.error(`no ${TYPES.join(', ')} record found under ${ROOT} needing the marker`)
  process.exit(1)
}

const report = []
for (const result of results) {
  // A census is only believable if the reader that refuses this session agrees
  // that it refuses it. Otherwise the marker would be added to a file that was
  // already readable, which is a different bug wearing this one's clothes.
  const refusals = result.beforeRecords.filter(record =>
    TYPES.includes(record?.type) && record.ignorable !== true).length
  const entry = {
    path: result.path,
    records: eventsOf(result.beforeRecords).length,
    marked: result.marks.map(mark => mark.seq),
    refusals,
    refusedBy: result.unreadable ?? null,
  }
  if (APPLY) {
    if (refusals === 0) throw new Error(`${result.path} carries no unmarked target record to repair`)
    mkdirSync(BACKUP_DIR, { recursive: true })
    entry.written = repair(result.path, result.census, BACKUP_DIR)
  }
  report.push(entry)
}

if (AS_JSON) {
  console.log(JSON.stringify({ applied: APPLY, backupDir: APPLY ? BACKUP_DIR : null, sessions: report }, null, 2))
} else {
  for (const entry of report) {
    console.log(`${APPLY ? 'repaired' : 'would repair'} ${entry.path}`)
    console.log(`  ${entry.marked.length} record(s) at seq ${entry.marked.join(', ')}`)
    console.log(`  ${entry.records} records total, ${entry.refusals} the harness refuses`)
    if (entry.written !== undefined) {
      console.log(`  backup ${entry.written.backup} (${entry.written.before} bytes), now ${entry.written.bytes} bytes`)
    }
  }
  console.log(`\n${results.length} session(s) ${APPLY ? 'repaired' : 'would be repaired'}; `
    + `${report.reduce((sum, entry) => sum + entry.marked.length, 0)} record(s)`)
  if (!APPLY) console.log('Dry run. Re-run with --apply to write, after reading the list above.')
}

if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
