/**
 * End-to-end check against the real DSH MCP client: a workspace `.mcp.json` is
 * written to disk, the plugin is activated with the genuine
 * `@deepseek-ai/dsh-mcp-client`, and the server it declares is really spawned
 * as a child process so its tool lands in the tool registry.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { apply, Config } from '../lib/index.ts'
import { echoHttp } from './fixtures/echo-http.mjs'

const SERVER_FIXTURE = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url))

/**
 * Boot the services the MCP client depends on.
 *
 * The context has no public stop(); the harness ends by process exit, so each
 * test disposes the fibers it created and lets the fixture child exit.
 */
async function bootContext() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Record every fiber this context starts so the test can dispose the ones
  // that own child processes; the harness itself ends by process exit.
  const started = []
  const plugin = ctx.plugin.bind(ctx)
  ctx.plugin = (module, config) => {
    const fiber = plugin(module, config)
    started.push(fiber)
    return fiber
  }
  fibers.push({ ctx, started })
  return ctx
}

/** Contexts started by this file, disposed in reverse after the last test. */
const fibers = []

after(async () => {
  for (const { started } of fibers.reverse()) {
    for (const fiber of started.reverse()) {
      try {
        await fiber.dispose()
      } catch {
        // A fiber that already unloaded is not a failure of this teardown.
      }
    }
  }
})

/** Normalize configuration exactly as the loader's validation step does. */
function config(raw = {}) {
  const result = Config['~standard'].validate(raw)
  if (result.issues) throw new Error(result.issues.map((issue) => issue.message).join('; '))
  return result.value
}

/** Names the tool registry currently exposes. */
function toolNames(ctx) {
  return ctx.tools.schemas().map((schema) => schema.name).sort()
}

/** Write a workspace declaring one stdio server backed by the fixture. */
function workspaceWithServer(name, file = '.mcp.json') {
  const root = mkdtempSync(join(tmpdir(), 'workspace-mcp-e2e-'))
  writeFileSync(join(root, file), JSON.stringify({
    mcpServers: { [name]: { command: process.execPath, args: [SERVER_FIXTURE] } },
  }))
  return root
}

describe('real mcp-client integration', () => {
  it('connects to an already-running HTTP server using the real Harness client', async () => {
    const service = await echoHttp()
    const root = mkdtempSync(join(tmpdir(), 'workspace-mcp-http-'))
    const key = join(root, 'agent.key')
    writeFileSync(key, Buffer.alloc(32, 1), { mode: 0o600 })
    const issuer = fileURLToPath(new URL('./fixtures/token-issuer.mjs', import.meta.url))
    chmodSync(issuer, 0o755)
    const ctx = await bootContext()
    try {
      await apply(ctx, config({ root, clientModule: mcpClient, sage: {
        url: service.url, tokenDirectory: join(root, 'tokens'), tokenCommand: issuer,
        identities: { [root]: key },
      } }))
      assert.deepEqual(toolNames(ctx), ['mcp__sage__echo'])
      const echo = ctx.tools.get('mcp__sage__echo')
      const result = await echo.execute({ text: 'shared service' }, { signal: new AbortController().signal })
      assert.match(JSON.stringify(result), /shared service/)
      assert.ok(service.requests.length >= 3)
      assert.equal(new Set(service.requests).size, 1)
    } finally {
      for (const fiber of fibers.at(-1).started.reverse()) await fiber.dispose()
      await service.close()
    }
  })

  it('contains an unavailable HTTP endpoint without starting a stdio MCP fallback', async () => {
    const service = await echoHttp()
    await service.close()
    const root = mkdtempSync(join(tmpdir(), 'workspace-mcp-http-offline-'))
    const key = join(root, 'agent.key'), calls = join(root, 'calls.jsonl')
    writeFileSync(key, Buffer.alloc(32, 1), { mode: 0o600 })
    const issuer = fileURLToPath(new URL('./fixtures/token-issuer.mjs', import.meta.url))
    const ctx = await bootContext()
    await apply(ctx, config({ root, clientModule: mcpClient, sage: {
      url: service.url, tokenDirectory: join(root, 'tokens'), tokenCommand: issuer,
      identities: { [root]: key }, env: { FIXTURE_CALLS: calls },
    } }))
    assert.deepEqual(toolNames(ctx), [])
    const commands = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(commands.map(({ command, action }) => [command, action]), [['mcp-token', 'create']])
  })

  it('spawns a workspace-declared server and registers its tool under the server namespace', async () => {
    const root = workspaceWithServer('echoserver')
    const ctx = await bootContext()
    await apply(ctx, config({ root, verbose: true, clientModule: mcpClient }))

    assert.deepEqual(toolNames(ctx), ['mcp__echoserver__echo'])
  })

  it('keeps two workspaces' + "' servers in separate namespaces", async () => {
    const first = workspaceWithServer('one')
    const second = workspaceWithServer('two')
    const ctx = await bootContext()
    await apply(ctx, config({ root: first, clientModule: mcpClient }))
    assert.deepEqual(toolNames(ctx), ['mcp__one__echo'])

    await apply(ctx, config({ root: second, clientModule: mcpClient }))
    assert.deepEqual(toolNames(ctx), ['mcp__one__echo', 'mcp__two__echo'])
  })

  it('registers no tools when the workspace declares none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-mcp-e2e-empty-'))
    const ctx = await bootContext()
    await apply(ctx, config({ root, clientModule: mcpClient }))
    assert.deepEqual(toolNames(ctx), [])
  })
})
