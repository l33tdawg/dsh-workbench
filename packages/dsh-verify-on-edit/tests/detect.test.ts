/** Tests for check-plan detection from a project's own declarations. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectCheck } from '../src/detect.ts'
import type { ReadFile } from '../src/detect.ts'

/** Build a reader over a plain object of relative path to content. */
function reader(files: Record<string, string>): ReadFile {
  return path => files[path]
}

describe('detectCheck', () => {
  it('prefers a declared typecheck script over every fallback', () => {
    const plan = detectCheck(reader({
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc -b', test: 'vitest' } }),
      'tsconfig.json': '{}',
      'Cargo.toml': '[package]',
    }))
    assert.equal(plan?.command, 'npm run --silent typecheck')
    assert.equal(plan?.cost, 'fast')
  })

  it('accepts a check:types alias', () => {
    const plan = detectCheck(reader({ 'package.json': JSON.stringify({ scripts: { 'check:types': 'vue-tsc' } }) }))
    assert.equal(plan?.command, 'npm run --silent check:types')
  })

  it('falls back to lint when no type check is declared', () => {
    const plan = detectCheck(reader({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }) }))
    assert.equal(plan?.label, 'lint')
  })

  // `test` is the slowest check and the one most likely to be red for unrelated
  // reasons, so it is opt-in rather than the default the agent has to live with.
  it('skips the test script unless slow checks are enabled', () => {
    const files = { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) }
    assert.equal(detectCheck(reader(files)), undefined)
    assert.equal(detectCheck(reader(files), true)?.command, 'npm run --silent test')
  })

  it('uses tsc when only a tsconfig proves TypeScript is in use', () => {
    const plan = detectCheck(reader({ 'tsconfig.json': '{"compilerOptions":{}}' }))
    assert.equal(plan?.command, 'npx --no-install tsc --noEmit --pretty false')
  })

  it('detects cargo', () => {
    assert.equal(detectCheck(reader({ 'Cargo.toml': '[package]' }))?.label, 'cargo check')
  })

  it('detects go', () => {
    assert.equal(detectCheck(reader({ 'go.mod': 'module x' }))?.label, 'go build')
  })

  it('detects ruff', () => {
    assert.equal(detectCheck(reader({ 'pyproject.toml': '[tool.ruff]' }))?.label, 'ruff')
  })

  // A repository that declares nothing gets nothing. Inventing a command would
  // produce failures the project never agreed to, and the agent would learn to
  // ignore the signal.
  it('returns nothing for a project that declares no check', () => {
    assert.equal(detectCheck(reader({ 'README.md': '# hi' })), undefined)
  })

  it('survives malformed package.json', () => {
    assert.equal(detectCheck(reader({ 'package.json': '{ not json' })), undefined)
  })

  it('survives a package.json with no scripts', () => {
    assert.equal(detectCheck(reader({ 'package.json': '{"name":"x"}' })), undefined)
  })

  it('ignores an empty-string script only if it is a known name', () => {
    const plan = detectCheck(reader({ 'package.json': JSON.stringify({ scripts: { typecheck: '' } }) }))
    assert.equal(plan?.command, 'npm run --silent typecheck')
  })
})
