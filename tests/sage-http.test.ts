import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { apply, Config } from '../lib/index.ts'
import { sageHttpOrigin, toSageHttpConfig } from '../lib/sage-http.ts'

const issuer = fileURLToPath(new URL('./fixtures/token-issuer.mjs', import.meta.url))
chmodSync(issuer, 0o755)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sage-http-'))
  const key = join(root, 'agent.key')
  writeFileSync(key, Buffer.alloc(32, 1), { mode: 0o600 })
  const calls = join(root, 'calls.jsonl')
  const sage = {
    url: 'http://127.0.0.1:8080/v1/mcp/streamable',
    tokenDirectory: join(root, 'tokens'), tokenCommand: issuer,
    identities: { [root]: key }, env: { FIXTURE_CALLS: calls },
  }
  return { root, sage, calls }
}

describe('SAGE shared HTTP service', () => {
  it('only accepts a credential-safe SAGE endpoint', () => {
    assert.equal(sageHttpOrigin('http://[::1]:8080/v1/mcp/streamable'), 'http://[::1]:8080')
    assert.equal(sageHttpOrigin('https://sage.example/v1/mcp/streamable'), 'https://sage.example')
    for (const url of ['garbage', 'file:///v1/mcp/streamable', 'http://example.test/v1/mcp/streamable',
      'http://user:password@localhost/v1/mcp/streamable', 'http://localhost/v1/mcp/streamable?q=1']) {
      assert.throws(() => sageHttpOrigin(url), /SAGE HTTP URL/)
    }
    const { sage } = fixture()
    assert.ok(Config['~standard'].validate({ sage: { ...sage, tokenDirectory: 123 } }).issues)
    assert.ok(Config['~standard'].validate({ sage: { ...sage, tokenDirectory: 'relative' } }).issues)
  })

  it('reuses a privately cached token across mounts of a durable session without a bridge subprocess', async () => {
    const { root, sage, calls } = fixture()
    const [one, two] = await Promise.all([
      toSageHttpConfig(root, sage, 5000, 'session-one'),
      toSageHttpConfig(root, sage, 5000, 'session-one'),
    ])
    assert.deepEqual(one, two)
    assert.equal(one.transport, 'streamable-http')
    for (const key of ['command', 'args', 'env', 'cwd']) assert.equal(key in one, false)
    const cached = await toSageHttpConfig(root, { ...sage, tokenCommand: '/does/not/exist' }, 5000, 'session-one')
    assert.deepEqual(cached, one)
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1)
    assert.equal(statSync(sage.tokenDirectory).mode & 0o777, 0o700)
    assert.equal(statSync(join(sage.tokenDirectory, readdirSync(sage.tokenDirectory)[0])).mode & 0o777, 0o600)
    assert.equal(JSON.parse(readFileSync(calls, 'utf8')).url, 'http://127.0.0.1:8080')
  })

  it('isolates concurrent sessions in the same project and keeps a project identity pinned', async () => {
    const { root, sage, calls } = fixture()
    const one = await toSageHttpConfig(root, sage, 5000, 'session-one')
    const two = await toSageHttpConfig(root, sage, 5000, 'session-two')
    assert.notEqual(one.headers.Authorization, two.headers.Authorization)
    const issued = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(issued[0].args[1], issued[1].args[1])
    assert.match(issued[0].args[1], /^[a-f0-9]{64}$/)
  })

  it('does not retry with stdio, create an identity, or expose issuer output on failure', async () => {
    const { root, sage, calls } = fixture()
    await assert.rejects(toSageHttpConfig('/unconfigured-project', sage, 5000, 'session-one'), /pinned identity/)
    assert.throws(() => readFileSync(calls), /ENOENT/)
    await assert.rejects(toSageHttpConfig(root, { ...sage, env: { ...sage.env, FIXTURE_FAIL: '1' } }, 5000, 'session-one'),
      (error) => error.message.includes('token issuance failed') && !String(error).includes('secret-that'))
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1)
    assert.equal(readdirSync(sage.tokenDirectory).length, 0)
  })

  it('rejects public or corrupt cached credentials without logging their content', async () => {
    const { root, sage } = fixture()
    await toSageHttpConfig(root, sage, 5000, 'session-one')
    const cache = join(sage.tokenDirectory, readdirSync(sage.tokenDirectory)[0])
    chmodSync(cache, 0o644)
    await assert.rejects(toSageHttpConfig(root, sage, 5000, 'session-one'), /private readable file/)
    chmodSync(cache, 0o600)
    writeFileSync(cache, '{ secret-that-must-never-be-logged')
    await assert.rejects(toSageHttpConfig(root, sage, 5000, 'session-one'), /cache is invalid/)
  })

  it('enforces operator HTTP mode even if the workspace declares its own stdio SAGE', async () => {
    const { root, sage } = fixture()
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
      sage: { command: '/should/not/spawn/sage-gui', args: ['serve'] },
      other: { command: '/bin/other' },
    } }))
    const mounted = []
    const ctx = { plugin: async (_, value) => { mounted.push(value) }, logger: { error: () => {}, warn: () => {} } }
    const config = Config['~standard'].validate({ root, sage, clientModule: { apply: async () => {} } }).value
    await apply(ctx, config)
    assert.deepEqual(mounted.map((entry) => [entry.serverName, entry.transport]), [['other', 'stdio'], ['sage', 'streamable-http']])
  })

  it('keeps other workspace tools available when HTTP credentials are missing', async () => {
    const { root, sage } = fixture()
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
      sage: { command: '/should/not/spawn/sage-gui' }, other: { command: '/bin/other' },
    } }))
    const mounted = [], logged = []
    const ctx = { plugin: async (_, value) => { mounted.push(value) }, logger: { error: (...args) => { logged.push(args) }, warn: () => {} } }
    const config = Config['~standard'].validate({ root, sage: { ...sage, identities: {} }, clientModule: { apply: async () => {} } }).value
    await apply(ctx, config)
    assert.deepEqual(mounted.map((entry) => entry.serverName), ['other'])
    assert.match(String(logged), /pinned identity/)
  })

  it('retires only this plugin\'s legacy DSH bridge in the same agent scope', async () => {
    const { root, sage } = fixture()
    const scope = {}, elsewhere = {}, disposed = []
    const callback = (ctx, config) => apply(ctx, config)
    const base = { transport: 'stdio', serverName: 'sage', cwd: root, command: issuer,
      args: ['mcp'], env: { SAGE_PROVIDER: 'dsh' } }
    const fiber = (name, config, parentScope = scope) => ({ config, parent: { fiber: parentScope }, dispose: async () => { disposed.push(name) } })
    const old = [fiber('ours', base), fiber('another agent', base, elsewhere),
      fiber('another provider', { ...base, env: { SAGE_PROVIDER: 'codex' } }),
      fiber('node', { ...base, args: ['serve'] })]
    const mounted = []
    const ctx = { fiber: scope, registry: { values: () => [{ callback, fibers: old }] },
      plugin: async (_, value) => { mounted.push(value) }, logger: { error: () => {}, warn: () => {} } }
    const config = Config['~standard'].validate({ root, sage, clientModule: { apply: async () => {} } }).value
    await apply(ctx, config)
    assert.deepEqual(disposed, ['ours'])
    assert.equal(mounted[0].transport, 'streamable-http')
  })

  it('uses the durable session ID and closes per-agent clients when the owning plugin unloads', async () => {
    const { root, sage, calls } = fixture()
    let complete
    const mounted = new Promise((resolve) => { complete = resolve })
    const disposed = [], effects = []
    const target = { plugin: (_, config) => {
      const fiber = Promise.resolve()
      fiber.dispose = async () => { disposed.push(config.serverName) }
      complete(config)
      return fiber
    }, logger: { error: () => {}, warn: () => {} } }
    const agent = { id: 'transient-agent-id', session: { id: 'durable-session-id', header: { cwd: root } }, ctx: target }
    const owner = { logger: target.logger, effect: (effect) => effects.push(effect()),
      inject: (_, callback) => callback({ agents: { roots: () => [agent] }, on: () => {} }) }
    const config = Config['~standard'].validate({ perAgent: true, sage, clientModule: { apply: async () => {} } }).value
    await apply(owner, config)
    const first = await mounted
    for (const dispose of effects) await dispose()
    assert.deepEqual(disposed, ['sage'])
    const same = await toSageHttpConfig(root, sage, config.toolCallTimeoutMs, 'durable-session-id')
    assert.equal(first.headers.Authorization, same.headers.Authorization)
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1)
  })
})
