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
import { apply, Config, inject, mapConfigDocument, name, toClientConfig } from '../lib/index.ts'
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

describe('activation', () => {
  it('mounts one client per declared server', async () => {
    const root = workspaceWith({ '.mcp.json': { mcpServers: { sage: { command: '/bin/sage-gui', args: ['mcp'] } } } })
    const { ctx, mounted, logged } = fakeContext()
    await apply(ctx, config({ root, verbose: true, clientModule: clientModule() }))
    assert.equal(mounted.length, 1)
    assert.equal(mounted[0].config.serverName, 'sage')
    assert.equal(mounted[0].config.transport, 'stdio')
    assert.equal(mounted[0].config.toolCallTimeoutMs, 60_000)
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
