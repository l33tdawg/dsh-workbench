/**
 * Run the harness's own session-log vocabulary check, extracted from the app.
 *
 * Repaired session logs have to satisfy a reader we do not control, and a
 * hand-written imitation of that check proves nothing: it passes exactly when
 * the imitation is wrong in the same way. The refusal that stopped nine
 * sessions loading lives in
 * `@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs` inside
 * `app.asar`, which the installed profile does not expose as an importable
 * package, so this module reads the declaration that decides the question
 * straight out of that file and evaluates it.
 *
 * The extraction is narrow on purpose, and the narrowness is stated rather than
 * implied. `KNOWN_SESSION_EVENT_TYPES` is lifted verbatim, and so is the
 * condition half of `validateStoredEvents`'s per-event vocabulary guard. The
 * rest of that function adopts and freezes events with helpers scoped to the
 * bundle, so it is not lifted; the refusal message is rebuilt here around the
 * extracted condition. This checks vocabulary, which is the whole question a
 * repair answers. It is not a general "would the harness load this log" oracle.
 *
 * @module tools/harness-log-validator
 */

import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** The default location of the shipped bundle on macOS. */
export const DEFAULT_APP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/** Where the session-persistence worker sits inside the archive. */
const WORKER_PATH = '/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs'

/**
 * Read one file out of an asar archive.
 *
 * The format is a JSON header — a `files` tree plus a length prefix — followed
 * by the concatenated file contents, so this needs no dependency to read.
 *
 * @param archive - path to the `.asar` file.
 * @param wanted - absolute path of the member to extract.
 * @returns the member's bytes.
 * @throws when the archive has no such member.
 */
export function readAsarMember(archive, wanted) {
  const all = readFileSync(archive)
  const jsonLength = all.readUInt32LE(12)
  const header = JSON.parse(all.subarray(16, 16 + jsonLength).toString('utf8'))
  const base = 16 + jsonLength
  let node = header
  for (const part of wanted.split('/').filter(Boolean)) {
    node = node?.files?.[part]
    if (node === undefined) throw new Error(`${archive} has no member ${wanted}`)
  }
  if (node.offset === undefined) throw new Error(`${wanted} is a directory, not a file`)
  return all.subarray(base + Number(node.offset), base + Number(node.offset) + node.size)
}

/**
 * Load the harness's known-event vocabulary and its per-event refusal.
 *
 * @param options - `archive` overrides the bundle location, `worker` the member.
 * @returns `knownTypes`, `refusalFor(event)`, and where both came from.
 * @throws when either declaration is missing, so a bundle layout change fails
 *   loudly instead of validating nothing.
 */
export function loadHarnessValidator(options = {}) {
  const archive = options.archive ?? process.env.DSH_APP_ASAR ?? DEFAULT_APP_ASAR
  const worker = options.worker ?? WORKER_PATH
  if (!isAbsolute(archive)) throw new Error(`archive path must be absolute: ${archive}`)
  const source = readAsarMember(archive, worker).toString('utf8')

  const typesAt = source.indexOf('const KNOWN_SESSION_EVENT_TYPES = new Set([')
  if (typesAt === -1) throw new Error(`no KNOWN_SESSION_EVENT_TYPES in ${archive}:${worker}`)
  const typesEnd = source.indexOf(']);', typesAt)
  const guardAt = source.indexOf('if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(')
  if (guardAt === -1) throw new Error(`no vocabulary guard in ${archive}:${worker}`)
  const throwAt = source.indexOf(' throw unsupported(', guardAt)
  // The guard's own parentheses are dropped: `guardAt` is the `if`, so the
  // condition is everything after `if (` up to the close before `throw`.
  const condition = source.slice(source.indexOf('if (', guardAt) + 4, throwAt).trim().replace(/\)$/, '')

  // The message is rebuilt rather than extracted: the extracted call ends at a
  // template literal whose text is the same message, and `unsupported` appends
  // the location in parentheses. Verbatim text is asserted below in the test.
  const refusalFor = event =>
    `session "session-under-test" contains event type "${event?.type}" (seq ${event?.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`

  // eslint-disable-next-line no-new-func
  const knownTypes = new Function(source
    .slice(typesAt, typesEnd + 3)
    .replace('const KNOWN_SESSION_EVENT_TYPES =', 'return'))()
  // eslint-disable-next-line no-new-func
  const refuses = new Function('KNOWN_SESSION_EVENT_TYPES', 'event', `return ${condition}`)
    .bind(undefined, knownTypes)

  return { knownTypes, refuses, refusalFor, archive, worker }
}

/**
 * The first record the harness would refuse, or undefined when it would read
 * the whole log.
 * @param records - parsed event envelopes, in sequence order.
 * @param options - passed through to {@link loadHarnessValidator}.
 * @returns the offending record and the refusal it would raise, when one exists.
 */
export function findUnreadableEvent(records, options = {}) {
  const { refuses, refusalFor } = loadHarnessValidator(options)
  for (const record of records) {
    if (refuses(record)) return { record, message: refusalFor(record) }
  }
  return undefined
}
