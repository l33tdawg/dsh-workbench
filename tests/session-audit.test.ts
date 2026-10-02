/**
 * The session audit has to be trustworthy before its number can decide
 * anything, because two decision rules already point at that number: cut the
 * guidance pack's editing rule if `read-after-edit` falls, and cut
 * `dsh-edit-feedback` if it does not. A measurement that cannot separate one
 * session's burst from a corpus-wide change would answer the wrong question
 * confidently.
 *
 * These tests cover the two additions that make that separation possible:
 * `--since`, which splits a corpus at an install time, and the per-session
 * distribution, which reports when a single session carries the pooled rate.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { after, describe, it } from 'node:test'
import { audit, distribution, sessionStartedAt } from '../tools/session-audit.mjs'

const AUDIT = fileURLToPath(new URL('../tools/session-audit.mjs', import.meta.url))

/** One `tool/call` record as the session log writes it. */
const call = (callId, name, args) => ({
  type: 'tool/call',
  seq: 1,
  time: 1000,
  data: { callId, name, arguments: JSON.stringify(args) },
})

/** One `tool/result` record, successful unless `isError`. */
const result = (callId, isError = false) => ({
  type: 'tool/result',
  seq: 2,
  time: 1001,
  data: { message: { toolCallId: callId, isError, content: [{ type: 'text', text: 'ok' }] } },
})

describe('audit', () => {
  it('counts rework once, at the third edit, and not on the fourth', () => {
    const counts = audit([
      call('1', 'edit', { file_path: 'a.ts' }),
      call('2', 'edit', { file_path: 'a.ts' }),
      call('3', 'edit', { file_path: 'a.ts' }),
      call('4', 'edit', { file_path: 'a.ts' }),
    ])
    assert.equal(counts.rework, 1)
    assert.equal(counts.toolCalls, 4)
  })

  it('counts a read only after this session edited the file', () => {
    const before = audit([
      call('1', 'read', { file_path: 'a.ts' }),
      call('2', 'edit', { file_path: 'a.ts' }),
    ])
    assert.equal(before.readAfterEdit, 0, 'a read before the edit is not re-work')

    const after = audit([
      call('1', 'edit', { file_path: 'a.ts' }),
      call('2', 'read', { file_path: 'a.ts' }),
    ])
    assert.equal(after.readAfterEdit, 1)
  })

  it('counts an unchanged retry only when the previous call failed', () => {
    const unchanged = [
      call('1', 'bash', { command: 'npm test' }),
      call('2', 'bash', { command: 'npm test' }),
    ]
    assert.equal(audit(unchanged).repeatCall, 1, 'back-to-back identical calls are repetition')
    assert.equal(audit(unchanged).retryAfterFail, 0, 'no failure, so no retry')

    const failed = [
      call('1', 'bash', { command: 'npm test' }),
      result('1', true),
      call('2', 'bash', { command: 'npm test' }),
    ]
    assert.equal(audit(failed).retryAfterFail, 1)
  })

  it('reports zero events for a session that did nothing twice', () => {
    const counts = audit([
      call('1', 'read', { file_path: 'a.ts' }),
      call('2', 'edit', { file_path: 'b.ts' }),
      call('3', 'read', { file_path: 'c.ts' }),
    ])
    assert.equal(counts.undoEvents, 0)
  })
})

describe('sessionStartedAt', () => {
  it('reads the creation instant from the header record', () => {
    assert.equal(sessionStartedAt([{ type: 'session', createdAt: 1790933493945 }]), 1790933493945)
  })

  it('falls back to the event time when a record carries no creation instant', () => {
    assert.equal(sessionStartedAt([{ type: 'user/message', time: 42 }]), 42)
  })

  it('returns undefined rather than guessing', () => {
    assert.equal(sessionStartedAt([]), undefined)
    assert.equal(sessionStartedAt([{ type: 'session' }]), undefined)
  })
})

describe('distribution', () => {
  const row = (id, toolCalls, undoEvents) => ({ id, toolCalls, undoEvents })

  it('reports when one session carries the corpus', () => {
    const shape = distribution([
      row('burst', 100, 20),
      row('quiet-1', 100, 0),
      row('quiet-2', 100, 0),
      row('quiet-3', 100, 0),
      row('quiet-4', 100, 0),
    ])
    assert.equal(shape.sessions, 5)
    assert.equal(shape.withNoUndoEvents, 4)
    assert.equal(shape.shareFromTopSession, 1)
    assert.equal(shape.p50Per100, 0, 'the median session is a quiet one')
    assert.equal(shape.worst.id, 'burst')
    assert.equal(shape.worst.per100, 20)
  })

  it('reports an even corpus as even', () => {
    const shape = distribution([row('a', 100, 5), row('b', 100, 5), row('c', 100, 5), row('d', 100, 5)])
    assert.equal(shape.withNoUndoEvents, 0)
    assert.equal(shape.shareFromTopSession, 0.25)
    assert.equal(shape.p90Per100, 5)
  })

  it('does not divide by zero on a corpus of empty sessions', () => {
    const shape = distribution([row('empty', 0, 0)])
    assert.equal(shape.p50Per100, 0)
    assert.equal(shape.worst.per100, 0)
    assert.equal(shape.shareFromTopSession, 0)
  })
})

describe('--since on the command line', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  /**
   * Write a session whose header carries `createdAt`, so the split has a real
   * instant to read. One call and one read-after-edit keeps the audit non-empty.
   */
  const writeSession = (id, createdAt) => {
    const dir = join(root, `--workspace--`, id)
    mkdirSync(dir, { recursive: true })
    const records = [
      { type: 'session', version: 4, id, createdAt, cwd: '/tmp' },
      call('call-1', 'edit', { file_path: 'a.ts' }),
      call('call-2', 'read', { file_path: 'a.ts' }),
    ]
    const text = `${records.map(record => JSON.stringify(record)).join('\n')}\n`
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(text, 'utf8')))
  }

  const older = Date.parse('2026-01-01T00:00:00Z')
  const newer = Date.parse('2026-06-01T00:00:00Z')
  writeSession('session-older', older)
  writeSession('session-newer', newer)

  const run = extra => execFileSync('node', [AUDIT, '--root', root, '--json', ...extra], { encoding: 'utf8' })

  it('includes every session when --since is absent', () => {
    const report = JSON.parse(run([]))
    assert.equal(report.sessions, 2)
    assert.equal(report.since, undefined)
    assert.equal(report.skippedBySince, 0)
  })

  it('keeps only sessions that started at or after the instant', () => {
    const report = JSON.parse(run(['--since', '2026-03-01T00:00:00Z']))
    assert.equal(report.sessions, 1)
    assert.equal(report.skippedBySince, 1)
    assert.equal(report.rows[0].id, 'session-newer')
    assert.equal(report.since, '2026-03-01T00:00:00.000Z')
  })

  it('carries the distribution into JSON so a comparison can read it', () => {
    const report = JSON.parse(run(['--since', '2026-03-01T00:00:00Z']))
    assert.equal(report.distribution.sessions, 1)
    assert.equal(report.distribution.withNoUndoEvents, 0)
    assert.equal(report.distribution.worst.id, 'session-newer')
  })

  it('refuses an unparseable instant instead of widening the corpus', () => {
    assert.throws(
      () => execFileSync('node', [AUDIT, '--root', root, '--since', 'last tuesday'], { encoding: 'utf8', stdio: 'pipe' }),
      error => error.status === 2 && /--since is not a date/.test(String(error.stderr)),
    )
  })
})

describe('readSession', () => {
  it('decompresses every frame, not only the first', async () => {
    const { readSession } = await import('../tools/session-audit.mjs')
    const root = mkdtempSync(join(tmpdir(), 'dsh-audit-frames-'))
    after(() => rmSync(root, { recursive: true, force: true }))
    const path = join(root, 'session.v4.jsonl.zstd')
    // The header is its own frame in a real log. A reader that took only the
    // first frame would see the header and report an empty session.
    const frames = [
      Buffer.from('{"type":"session","createdAt":5}\n', 'utf8'),
      Buffer.from('{"type":"tool/call","data":{"callId":"1","name":"read"}}\n', 'utf8'),
    ]
    writeFileSync(path, Buffer.concat(frames.map(frame => zstdCompressSync(frame))))
    const text = readSession(path)
    assert.match(text, /tool\/call/)
    assert.match(text, /"createdAt":5/)
  })
})
