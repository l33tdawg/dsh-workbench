/**
 * Tests for frame-level log reading, and for the vocabulary check a repair
 * answers to.
 *
 * The frame walker is here because a magic-scanning version of it corrupted a
 * real session during a repair: `28 b5 2f fd` appears inside compressed payload
 * by chance, decoding from there yields plausible text, and the frame count
 * still comes out right. The first case below fails on that implementation and
 * passes on this one, which is the only reason to trust a rewrite.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { frameBytes, framesOf, parseSession, readSession, scanFrames } from '../tools/session-audit.mjs'
import { loadHarnessValidator } from '../tools/harness-log-validator.mjs'

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Write a session file built from frames.
 * @param texts - the decompressed text of each frame.
 * @returns the file path.
 */
function sessionFile(texts) {
  const dir = mkdtempSync(join(tmpdir(), 'frames-'))
  dirs.push(dir)
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(path, Buffer.concat(texts.map(frameBytes)))
  return path
}

/** One JSONL record line. */
const line = record => `${JSON.stringify(record)}\n`

describe('scanFrames', () => {
  it('finds exactly the frames that were written', () => {
    const texts = [line({ type: 'session', id: 's' }), line({ type: 'turn/start', seq: 0, time: 1, data: {} })]
    const path = sessionFile(texts)
    const { frames, tornStart } = scanFrames(readFileSync(path))
    assert.equal(frames.length, 2)
    assert.equal(tornStart, undefined)
    assert.equal(frames[0].start, 0)
    assert.equal(frames.at(-1).end, readFileSync(path).length)
  })

  it('ignores the frame magic when it appears inside a payload', () => {
    // Incompressible content, so the payload keeps a literal copy of the magic
    // and a magic-scanning walker sees a third frame that does not exist.
    const body = Buffer.alloc(64 * 1024)
    for (let i = 0; i < body.length; i++) body[i] = (i * 137 + (i % 251)) & 0xff
    body.set([0x28, 0xb5, 0x2f, 0xfd], 1024)
    const payload = body.toString('latin1')
    const path = sessionFile([line({ type: 'session', id: 's' }), line({ type: 'tool/call', seq: 0, time: 1, data: { payload } })])
    const buffer = readFileSync(path)
    const { frames } = scanFrames(buffer)
    assert.equal(frames.length, 2, 'a magic inside a payload is not a frame')
    assert.equal(buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 1) > 0, true, 'the payload does contain the magic')
    assert.equal(framesOf(path).length, 2)
  })

  it('round-trips every frame it reports', () => {
    const texts = [line({ type: 'session', id: 's' }), line({ type: 'turn/end', seq: 0, time: 1, data: { turn: 1 } })]
    const frames = framesOf(sessionFile(texts))
    assert.deepEqual(frames.map(frame => frame.text), texts)
    assert.deepEqual(frames.map(frame => frame.bytes.length > 0), [true, true])
  })

  it('reports a torn final frame instead of inventing text for it', () => {
    const path = sessionFile([line({ type: 'session', id: 's' })])
    const whole = readFileSync(path)
    const dir = mkdtempSync(join(tmpdir(), 'torn-'))
    dirs.push(dir)
    const torn = join(dir, 'torn.jsonl.zstd')
    writeFileSync(torn, whole.subarray(0, whole.length - 3))
    const { frames, tornStart } = scanFrames(readFileSync(torn))
    assert.deepEqual(frames, [])
    assert.equal(tornStart, 0)
    assert.equal(readSession(torn), '')
  })

  it('reads a multi-frame log back into the records that were written', () => {
    const records = [
      { type: 'session', id: 's' },
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: 'ok' } },
    ]
    const path = sessionFile(records.map(line))
    assert.deepEqual(parseSession(readSession(path)), records)
  })
})

describe('harness vocabulary check', () => {
  const { knownTypes, refuses } = loadHarnessValidator()

  it('reads the harness vocabulary out of the shipped bundle', () => {
    assert.equal(knownTypes.has('tool/call'), true)
    assert.equal(knownTypes.has('agent/inbox/spliced'), true)
    assert.equal(knownTypes.has('verify-on-edit/check'), false)
  })

  it('refuses a foreign type and admits it once marked ignorable', () => {
    const record = { type: 'verify-on-edit/check', seq: 7764, time: 1, data: { outcome: 'no-check' } }
    assert.equal(refuses(record), true)
    assert.equal(refuses({ ...record, ignorable: true }), false)
    assert.equal(refuses({ type: 'tool/call', seq: 0 }), false)
  })
})
