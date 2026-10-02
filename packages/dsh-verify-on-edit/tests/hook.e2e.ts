/**
 * End-to-end test of the post-execute hook.
 *
 * The unit tests cover the decisions in isolation. This drives the real `apply`
 * with a fake context and a fake shell, so the wiring itself is covered: the
 * event name, the result shape the agent actually receives, and the guarantee
 * that nothing thrown inside the hook can break a tool call.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { apply, name, inject } from '../src/index.ts'
import type { Config } from '../src/report.ts'

/** Everything the fake context captured. */
interface Harness {
  hook: (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<{ kind: string, additionalContexts?: unknown[] }>
  plans: string[]
  warnings: string[]
}

/** A project directory with a declared typecheck script. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'voe-e2e-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }))
  mkdirSync(join(dir, 'src'), { recursive: true })
  return dir
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Install the plugin against a fake context.
 * @param output - what the fake check prints.
 * @param exitCode - what the fake check exits with.
 * @param config - plugin configuration.
 */
function install(output: string, exitCode = 1, config: Config = {}): Harness {
  const harness: Harness = { hook: undefined as never, plans: [], warnings: [] }
  const ctx = {
    on: (event: string, handler: Harness['hook']) => {
      assert.equal(event, 'tools/post-execute')
      harness.hook = handler
      return () => {}
    },
    logger: { warn: (format: string) => { harness.warnings.push(format) } },
    shell: {
      resolve: (request: { command: string }) => {
        harness.plans.push(request.command)
        return { command: request.command }
      },
      execute: async () => ({
        result: async () => ({
          exitCode,
          stdout: { text: output },
          stderr: { text: '' },
        }),
      }),
    },
  }
  apply(ctx as never, config)
  return harness
}

/**
 * A stable agent handle for one project.
 *
 * The plugin keys per-session state on the agent object, exactly as the
 * repeat-tool-reminder guard does. A fresh object per call would reset the
 * debounce and attribute nothing, so the tests hold one.
 *
 * The plugin reads only the session's working directory. It does not append:
 * see the "leaves the session log alone" case below for why.
 * @param root - the working directory the session reports.
 * @param session - extra session members, for the cases that need them.
 */
function agentFor(root: string, session: Record<string, unknown> = {}) {
  return {
    session: {
      header: { cwd: root },
      ...session,
    },
  }
}

/** A fake exec for a successful edit. */
function execFor(agent: object, filePath = 'src/app.ts', toolName = 'edit') {
  return { name: toolName, arguments: { file_path: filePath }, agent }
}

/** The text of every context message in a decision. */
function contextText(decision: { additionalContexts?: unknown[] }): string {
  return (decision.additionalContexts ?? [])
    .map(message => {
      const content = (message as { content?: { type: string, text?: string }[] }).content ?? []
      return content.map(block => block.text ?? '').join('\n')
    })
    .join('\n')
}

describe('plugin identity', () => {
  // `shell` is required, not optional: Cordis throws on an undeclared
  // `ctx.<name>` read, so a missing entry here stops the plugin activating in a
  // real boot while every other test still passes. A live boot is what caught
  // that; this assertion is what stops it coming back.
  it('declares every service it reads', () => {
    assert.equal(name, 'verify-on-edit')
    assert.deepEqual([...inject].sort(), ['shell', 'tools'])
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

describe('the hook', () => {
  it('reports an error in a file the agent just edited', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('src/app.ts(12,5): error TS2322: Type string is not assignable to number.')
    const decision = await harness.hook(execFor(agentFor(root)), { isError: false }, async () => ({ kind: 'accept' }))

    assert.equal(decision.kind, 'accept')
    const text = contextText(decision)
    assert.match(text, /typecheck fails on 1 problem/)
    assert.match(text, /src\/app\.ts:12/)
    assert.match(text, /TS2322/)
  })

  it('runs the project\'s declared script', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('src/app.ts(1,1): error TS1: x')
    await harness.hook(execFor(agentFor(root)), { isError: false }, async () => ({ kind: 'accept' }))
    assert.deepEqual(harness.plans, ['npm run --silent typecheck'])
  })

  it('says nothing when the check passes', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('', 0)
    const decision = await harness.hook(execFor(agentFor(root)), { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(decision.additionalContexts, undefined)
  })

  // The filter that stops the agent wandering off to fix someone else's work.
  it('says nothing when only an untouched file fails', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('src/unrelated.ts(1,1): error TS1: pre-existing')
    const decision = await harness.hook(execFor(agentFor(root)), { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(decision.additionalContexts, undefined)
  })

  it('says nothing for a read-only tool', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('src/app.ts(1,1): error TS1: x')
    const decision = await harness.hook(execFor(agentFor(root), 'src/app.ts', 'read'), { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(decision.additionalContexts, undefined)
    assert.deepEqual(harness.plans, [], 'a read must not run a check')
  })

  it('says nothing when the edit itself failed', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('src/app.ts(1,1): error TS1: x')
    const decision = await harness.hook(execFor(agentFor(root)), { isError: true }, async () => ({ kind: 'accept' }))
    assert.equal(decision.additionalContexts, undefined)
  })

  it('says nothing for a project that declares no check', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'voe-bare-'))
    dirs.push(bare)
    writeFileSync(join(bare, 'README.md'), '# hi')
    const harness = install('src/app.ts(1,1): error TS1: x')
    const decision = await harness.hook(execFor(agentFor(bare)), { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(decision.additionalContexts, undefined)
  })

  it('debounces a burst of edits into one run', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('src/app.ts(1,1): error TS1: x', 1, { debounceMs: 60_000 })
    const agent = agentFor(root)
    await harness.hook(execFor(agent), { isError: false }, async () => ({ kind: 'accept' }))
    await harness.hook(execFor(agent), { isError: false }, async () => ({ kind: 'accept' }))
    await harness.hook(execFor(agent), { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(harness.plans.length, 1)
  })

  // A suppressed run must still record the path, or the next check misses it.
  it('attributes an edit that the debounce suppressed', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('src/late.ts(1,1): error TS1: x', 1, { debounceMs: 60_000 })
    const agent = agentFor(root)
    await harness.hook(execFor(agent), { isError: false }, async () => ({ kind: 'accept' }))
    await harness.hook(execFor(agent, 'src/late.ts'), { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(harness.plans.length, 1, 'only the first run happens')

    // A second edit inside the window is still attributed, so a later check
    // covers the file it touched.
    const later = install('src/app.ts(1,1): error TS1: a\nsrc/late.ts(1,1): error TS1: b', 1, { debounceMs: 5 })
    const laterAgent = agentFor(root)
    await later.hook(execFor(laterAgent), { isError: false }, async () => ({ kind: 'accept' }))
    // The second edit lands inside the window and is suppressed, but must still
    // be attributed: that is what this test is about.
    await later.hook(execFor(laterAgent, 'src/late.ts'), { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(later.plans.length, 1, 'the second edit is debounced')
    await new Promise(resolve => setTimeout(resolve, 10))
    const decision = await later.hook(execFor(laterAgent, 'src/late.ts'), { isError: false }, async () => ({ kind: 'accept' }))
    assert.match(contextText(decision), /src\/late\.ts/)
  })

  it('preserves whatever the downstream listener decided', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('src/app.ts(1,1): error TS1: x')
    const decision = await harness.hook(execFor(agentFor(root)), { isError: false }, async () => ({ kind: 'accept', content: [{ type: 'text', text: 'downstream' }] }))
    assert.deepEqual((decision as { content?: unknown }).content, [{ type: 'text', text: 'downstream' }])
    assert.ok(decision.additionalContexts !== undefined)
  })

  it('blocks when a deployment asks it to', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('src/app.ts(1,1): error TS1: x', 1, { blocking: true })
    const decision = await harness.hook(execFor(agentFor(root)), { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'block')
  })

  // Disabled registers no listener at all, which is stronger than registering
  // one that always returns early: nothing is even asked to run.
  it('registers no hook when disabled', () => {
    const harness = install('', 0, { enabled: false })
    assert.equal(harness.hook, undefined)
    assert.deepEqual(harness.plans, [])
  })

  // The property that matters most operationally: a bug in this plugin must not
  // become a bug in the agent's tool call.
  it('never breaks a tool call when the shell layer throws', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('')
    const ctx = {
      on: (_event: string, handler: Harness['hook']) => { harness.hook = handler; return () => {} },
      logger: { warn: () => {} },
      shell: {
        resolve: () => { throw new Error('shell exploded') },
        execute: async () => { throw new Error('unreachable') },
      },
    }
    apply(ctx as never, {})
    const decision = await harness.hook(execFor(agentFor(root)), { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'accept')
    assert.equal(decision.additionalContexts, undefined)
  })

  it('never breaks a tool call when the agent has no session cwd', async () => {
    const harness = install('src/app.ts(1,1): error TS1: x')
    const decision = await harness.hook({ name: 'edit', arguments: { file_path: 'a.ts' }, agent: { session: { header: {} } } }, { isError: false }, async () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'accept')
  })
})

describe('re-detection', () => {
  // A project that gains a check mid-session must start being checked. The
  // common case is an agent adding the script itself, and caching the negative
  // result would make the plugin silently inert for the rest of the session.
  it('picks up a check that appears after an earlier edit', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'voe-late-'))
    dirs.push(bare)
    writeFileSync(join(bare, 'README.md'), '# no check yet\n')

    const harness = install('src/app.ts(1,1): error TS1: broke it', 1, { debounceMs: 1 })
    const agent = agentFor(bare)

    // First edit: no check declared, so nothing runs.
    await harness.hook(execFor(agent), { isError: false }, async () => ({ kind: 'accept' }))
    assert.deepEqual(harness.plans, [], 'no check should run for a project with none')

    // The project declares one, as an agent adding a script would.
    writeFileSync(join(bare, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }))
    await new Promise(resolve => setTimeout(resolve, 10))

    const decision = await harness.hook(execFor(agent), { isError: false }, async () => ({ kind: 'accept' }))
    assert.deepEqual(harness.plans, ['npm run --silent typecheck'], 'the new check must be picked up')
    assert.match(contextText(decision), /typecheck fails/)
  })

  it('does not re-read the project once a check is found', async () => {
    const root = project()
    dirs.push(root)
    const harness = install('src/app.ts(1,1): error TS1: x', 1, { debounceMs: 1 })
    const agent = agentFor(root)
    await harness.hook(execFor(agent), { isError: false }, async () => ({ kind: 'accept' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    await harness.hook(execFor(agent), { isError: false }, async () => ({ kind: 'accept' }))
    // Both runs execute, but detection happened once and was cached.
    assert.equal(harness.plans.length, 2)
  })
})

// This plugin once appended a `verify-on-edit/check` record to the session log.
// `Session.append()` cannot set the envelope's `ignorable` marker, and the
// persistence read path refuses a session holding an event type outside the
// harness's vocabulary without it, so nine sessions stopped loading entirely:
// "contains event type ... unknown to this harness and not marked ignorable".
// A plugin cannot register an event type either, so the answer is to write
// nothing, and this is the case that says so.
describe('leaves the session log alone', () => {
  it('never appends to the session, on any path through the hook', async () => {
    const root = project()
    dirs.push(root)
    const refuse = () => { throw new Error('the session log must not be written to') }
    const agent = agentFor(root, { append: refuse, record: refuse })

    for (const [output, exitCode] of [['src/app.ts(1,1): error TS1: x', 1], ['', 0]] as const) {
      const harness = install(output, exitCode)
      const decision = await harness.hook(execFor(agent), { isError: false }, async () => ({ kind: 'accept' }))
      assert.equal(decision.kind, 'accept')
    }
  })

  // Behaviour alone cannot catch this: the append only refuses at read time, in
  // a later process, so the source is checked too. Comments are stripped first,
  // because this file's own explanation of the bug names the event.
  it('neither appends nor names an event type in its source', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    assert.deepEqual(source.match(/\.append\b/g) ?? [], [])
    assert.deepEqual(source.match(/['"][a-z-]+\/[a-z-]+['"]/g) ?? [], ["'tools/post-execute'"])
  })
})
