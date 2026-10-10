/** Real plugin hooks with a controlled shell and a durable session-shaped log. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { apply, name, inject } from '../src/index.ts'
import type { Config } from '../src/report.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function project(scripts: Record<string, string> | undefined = { typecheck: 'tsc --noEmit' }): string {
  const root = mkdtempSync(join(tmpdir(), 'voe-hooks-'))
  dirs.push(root)
  if (scripts !== undefined) writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }))
  return root
}
const text = (value: unknown): string => JSON.stringify(value)
function host(config: Config = {}, root = project()) {
  const hooks = new Map<string, (...args: any[]) => any>()
  const calls: any[] = [], events: any[] = [{ type: 'turn/start', data: { turn: 1 } }]
  const steered: any[] = [], disposal: (() => void)[] = []
  let answer: any = { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
  let execute: ((spec: any) => Promise<any>) | undefined
  let policy: any
  const session = {
    header: { cwd: root },
    events,
    get seq() { return events.length },
    eventAt: (index: number) => events[index],
    append: (type: string, data: any, envelope?: any) => {
      assert.equal(type, 'user/message', 'only an existing event type may be appended')
      events.push({ type, data, ...envelope })
    },
  }
  const agent = { session, status: 'running', inbox: { nextStep: [] }, steer: (message: any) => {
    steered.push(message)
    events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
  } }
  const shell: any = {
    resolve: (request: any) => { calls.push(request); return request },
    execute: async (spec: any) => execute ? execute(spec) : { result: async () => answer },
  }
  const ctx = {
    on: (event: string, hook: (...args: any[]) => any) => { hooks.set(event, hook) },
    get: (service: string) => service === 'sandboxPolicy' ? policy : undefined,
    effect: (factory: () => () => void) => { disposal.push(factory()) },
    logger: { warn: () => {} }, shell,
  }
  apply(ctx as never, config)
  return {
    hooks, calls, events, steered, agent, shell, root,
    human: (message: string) => { events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: message }] } }) },
    reload: () => { apply(ctx as never, config) },
    answer: (value: any) => { answer = { ...answer, ...value } },
    execution: (fn: (spec: any) => Promise<any>) => { execute = fn },
    policy: (value: any) => { policy = value },
    dispose: () => { for (const stop of disposal) stop() },
    edit: async (file = 'src/A.ts', options: { signal?: AbortSignal, tool?: string, isError?: boolean } = {}) => hooks.get('tools/post-execute')!({
      name: options.tool ?? 'edit', arguments: { file_path: file }, agent,
      signal: options.signal ?? new AbortController().signal,
    }, { isError: options.isError ?? false }, async () => ({ kind: 'accept', content: [{ type: 'text', text: 'original' }] })),
    stop: async (signal = new AbortController().signal) => {
      events.push({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Done.' }] } } })
      await hooks.get('agent/turn-stopping')!({ agent, turn: 1, signal })
    },
  }
}

function failed(output = 'src/A.ts(1,1): error TS2322: wrong type') {
  return { exitCode: 1, stdout: { text: output } }
}

describe('verification wiring and outcomes', () => {
  it('declares shell and tool dependencies', () => {
    assert.equal(name, 'verify-on-edit')
    assert.deepEqual(inject, ['tools', 'shell'])
  })
  it('reports an explicit pass without changing the edit result', async () => {
    const h = host()
    const result = await h.edit()
    assert.equal(result.kind, 'accept')
    assert.deepEqual(result.content, [{ type: 'text', text: 'original' }])
    assert.equal(result.additionalContexts[0].source.summary, 'verify-on-edit: passed')
    assert.match(text(result), /typecheck passed/)
  })
  it('reports errors with no invented before/after attribution', async () => {
    const h = host(); h.answer(failed())
    const result = await h.edit()
    assert.equal(result.additionalContexts[0].source.summary, 'verify-on-edit: failed')
    assert.match(text(result), /No pre-edit baseline/)
    assert.match(text(result), /src\/A\.ts/)
  })
  it('keeps failures in untouched dependent files visible', async () => {
    const h = host(); h.answer(failed('src/consumer.ts(1,1): error TS2322: exported API changed'))
    const result = await h.edit('src/api.ts')
    assert.match(text(result), /consumer\.ts/)
    assert.match(text(result), /Untouched files may be affected consumers/)
    assert.doesNotMatch(text(result), /predate your change/)
  })
  it('reports a nonzero unparseable check as unparsed, not passed', async () => {
    const h = host(); h.answer(failed('FAIL assertion expected 4 got 5'))
    const result = await h.edit()
    assert.equal(result.additionalContexts[0].source.summary, 'verify-on-edit: unparsed')
    assert.match(text(result), /FAIL assertion expected/)
  })
  it('bounds unparseable and parsed output', async () => {
    const h = host(); h.answer(failed('broken '.repeat(5000)))
    const result = await h.edit()
    assert.ok(result.additionalContexts[0].content[0].text.length < 4100)
    const parsed = host(); parsed.answer(failed(Array.from({ length: 200 }, (_, i) => `src/${i}.ts(1,1): error TS1: ${'x'.repeat(500)}`).join('\n')))
    const report = await parsed.edit()
    assert.ok(report.additionalContexts[0].content[0].text.length < 4100)
  })
  it('reports shell failures and policy denials as unavailable', async () => {
    const h = host(); h.execution(async () => { throw new Error('executor unavailable') })
    assert.equal((await h.edit()).additionalContexts[0].source.summary, 'verify-on-edit: unavailable')
    const denied = host(); denied.answer({ exitCode: 1, sandbox: { denied: true } })
    assert.equal((await denied.edit()).additionalContexts[0].source.summary, 'verify-on-edit: unavailable')
  })
  it('reports a timeout separately and preserves the hard timeout request', async () => {
    const h = host({ timeoutMs: 1234 }); h.answer({ exitCode: null, timedOut: true })
    assert.equal((await h.edit()).additionalContexts[0].source.summary, 'verify-on-edit: timed-out')
    assert.equal(h.calls[0].timeoutMs, 1234)
    assert.equal(h.calls[0].onExpiry, 'kill')
    assert.equal(h.calls[0].stdoutMaxBytes, 32768)
  })
  it('reports no-check when there is no configured or detected command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'voe-no-check-')); dirs.push(root)
    const h = host({}, root)
    assert.equal((await h.edit()).additionalContexts[0].source.summary, 'verify-on-edit: no-check')
    assert.equal(h.calls.length, 0)
  })
  // Reported from a real worktree with 704 passing tests and no project file.
  // The old notice said nothing was "configured or detected", which read as a
  // fact about the project rather than about the search that missed the suite.
  it('names what it searched when it finds no check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'voe-no-check-')); dirs.push(root)
    const h = host({}, root)
    const notice = text(await h.edit())
    assert.match(notice, /Searched the session workspace for package\.json/)
    assert.match(notice, /tests\/conftest\.py/)
    assert.match(notice, /name it with `command`/)
  })
  it('turns a worktree with only tests into a runnable check when slow checks are allowed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'voe-pytest-')); dirs.push(root)
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'tests', 'conftest.py'), 'import sys')
    const h = host({ allowSlow: true }, root)
    assert.equal((await h.edit()).additionalContexts[0].source.summary, 'verify-on-edit: passed')
    // The suite is the check, and it runs through the parser's `path:line:`
    // shape rather than pytest's default multi-line traceback.
    assert.match(h.calls[0].command, /-m pytest --tb=line -q/)
    assert.equal(h.calls[0].workdir, root)
  })
  it('says a found suite was withheld rather than that none exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'voe-pytest-slow-')); dirs.push(root)
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'tests', 'conftest.py'), 'import sys')
    const h = host({}, root)
    const result = await h.edit()
    assert.equal(result.additionalContexts[0].source.summary, 'verify-on-edit: no-check')
    const notice = text(result)
    assert.match(notice, /pytest check was available but not run/)
    assert.match(notice, /allowSlow/)
    assert.equal(h.calls.length, 0, 'a withheld check must not run')
  })
  it('supports an explicit command and runs it in the session workspace', async () => {
    const h = host({ command: 'pnpm verify --filter web', label: 'web check' })
    const result = await h.edit()
    assert.equal(h.calls[0].command, 'pnpm verify --filter web')
    assert.equal(h.calls[0].workdir, h.root)
    assert.match(text(result), /web check passed/)
  })
  it('re-detects after the declared check changes', async t => {
    let now = 100_000; t.mock.method(Date, 'now', () => now)
    const h = host()
    await h.edit()
    writeFileSync(join(h.root, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }))
    now += 4000
    await h.edit('package.json')
    assert.deepEqual(h.calls.map(call => call.command), ['npm run --silent typecheck', 'npm run --silent lint'])
  })
  it('does not run for read-only or failed calls', async () => {
    const h = host()
    await h.edit('src/A.ts', { tool: 'read' })
    await h.edit('src/A.ts', { isError: true })
    await h.stop()
    assert.equal(h.calls.length, 0)
    assert.equal(h.steered.length, 0)
  })
  it('registers no hooks when disabled', () => {
    assert.equal(host({ enabled: false }).hooks.size, 0)
  })
  it('can block on failed checks when explicitly configured', async () => {
    const h = host({ blocking: true }); h.answer(failed())
    assert.equal((await h.edit()).kind, 'block')
  })
})

describe('dirty edits and completion flush', () => {
  it('serializes multiple waiters behind a slow check without duplicate follow-up checks', async t => {
    let now = 100_000; t.mock.method(Date, 'now', () => now)
    const barrier = () => {
      let release!: () => void
      const promise = new Promise<void>(resolve => { release = resolve })
      return { promise, release }
    }
    const started = [barrier(), barrier(), barrier()]
    const finish = [barrier(), barrier(), barrier()]
    const h = host({ debounceMs: 3000 })
    let running = 0, maximum = 0, execution = 0
    h.execution(async () => {
      const index = execution++
      running++; maximum = Math.max(maximum, running)
      started[index].release()
      return { result: async () => {
        await finish[index].promise
        running--
        return { exitCode: 0 }
      } }
    })
    const a = h.edit('src/A.ts')
    await started[0].promise
    now += 4000
    // Both waiters observe A in flight before it is released.
    const b = h.edit('src/B.ts'), c = h.edit('src/C.ts')
    await Promise.resolve(); await Promise.resolve()
    finish[0].release()
    await started[1].promise
    assert.equal(h.calls.length, 2, 'one follow-up check owns both pending edits')
    assert.equal(maximum, 1, 'checks must never overlap')
    finish[1].release(); finish[2].release()
    const results = await Promise.all([a, b, c])
    assert.equal(results.filter(result => result.additionalContexts).length, 2, 'one notice per actual check')
    await h.stop()
    assert.equal(h.calls.length, 2, 'the final revision is already checked')
  })
  it('retains B when its check is suppressed and C triggers the next check', async t => {
    let now = 100_000; t.mock.method(Date, 'now', () => now)
    const h = host({ debounceMs: 3000 })
    await h.edit('src/A.ts')
    now += 10
    h.answer(failed('src/B.ts(1,1): error TS1: broken B'))
    await h.edit('src/B.ts')
    assert.equal(h.calls.length, 1)
    now += 3000
    const result = await h.edit('src/C.ts')
    assert.equal(h.calls.length, 2)
    assert.match(text(result), /broken B/)
    // The failure remains visible at completion even though no edit is pending.
    await h.stop()
    assert.equal(h.steered.length, 1)
    assert.match(text(h.steered[0]), /Verification failed/)
  })
  it('checks a final debounced edit before normal completion, even if no C occurs', async () => {
    const h = host({ debounceMs: 60000 })
    await h.edit('src/A.ts')
    await h.edit('src/B.ts')
    assert.equal(h.calls.length, 1)
    await h.stop()
    assert.equal(h.calls.length, 2)
    assert.equal(h.steered.length, 0, 'a passed check needs no corrective continuation')
    const notices = h.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'verify-on-edit')
    assert.equal(notices.length, 1)
    assert.equal(notices[0].data.source.summary, 'verify-on-edit: passed')
  })
  it('retains both suppressed paths in the flushed outcome', async () => {
    const h = host({ debounceMs: 60000 })
    await h.edit('src/A.ts')
    await h.edit('src/B.ts')
    h.answer(failed('src/B.ts(1,1): error TS1: final edit failed'))
    await h.stop()
    assert.equal(h.calls.length, 2)
    assert.match(text(h.steered), /final edit failed/)
  })
  it('recovers pending successful edits after plugin reload without a new edit', async () => {
    const h = host({ debounceMs: 60000 })
    await h.edit('src/A.ts')
    // The host persists successful results after the post-execute hook returns.
    h.events.push(
      { type: 'tool/call', data: { name: 'edit', callId: 'A', arguments: JSON.stringify({ file_path: 'src/A.ts' }) } },
      { type: 'tool/result', data: { message: { callId: 'A', isError: false } } },
      { type: 'tool/call', data: { name: 'edit', callId: 'B', arguments: JSON.stringify({ file_path: 'src/B.ts' }) } },
      { type: 'tool/result', data: { message: { callId: 'B', isError: false } } },
    )
    await h.edit('src/B.ts')
    assert.equal(h.calls.length, 1)
    h.reload()
    h.answer(failed('src/B.ts(1,1): error TS1: final B remains broken'))
    await h.stop()
    assert.equal(h.calls.length, 2)
    assert.match(text(h.steered), /final B remains broken/)
  })
  it('supports the events-array Session API at both edit and completion', async () => {
    const h = host({ debounceMs: 60000 })
    delete (h.agent.session as any).eventAt
    await h.edit('src/A.ts')
    await h.edit('src/B.ts')
    await h.stop()
    assert.equal(h.calls.length, 2)
    assert.equal(h.steered.length, 0)
  })
  it('does not repeat a completed check at stop', async () => {
    const h = host(); await h.edit(); await h.stop(); await h.stop()
    assert.equal(h.calls.length, 1)
  })
  it('does not carry an old failure into an unrelated later turn', async () => {
    const h = host(); h.answer(failed()); await h.edit()
    h.events.push({ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } })
    h.events.push({ type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'Here is the answer.' }] } } })
    await h.hooks.get('agent/turn-stopping')!({ agent: h.agent, turn: 2, signal: new AbortController().signal })
    assert.equal(h.calls.length, 1)
    assert.equal(h.steered.length, 0)
  })
})

describe('cancellation and session policy', () => {
  it('honors an explicit no-tests request before the immediate edit check', async () => {
    const h = host()
    h.human('Make the change, but do not run tests or checks.')
    const result = await h.edit()
    assert.equal(h.calls.length, 0)
    assert.match(text(result), /skipped at the user/)
    await h.stop()
    assert.equal(h.calls.length, 0)
    assert.equal(h.steered.length, 0)
  })
  it('retains owed verification while checks are prohibited, allowing a later explicit request', async () => {
    const h = host({ debounceMs: 60000 })
    h.human('Apply the edit, but do not run any checks.')
    await h.edit()
    assert.equal(h.calls.length, 0)
    h.human('Now run the checks.')
    await h.stop()
    assert.equal(h.calls.length, 1)
  })
  it('rechecks current user restrictions after waiting for an in-flight check', async t => {
    let now = 100000; t.mock.method(Date, 'now', () => now)
    const h = host()
    let entered!: () => void, finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const release = new Promise<void>(resolve => { finish = resolve })
    h.execution(async () => ({ result: async () => { entered(); await release; return { exitCode: 0 } } }))
    const first = h.edit('src/A.ts')
    await started
    now += 4000
    const second = h.edit('src/B.ts')
    await Promise.resolve(); await Promise.resolve()
    h.human('Do not run any more checks.')
    finish()
    await Promise.all([first, second])
    assert.equal(h.calls.length, 1)
    await h.stop()
    assert.equal(h.calls.length, 1)
  })
  it('passes the resolved per-session sandbox policy to the shell', async () => {
    const h = host(); h.shell.sandboxMode = 'workspace-write'
    const policy = { mode: 'read-only', workspaceRoot: h.root }
    let selected: unknown
    h.policy({ resolve: ({ session }: any) => { selected = session; return policy } })
    await h.edit()
    assert.equal(selected, h.agent.session)
    assert.equal(h.calls[0].sandboxPolicy, policy)
  })
  it('refuses to default a confined execution when session policy is missing', async () => {
    const h = host(); h.shell.sandboxMode = 'workspace-write'
    const result = await h.edit()
    assert.equal(h.calls.length, 0)
    assert.equal(result.additionalContexts[0].source.summary, 'verify-on-edit: unavailable')
  })
  it('does not launch a check after the tool is cancelled', async () => {
    const h = host(); const abort = new AbortController(); abort.abort()
    await h.edit('src/A.ts', { signal: abort.signal })
    await h.stop(abort.signal)
    assert.equal(h.calls.length, 0)
    assert.equal(h.steered.length, 0)
  })
  it('propagates cancellation into a running check and leaves it owed', async () => {
    const h = host(); const abort = new AbortController()
    h.execution(async spec => ({ result: async () => {
      abort.abort()
      assert.equal(spec.signal.aborted, true)
      return { exitCode: null, aborted: true }
    } }))
    const result = await h.edit('src/A.ts', { signal: abort.signal })
    assert.equal(result.additionalContexts, undefined)
    h.execution(async () => ({ result: async () => ({ exitCode: 0 }) }))
    await h.stop()
    assert.equal(h.calls.length, 2)
  })
  it('cancels outstanding checks when the plugin is disposed', async () => {
    const h = host()
    h.execution(async spec => ({ result: async () => {
      h.dispose()
      assert.equal(spec.signal.aborted, true)
      return { exitCode: null, aborted: true }
    } }))
    const result = await h.edit()
    assert.equal(result.additionalContexts, undefined)
  })
})
