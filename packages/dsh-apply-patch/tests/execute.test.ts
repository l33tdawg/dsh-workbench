/**
 * Integration tests for the tool's execution path.
 *
 * These exist because a live session found what the other suites could not: the
 * tool worked in isolation but wrote through the wrong sandbox root, because it
 * passed no policy to the provider. Every unit test still passed.
 *
 * A fake context captures exactly what the tool hands to `ctx.fs`, so the
 * contract with the provider is asserted rather than assumed.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply, resolveSessionPolicy, resolveOptions } from '../src/index.ts'

/** Capture what the tool passes to the filesystem service. */
function harness({ policy, contents = {} }: { policy?: unknown, contents?: Record<string, string> } = {}) {
  const calls: {
    write?: { target: unknown, content: string, intent: unknown, signal: unknown, policy: unknown }
    observed: { target: unknown, observation: unknown }[]
  } = { observed: [] }
  let registered: { execute: (args: unknown, exec: unknown) => Promise<unknown>, name: string } | undefined

  const ctx = {
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    tools: { register: (tool: unknown) => { registered = tool as typeof registered; return () => {} }, get: () => ({}) },
    get: (name: string) => (name === 'sandboxPolicy' && policy !== undefined
      ? { resolve: () => policy }
      : undefined),
    fs: {
      resolve: async (path: string, options?: { cwd?: string }) => ({ path, cwd: options?.cwd }),
      readText: async (target: { path: string }) => {
        const content = contents[target.path]
        if (content === undefined) {
          const error = new Error('missing') as Error & { code: string }
          error.code = 'FS_NOT_FOUND'
          throw error
        }
        return content
      },
      writeText: async (target: unknown, content: string, intent: unknown, signal: unknown, sandboxPolicy: unknown) => {
        calls.write = { target, content, intent, signal, policy: sandboxPolicy }
        return { operation: 'update', version: 'v-after-write' }
      },
    },
    waterfall: async () => undefined,
    emit: (event: string, target: unknown, observation: unknown) => {
      if (event === 'fs/observed') calls.observed.push({ target, observation })
    },
  }

  apply(ctx as never)
  assert.ok(registered !== undefined, 'the plugin registered no tool')
  return { calls, tool: registered, ctx }
}

/** A minimal exec context, shaped as the registry passes one. */
function exec(cwd = '/repo') {
  return { agent: { session: { header: { cwd }, id: 's1' } }, signal: undefined }
}

describe('resolveSessionPolicy', () => {
  it('resolves through the service with the calling session', () => {
    let sawSession: unknown
    const policy = resolveSessionPolicy(
      { get: () => ({ resolve: (input: { session?: unknown }) => { sawSession = input.session; return { mode: 'workspace-write', workspaceRoot: '/ws' } } }) },
      exec('/ws'),
    )
    assert.deepEqual(policy, { mode: 'workspace-write', workspaceRoot: '/ws' })
    assert.deepEqual(sawSession, { header: { cwd: '/ws' }, id: 's1' })
  })

  it('returns nothing when the composition mounts no policy service', () => {
    assert.equal(resolveSessionPolicy({ get: () => undefined }, exec()), undefined)
    assert.equal(resolveSessionPolicy({}, exec()), undefined)
  })

  it('returns nothing when the mounted service exposes no resolve', () => {
    assert.equal(resolveSessionPolicy({ get: () => ({}) }, exec()), undefined)
  })

  it('returns nothing when the service cannot resolve, rather than throwing', () => {
    const policy = resolveSessionPolicy({ get: () => ({ resolve: () => { throw new Error('no policy') } }) }, exec())
    assert.equal(policy, undefined)
  })
})

describe('resolveOptions', () => {
  it('prefers the policy workspace root over the session cwd', () => {
    assert.equal(resolveOptions(exec('/session'), { workspaceRoot: '/policy' }).cwd, '/policy')
  })

  it('falls back to the session cwd without a policy', () => {
    assert.equal(resolveOptions(exec('/session'), undefined).cwd, '/session')
    assert.equal(resolveOptions(exec('/session'), {}).cwd, '/session')
  })
})

describe('execute', () => {
  // The bug a live session found: without a stamped policy the provider applies
  // its own default root, which is the process directory rather than the
  // session's. A write inside the workspace is then refused.
  it('stamps the resolved policy onto every write', async () => {
    const policy = { mode: 'workspace-write', workspaceRoot: '/repo' }
    const { calls, tool } = harness({ policy, contents: { 'a.txt': 'alpha\n' } })
    await tool.execute({ patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+beta\n*** End Patch' }, exec('/repo'))
    assert.deepEqual(calls.write?.policy, policy, 'the provider must receive the session policy')
  })

  it('resolves paths against the policy workspace root', async () => {
    const policy = { mode: 'workspace-write', workspaceRoot: '/policy-root' }
    const { calls, tool } = harness({ policy, contents: { 'a.txt': 'alpha\n' } })
    await tool.execute({ patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+beta\n*** End Patch' }, exec('/session-root'))
    assert.equal((calls.write?.target as { cwd?: string }).cwd, '/policy-root')
  })

  it('returns a value that matches the declared schema', async () => {
    const { calls, tool } = harness({ contents: { 'a.txt': 'alpha\n' } })
    const value = await tool.execute({ patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+beta\n*** End Patch' }, exec('/repo')) as { files: Record<string, unknown>[] }
    assert.equal(calls.write?.content, 'beta\n')
    assert.deepEqual(
      Object.keys(value.files[0]).sort(),
      ['after', 'before', 'matches', 'operation', 'path', 'target'],
    )
  })

  it('writes nothing when a hunk does not match', async () => {
    const { calls, tool } = harness({ contents: { 'a.txt': 'alpha\n' } })
    await assert.rejects(
      () => tool.execute({ patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-absent\n+beta\n*** End Patch' }, exec('/repo')) as Promise<unknown>,
      /does not match the file/,
    )
    assert.equal(calls.write, undefined, 'a failing patch must not write')
  })

  it('writes nothing for a create that would clobber an existing file', async () => {
    const { calls, tool } = harness({ contents: { 'a.txt': 'existing\n' } })
    await assert.rejects(
      () => tool.execute({ patch: '*** Begin Patch\n*** Add File: a.txt\n+new\n*** End Patch' }, exec('/repo')) as Promise<unknown>,
      /already exists/,
    )
    assert.equal(calls.write, undefined)
  })
})

describe('the post-write observation', () => {
  // `FsObservation` requires a version on `present`, and the next write computes
  // `replaceIfVersion` from it. Emitting without one made a second edit of the
  // same file fail the compare-and-swap with "file changed since it was read",
  // which reads as a concurrent modification rather than as this bug.
  it('carries the version the write produced', async () => {
    const { calls, tool } = harness({ contents: { 'a.txt': 'alpha\n' } })
    await tool.execute({ patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+beta\n*** End Patch' }, exec('/repo'))
    assert.equal(calls.observed.length, 1, 'one observation per written file')
    assert.deepEqual(calls.observed[0].observation, { kind: 'present', version: 'v-after-write' })
  })

  it('emits at most one observation per patch, not one per hunk', async () => {
    const { calls, tool } = harness({ contents: { 'a.txt': 'alpha\nbeta\n' } })
    await tool.execute({
      patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+ALPHA\n@@\n-beta\n+BETA\n*** End Patch',
    }, exec('/repo'))
    assert.equal(calls.observed.length, 1)
  })
})
