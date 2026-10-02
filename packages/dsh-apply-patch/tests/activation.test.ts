/**
 * Guards on the plugin's activation contract.
 *
 * Cordis resolves `ctx.<name>` only for injected services and throws on an
 * undeclared read. That failure does not stop the harness booting: it prints a
 * warning and runs without the plugin, so every other test can pass while the
 * plugin is silently dead in a real session.
 *
 * Both of these were written after a live boot caught exactly that.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { planPatch } from '../src/apply.ts'
import { parsePatch } from '../src/parser.ts'
import { inject, name, OUTPUT_SCHEMA } from '../src/index.ts'

describe('activation contract', () => {
  it('declares every service it reads', () => {
    assert.equal(name, 'apply-patch')
    // `systemPrompt` is easy to forget because it is only touched once, when
    // registering the tool's guidance section.
    assert.deepEqual([...inject].sort(), ['fs', 'systemPrompt', 'tools'])
  })

  it('reads no service it did not inject', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    // Plain Context methods are not services and need no declaration.
    const methods = new Set(['on', 'logger', 'emit', 'waterfall', 'inject', 'get', 'effect'])
    const allowed = new Set([...inject, ...methods])
    const read = [...source.matchAll(/\bctx\.([a-zA-Z_$][\w$]*)/g)].map(match => match[1])
    const undeclared = [...new Set(read)].filter(property => !allowed.has(property))
    assert.deepEqual(undeclared, [], `read without inject: ${undeclared.join(', ')}`)
  })
})

describe('output schema', () => {
  /** Plan a patch over an in-memory file map. */
  const plan = (text: string, files: Record<string, string> = {}) =>
    planPatch(parsePatch(text), path => files[path])

  /** Property names declared on a schema node. */
  const declared = (node: unknown): string[] =>
    Object.keys((node as { properties?: Record<string, unknown> }).properties ?? {})

  const filesNode = (OUTPUT_SCHEMA as { properties: { files: { items: unknown } } }).properties.files.items

  // The registry validates the result against this schema. A property the tool
  // returns but does not declare fails the call AFTER the write has landed, so
  // the model is told the edit failed when it succeeded and retries it. That
  // happened once; this is the check that stops it recurring.
  it('declares every property a planned change carries', () => {
    const result = plan('*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch\n', { 'a.txt': 'a\n' })
    const returned = Object.keys(result.changes[0])
    const undeclared = returned.filter(key => !declared(filesNode).includes(key))
    assert.deepEqual(undeclared, [], `returned but not declared: ${undeclared.join(', ')}`)
  })

  it('declares every property a hunk outcome carries', () => {
    const result = plan('*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** End Patch\n', { 'a.txt': 'a\n' })
    const matchesNode = (filesNode as { properties: { matches: { items: unknown } } }).properties.matches.items
    const returned = Object.keys(result.changes[0].matches[0])
    const undeclared = returned.filter(key => !declared(matchesNode).includes(key))
    assert.deepEqual(undeclared, [], `returned but not declared: ${undeclared.join(', ')}`)
  })

  it('closes the root and each change, so an undeclared property is an error not a shrug', () => {
    assert.equal((OUTPUT_SCHEMA as { additionalProperties?: unknown }).additionalProperties, false)
    assert.equal((filesNode as { additionalProperties?: unknown }).additionalProperties, false)
  })
})
