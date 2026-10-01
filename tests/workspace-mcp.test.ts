/**
 * Behavior tests for the workspace `.mcp.json` mapping and mounting paths.
 * Everything runs against the real filesystem and a fake Cordis context, so no
 * harness boot is needed to see what the plugin would register.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { apply, Config, inject, mapConfigDocument, name, toClientConfig, toSageConfig } from '../lib/index.ts'
import { toClientConfigs } from '../lib/map.ts'

const WORKSPACE = '/work/levelup'

/** Normalize configuration exactly as the loader's validation step does. */
function config(raw = {}) {
  const result = Config['~standard'].validate(raw)
  if (result.issues) throw new Error(result.issues.map((issue) => issue.message).join('; '))
  return result.value
}

/** Map a document with the given substitution scope, as `apply` would. */
function map(parsed, { workspaceFolder = WORKSPACE, env = undefined } = {}) {
  return mapConfigDocument(parsed, `${WORKSPACE}/.mcp.json`, {
    scope: { workspaceFolder, cwd: workspaceFolder, ...(env === undefined ? {} : { env }) },
  })
}

/** A fake Cordis context recording logger calls and mounted plugins. */
function fakeContext() {
  const mounted = []
  const logged = []
  const record = (level) => (format, ...args) => {
    logged.push(`${level}: ${format.replace(/%s/g, () => String(args.shift()))}`)
  }
  return {
    mounted,
    logged,
    ctx: {
      plugin: (module, config) => {
        mounted.push({ module, config })
        // The real registry returns the fiber, which is thenable; activation
        // work settles through it.
        return Promise.resolve()
      },
      logger: { info: record('info'), warn: record('warn'), error: record('error') },
    },
  }
}

/** Stand-in for the `@deepseek-ai/dsh-mcp-client` namespace the loader supplies. */
function clientModule(marker = 'module') {
  return { name: 'mcp-client', Config: {}, inject: ['tools'], apply: async () => {}, marker }
}

/** Write one `.mcp.json` into a fresh workspace directory. */
function workspaceWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-mcp-'))
  for (const [rel, contents] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
  }
  return root
}

describe('plugin exports', () => {
  it('declares the tool registry dependency its mounted clients register against', () => {
    assert.equal(name, 'workspace-mcp')
    assert.deepEqual([...inject], ['tools'])
  })

  it('defaults discovery to the two conventional files', () => {
    assert.deepEqual([...config({}).files], ['.mcp.json', '.dsh/mcp.json'])
  })

  it('rejects a field of the wrong type at load rather than at use', () => {
    const result = Config['~standard'].validate({ files: 'not-an-array' })
    assert.ok(result.issues)
    assert.match(result.issues[0].message, /files must be strings/)
  })

  it('rejects a non-object configuration', () => {
    assert.ok(Config['~standard'].validate('nope').issues)
    assert.ok(Config['~standard'].validate([1]).issues)
  })

  it('refuses environment references unless an operator permits them', () => {
    assert.equal(config({}).allowEnv, false)
  })
})

describe('entry mapping', () => {
  it('maps a stdio server to the client configuration', () => {
    const result = map({ mcpServers: { sage: { command: '/bin/sage-gui', args: ['mcp'], env: { A: '1' } } } })
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entries.length, 1)
    assert.deepEqual(toClientConfig(result.entries[0]), {
      transport: 'stdio',
      serverName: 'sage',
      command: '/bin/sage-gui',
      args: ['mcp'],
      env: { A: '1' },
      cwd: '',
      failOnStartupError: false,
    })
  })

  it('maps a url server to the Streamable HTTP transport', () => {
    const result = map({ mcpServers: { remote: { url: 'https://example.test/mcp', headers: { 'X-K': 'v' } } } })
    assert.equal(result.entries.length, 1)
    assert.deepEqual(toClientConfig(result.entries[0]), {
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://example.test/mcp',
      headers: { 'X-K': 'v' },
      failOnStartupError: false,
    })
  })

  it('rejects the retired HTTP+SSE transport by name', () => {
    const result = map({ mcpServers: { old: { type: 'sse', url: 'https://example.test/sse' } } })
    assert.equal(result.entries.length, 0)
    assert.match(result.diagnostics[0].reason, /retired HTTP\+SSE transport/)
  })

  it('skips an entry a workspace marked disabled', () => {
    const result = map({ mcpServers: { off: { command: '/bin/x', disabled: true } } })
    assert.deepEqual(result.entries, [])
    assert.deepEqual(result.diagnostics, [])
  })

  it('refuses a server key that cannot become a tool namespace', () => {
    const result = map({ mcpServers: { 'not a namespace': { command: '/bin/x' } } })
    assert.match(result.diagnostics[0].reason, /tool namespace/)
  })

  it('refuses an entry with neither command nor url', () => {
    const result = map({ mcpServers: { empty: {} } })
    assert.match(result.diagnostics[0].reason, /needs a "command"/)
  })

  it('refuses non-string argument and environment members', () => {
    assert.match(map({ mcpServers: { a: { command: '/bin/x', args: [1] } } }).diagnostics[0].reason, /array of strings/)
    assert.match(map({ mcpServers: { a: { command: '/bin/x', env: { A: 1 } } } }).diagnostics[0].reason, /must be strings/)
  })

  it('reports a file without servers as a warning, not a failure', () => {
    const result = map({})
    assert.deepEqual(result.entries, [])
    assert.equal(result.diagnostics[0].level, 'warning')
  })

  it('rejects a document whose mcpServers is not an object', () => {
    assert.equal(map({ mcpServers: [] }).diagnostics[0].level, 'error')
    assert.equal(map([]).diagnostics[0].level, 'error')
  })
})

describe('variable substitution', () => {
  it('substitutes the workspace folder into command, args, and cwd', () => {
    const result = map({
      mcpServers: {
        local: { command: '${workspaceFolder}/bin/server', args: ['--root', '${workspaceFolder}'], cwd: '${workspaceFolder}/sub' },
      },
    })
    const config = toClientConfig(result.entries[0])
    assert.equal(config.command, `${WORKSPACE}/bin/server`)
    assert.deepEqual(config.args, ['--root', WORKSPACE])
    assert.equal(config.cwd, `${WORKSPACE}/sub`)
  })

  it('resolves ${cwd} to the server directory once the entry sets one', () => {
    const result = map({ mcpServers: { local: { command: '/bin/x', cwd: '${workspaceFolder}/sub', args: ['${cwd}'] } } })
    assert.deepEqual(toClientConfig(result.entries[0]).args, [`${WORKSPACE}/sub`])
  })

  it('refuses an environment reference when substitution is not permitted', () => {
    const result = map({ mcpServers: { leaky: { command: '/bin/x', env: { TOKEN: '${env:GITHUB_TOKEN}' } } } })
    assert.equal(result.entries.length, 0)
    assert.match(result.diagnostics[0].reason, /refused: workspace files cannot read the harness environment/)
  })

  it('resolves an environment reference when an operator permits it', () => {
    const result = map({ mcpServers: { ok: { command: '/bin/x', env: { TOKEN: '${env:GITHUB_TOKEN}' } } } }, { env: { GITHUB_TOKEN: 'secret' } })
    assert.deepEqual(toClientConfig(result.entries[0]).env, { TOKEN: 'secret' })
  })

  it('refuses an environment reference that is embedded in a longer string', () => {
    const result = map({ mcpServers: { mixed: { command: '/bin/x', args: ['--token=${env:GITHUB_TOKEN}'] } } }, { env: { GITHUB_TOKEN: 'secret' } })
    assert.equal(result.entries.length, 0)
    assert.match(result.diagnostics[0].reason, /only substituted as a whole value/)
  })

  it('refuses an environment reference that names an unset variable', () => {
    const result = map({ mcpServers: { missing: { command: '/bin/x', env: { T: '${env:NOPE}' } } } }, { env: {} })
    assert.match(result.diagnostics[0].reason, /names an unset variable/)
  })
})

describe('precedence between files', () => {
  it('lets a later file supersede an earlier declaration and report the loss', () => {
    const context = { scope: { workspaceFolder: WORKSPACE, cwd: WORKSPACE } }
    const first = mapConfigDocument({ mcpServers: { shared: { command: '/bin/one' } } }, `${WORKSPACE}/.mcp.json`, context)
    const second = mapConfigDocument({ mcpServers: { shared: { command: '/bin/two' } } }, `${WORKSPACE}/.dsh/mcp.json`, context)
    const accepted = toClientConfigs([...first.entries, ...second.entries], context)
    assert.equal(accepted.entries.length, 1)
    assert.equal(toClientConfig(accepted.entries[0]).command, '/bin/two')
    assert.equal(accepted.diagnostics[0].level, 'warning')
    assert.match(accepted.diagnostics[0].reason, /superseded by the same server declared in .*\.dsh\/mcp\.json/)
  })

  it('keeps distinct servers from both files in first-declaration order', () => {
    const context = { scope: { workspaceFolder: WORKSPACE, cwd: WORKSPACE } }
    const first = mapConfigDocument({ mcpServers: { a: { command: '/bin/a' } } }, 'a.json', context)
    const second = mapConfigDocument({ mcpServers: { b: { command: '/bin/b' } } }, 'b.json', context)
    const accepted = toClientConfigs([...first.entries, ...second.entries], context)
    assert.deepEqual(accepted.entries.map((entry) => entry.name), ['a', 'b'])
  })
})

describe('forced environment', () => {
  it('lets the operator override what the file declares', () => {
    const result = map({ mcpServers: { s: { command: '/bin/x', env: { MODE: 'file' } } } })
    const config = toClientConfig(result.entries[0], { MODE: 'forced' })
    assert.deepEqual(config.env, { MODE: 'forced' })
  })

  it('keeps file values the operator did not override', () => {
    const result = map({ mcpServers: { s: { command: '/bin/x', env: { KEEP: 'file' } } } })
    assert.deepEqual(toClientConfig(result.entries[0], { MODE: 'forced' }).env, { KEEP: 'file', MODE: 'forced' })
  })
})

describe('per-workspace SAGE agent', () => {
  it('makes the workspace the server working directory, which is what selects the identity', () => {
    const sage = toSageConfig('/work/levelup', {}, 60_000)
    assert.equal(sage.cwd, '/work/levelup')
    assert.equal(sage.serverName, 'sage')
    assert.equal(sage.command, '/Applications/SAGE.app/Contents/MacOS/sage-gui')
    assert.deepEqual(sage.args, ['mcp'])
    assert.equal(sage.env.SAGE_PROVIDER, 'dsh')
    assert.equal(sage.failOnStartupError, false)
  })

  it('never leaves cwd empty, so the agent cannot inherit the harness directory', () => {
    assert.notEqual(toSageConfig('/work/anything', {}, 60_000).cwd, '')
  })

  it('lets an operator override the command, namespace, and environment', () => {
    const sage = toSageConfig('/work/x', { command: '/opt/sage', args: ['mcp', '--quiet'], serverName: 'memory', env: { SAGE_API_URL: 'http://127.0.0.1:9999' } }, 5_000)
    assert.equal(sage.command, '/opt/sage')
    assert.deepEqual(sage.args, ['mcp', '--quiet'])
    assert.equal(sage.serverName, 'memory')
    assert.equal(sage.env.SAGE_API_URL, 'http://127.0.0.1:9999')
    assert.equal(sage.toolCallTimeoutMs, 5_000)
  })

  it('pins the identity for a named workspace with SAGE_IDENTITY_PATH', () => {
    const sage = toSageConfig('/work/levelup', { identities: { '/work/levelup': '/keys/levelup.key' } }, 60_000)
    assert.equal(sage.env.SAGE_IDENTITY_PATH, '/keys/levelup.key')
  })

  it('leaves the identity to SAGE when the workspace is not named', () => {
    const sage = toSageConfig('/work/other', { identities: { '/work/levelup': '/keys/levelup.key' } }, 60_000)
    assert.equal(sage.env.SAGE_IDENTITY_PATH, undefined)
  })

  it('does not let a generic env map shadow a workspace identity pin', () => {
    const sage = toSageConfig('/work/levelup', {
      identities: { '/work/levelup': '/keys/levelup.key' },
      env: { SAGE_IDENTITY_PATH: '/keys/wrong.key' },
    }, 60_000)
    assert.equal(sage.env.SAGE_IDENTITY_PATH, '/keys/levelup.key')
  })

  it('mounts the SAGE server even when the workspace declares no servers of its own', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-mcp-sage-'))
    const { ctx, mounted } = fakeContext()
    await apply(ctx, config({ root, sage: {}, clientModule: clientModule() }))
    assert.equal(mounted.length, 1)
    assert.equal(mounted[0].config.serverName, 'sage')
    assert.equal(mounted[0].config.cwd, root)
  })

  it('mounts declared servers and the SAGE server together', async () => {
    const root = workspaceWith({ '.mcp.json': { mcpServers: { other: { command: '/bin/other' } } } })
    const { ctx, mounted } = fakeContext()
    await apply(ctx, config({ root, sage: {}, clientModule: clientModule() }))
    assert.deepEqual(mounted.map((m) => m.config.serverName), ['other', 'sage'])
    assert.equal(mounted[1].config.cwd, root)
  })

  it('lets a workspace-declared SAGE server win over the configured default', async () => {
    const root = workspaceWith({
      '.mcp.json': { mcpServers: { sage: { command: '/bin/custom-sage', args: ['mcp'] } } },
    })
    const { ctx, mounted, logged } = fakeContext()
    await apply(ctx, config({ root, sage: {}, verbose: true, clientModule: clientModule() }))
    // Exactly one SAGE server: two would claim the same serverName and abort the boot.
    assert.equal(mounted.filter((m) => m.config.serverName === 'sage').length, 1)
    assert.equal(mounted.find((m) => m.config.serverName === 'sage').config.command, '/bin/custom-sage')
    assert.ok(logged.some((line) => line.includes('declared by the workspace')))
  })

  it('mounts nothing when no servers are declared and no SAGE agent is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-mcp-none-'))
    const { ctx, mounted } = fakeContext()
    await apply(ctx, config({ root, clientModule: clientModule() }))
    assert.equal(mounted.length, 0)
  })

  it('rejects a malformed sage config at load', () => {
    assert.ok(Config['~standard'].validate({ sage: 'nope' }).issues)
    assert.ok(Config['~standard'].validate({ sage: { args: 'mcp' } }).issues)
    assert.ok(Config['~standard'].validate({ sage: { env: { A: 1 } } }).issues)
    assert.ok(Config['~standard'].validate({ sage: { identities: 'nope' } }).issues)
    assert.ok(Config['~standard'].validate({ sage: { identities: { a: 1 } } }).issues)
    assert.equal(Config['~standard'].validate({ sage: { identities: { '/w': '/k' } } }).issues, undefined)
    assert.equal(Config['~standard'].validate({ sage: {} }).issues, undefined)
  })
})

describe('activation', () => {
  it('mounts one client per declared server', async () => {
    const root = workspaceWith({ '.mcp.json': { mcpServers: { sage: { command: '/bin/sage-gui', args: ['mcp'] } } } })
    const { ctx, mounted, logged } = fakeContext()
    await apply(ctx, config({ root, verbose: true, clientModule: clientModule() }))
    assert.equal(mounted.length, 1)
    assert.equal(mounted[0].config.serverName, 'sage')
    assert.equal(mounted[0].config.transport, 'stdio')
    assert.equal(mounted[0].config.toolCallTimeoutMs, 60_000)
    // A server that declares no cwd is pinned to the workspace. Inheriting the
    // harness process cwd instead is what made SAGE derive a profile-named
    // identity in a GUI host, where that directory is not the workspace.
    assert.equal(mounted[0].config.cwd, root)
    // The namespace is normalized into a plugin FUNCTION carrying `inject`:
    // an object plugin's inject is ignored, which silently breaks ctx.tools.
    assert.equal(typeof mounted[0].module, 'function')
    assert.deepEqual([...mounted[0].module.inject], ['tools'])
    assert.ok(logged.some((line) => line.includes('mounted 1 server(s)')))
  })

  it('logs an error and mounts nothing when a file is unreadable JSON', async () => {
    const root = workspaceWith({ '.mcp.json': '{ not json' })
    const { ctx, mounted, logged } = fakeContext()
    await apply(ctx, config({ root, clientModule: clientModule() }))
    assert.equal(mounted.length, 0)
    assert.ok(logged.some((line) => line.startsWith('error:') && line.includes('invalid JSON')))
  })

  it('stays quiet and mounts nothing for a workspace without declarations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-mcp-empty-'))
    const { ctx, mounted, logged } = fakeContext()
    await apply(ctx, config({ root, clientModule: clientModule() }))
    assert.equal(mounted.length, 0)
    assert.deepEqual(logged, [])
  })

  it('takes the workspace from the process when no root is configured', async () => {
    const root = workspaceWith({ '.mcp.json': { mcpServers: { here: { command: '/bin/x' } } } })
    const previous = process.cwd()
    process.chdir(root)
    try {
      const { ctx, mounted } = fakeContext()
      await apply(ctx, config({ clientModule: clientModule() }))
      assert.equal(mounted.length, 1)
      assert.equal(mounted[0].config.serverName, 'here')
    } finally {
      process.chdir(previous)
    }
  })

  it('imports the client itself when the loader supplies no reference', async () => {
    const root = workspaceWith({ '.mcp.json': { mcpServers: { sage: { command: '/bin/x' } } } })
    const { ctx, mounted } = fakeContext()
    // No clientModule: the plugin must resolve the real package on its own,
    // which is the zero-configuration path operators get by default.
    await apply(ctx, config({ root, verbose: true }))
    assert.equal(mounted.length, 1)
    assert.equal(typeof mounted[0].module, 'function')
    assert.deepEqual([...mounted[0].module.inject], ['tools'])
  })

  it('lets an explicit reference override the self-import', async () => {
    const root = workspaceWith({ '.mcp.json': { mcpServers: { sage: { command: '/bin/x' } } } })
    const { ctx, mounted } = fakeContext()
    const pinned = clientModule('pinned')
    await apply(ctx, config({ root, clientModule: pinned }))
    assert.equal(mounted.length, 1)
    assert.equal(mounted[0].module.inject, pinned.inject)
  })

  it('accepts a promise for the client module so the loader can import it lazily', async () => {
    const root = workspaceWith({ '.mcp.json': { mcpServers: { sage: { command: '/bin/x' } } } })
    const { ctx, mounted } = fakeContext()
    const lazy = clientModule('lazy')
    await apply(ctx, config({ root, clientModule: Promise.resolve(lazy) }))
    assert.equal(mounted.length, 1)
    assert.equal(typeof mounted[0].module, 'function')
    assert.deepEqual([...mounted[0].module.inject], ['tools'])
  })
})

describe('per-agent mounting', () => {
  /** A fake agent whose scope context records what was mounted into it. */
  function fakeAgent(id, cwd) {
    const mounted = []
    return {
      mounted,
      agent: {
        id,
        session: { header: cwd === undefined ? {} : { cwd } },
        ctx: {
          plugin: (module, cfg) => {
            mounted.push({ module, config: cfg })
            return Promise.resolve()
          },
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        },
      },
    }
  }

  /**
   * A fake context whose dynamic `agents` injection exposes a mutable live list,
   * standing in for the harness AgentRegistry.
   */
  function perAgentContext(live) {
    const listeners = new Map()
    const scoped = {
      agents: { roots: () => [...live] },
      on: (event, listener) => listeners.set(event, listener),
    }
    return {
      listeners,
      ctx: {
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        inject: (names, callback) => {
          assert.deepEqual([...names], ['agents'])
          callback(scoped)
        },
      },
    }
  }

  /** apply() mounts agents without awaiting them, so let those promises settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('defaults perAgent off and reads it from the loader', () => {
    assert.equal(config({}).perAgent, false)
    assert.equal(config({ perAgent: true }).perAgent, true)
  })

  it('mounts in each root agent scope, from that agent session workspace', async () => {
    const first = workspaceWith({ '.mcp.json': { mcpServers: { sage: { command: '/bin/sage-gui' } } } })
    const second = workspaceWith({ '.mcp.json': { mcpServers: { other: { command: '/bin/other' } } } })
    const one = fakeAgent('one', first)
    const two = fakeAgent('two', second)
    const { ctx } = perAgentContext([one.agent, two.agent])
    await apply(ctx, config({ perAgent: true, clientModule: clientModule() }))
    await settle()
    // Each workspace's own file is read, and each child runs in its own workspace.
    assert.equal(one.mounted.length, 1)
    assert.equal(one.mounted[0].config.serverName, 'sage')
    assert.equal(one.mounted[0].config.cwd, first)
    assert.equal(two.mounted.length, 1)
    assert.equal(two.mounted[0].config.serverName, 'other')
    assert.equal(two.mounted[0].config.cwd, second)
  })

  it('mounts for a root agent created after activation, exactly once', async () => {
    const later = workspaceWith({ '.mcp.json': { mcpServers: { late: { command: '/bin/late' } } } })
    const live = []
    const { ctx, listeners } = perAgentContext(live)
    await apply(ctx, config({ perAgent: true, clientModule: clientModule() }))
    const created = listeners.get('agent/created')
    assert.equal(typeof created, 'function')

    const entry = fakeAgent('late', later)
    live.push(entry.agent)
    created({ agent: entry.agent })
    await settle()
    assert.equal(entry.mounted.length, 1)
    assert.equal(entry.mounted[0].config.cwd, later)

    created({ agent: entry.agent })
    await settle()
    assert.equal(entry.mounted.length, 1)
  })

  it('ignores an agent the registry does not report as a root', async () => {
    const child = fakeAgent('child', '/work/levelup')
    const { ctx, listeners } = perAgentContext([])
    await apply(ctx, config({ perAgent: true, clientModule: clientModule() }))
    listeners.get('agent/created')({ agent: child.agent })
    await settle()
    assert.equal(child.mounted.length, 0)
  })

  it('falls back to the configured root when a session recorded no cwd', async () => {
    const root = workspaceWith({ '.mcp.json': { mcpServers: { sage: { command: '/bin/sage-gui' } } } })
    const entry = fakeAgent('no-cwd', undefined)
    const { ctx } = perAgentContext([entry.agent])
    await apply(ctx, config({ perAgent: true, root, clientModule: clientModule() }))
    await settle()
    assert.equal(entry.mounted.length, 1)
    assert.equal(entry.mounted[0].config.cwd, root)
  })

  it('still mounts process-wide when perAgent is not set', async () => {
    const root = workspaceWith({ '.mcp.json': { mcpServers: { sage: { command: '/bin/sage-gui' } } } })
    const live = []
    const { ctx, mounted } = fakeContext()
    const withInject = { ...ctx, inject: () => { throw new Error('inject must not be used') } }
    await apply(withInject, config({ root, clientModule: clientModule() }))
    // fakeContext records process-wide mounts on the plugin context itself.
    assert.equal(mounted.length, 1)
    assert.equal(live.length, 0)
  })
})
