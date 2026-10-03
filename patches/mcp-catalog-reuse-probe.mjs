#!/usr/bin/env node
/**
 * Evidence probe for `mcp-catalog-reuse.patch`.
 *
 * Part 1 isolates the SDK behaviour the patch leans on: one caller-supplied
 * response cache, two `Client` instances, and the three cache modes. Part 2
 * runs the same question over a real stdio transport against the patched
 * fixture server, which is where the protocol's `ttlMs` default turns out to
 * decide the outcome.
 *
 * Run it from the mcp-client package directory of a DSH checkout:
 *
 *   cd packages/mcp/mcp-client
 *   node /path/to/dsh-workspace-mcp/patches/mcp-catalog-reuse-probe.mjs
 *
 * Part 2 needs `tests/fixture-server.ts` in the working directory and skips
 * itself when that file is absent. Exits non-zero if any expectation fails.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const requireFromCwd = createRequire(join(process.cwd(), 'package.json'))

/**
 * Import a package's ESM entry as installed for the working directory. A bare
 * specifier would resolve against this file, which lives outside the checkout.
 */
async function loadEsm(specifier, subpath = '.') {
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
  let directory = dirname(requireFromCwd.resolve(specifier))
  for (;;) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === packageName) {
        const resolved = manifest.exports?.[subpath]
        const entry = typeof resolved === 'string'
          ? resolved
          : resolved?.import?.default ?? resolved?.import ?? resolved?.default
        if (typeof entry !== 'string') throw new Error(`${packageName} exposes no ESM entry for ${subpath}`)
        return import(pathToFileURL(join(directory, entry)).href)
      }
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`could not find ${packageName} above ${directory}`)
    directory = parent
  }
}

const { Client, InMemoryResponseCacheStore, InMemoryTransport } = await loadEsm('@modelcontextprotocol/client')
const { McpServer } = await loadEsm('@modelcontextprotocol/server')
const { z } = await loadEsm('zod')

let failures = 0
/** Assert one labelled expectation and report it. */
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

// ---- Part 1: the SDK mechanism, in memory ----

function makeServer(names) {
  const server = new McpServer(
    { name: 'fixture', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  )
  for (const name of names) {
    server.registerTool(name, { title: name, description: name, inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }))
  }
  return server
}

async function memorySession(names, clientOptions, cacheMode) {
  const server = makeServer(names)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'probe', version: '0' }, {
    capabilities: {},
    ...clientOptions,
    listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {} } },
  })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const result = await client.listTools(undefined, { cacheMode })
  await client.close()
  await server.close()
  return result.tools.map(tool => tool.name)
}

console.log('--- part 1: one supplied store, several client instances ---')
const shared = new InMemoryResponseCacheStore()
const sharedOptions = { responseCacheStore: shared, defaultCacheTtlMs: 300_000 }
check('refresh lists what the server has', await memorySession(['stable'], sharedOptions, 'refresh'), ['stable'])
check('use reuses a supplied store across clients', await memorySession(['stable', 'extra'], sharedOptions, 'use'), ['stable'])
check('refresh always lists again', await memorySession(['stable', 'extra'], sharedOptions, 'refresh'), ['stable', 'extra'])
check('use without a store cannot reuse', await memorySession(['stable', 'extra'], { defaultCacheTtlMs: 300_000 }, 'use'), ['stable', 'extra'])

// ---- Part 2: the same question over a real stdio transport ----

const fixture = 'tests/fixture-server.ts'
if (!existsSync(fixture)) {
  console.log(`--- part 2 skipped: no ${fixture} in ${process.cwd()} ---`)
} else {
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
  const directory = mkdtempSync(join(tmpdir(), 'catalog-probe-'))
  const marker = join(directory, 'tools.txt')

  /** Two generations of the fixture; only the second advertises `extra`. */
  async function stdioSession(label, cacheMode, declaredTtlMs) {
    writeFileSync(marker, label === 'first' ? 'first generation' : 'revived')
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixture],
      env: {
        ...process.env,
        FIXTURE_TOOLS_MARKER_FILE: marker,
        ...declaredTtlMs === undefined ? {} : { FIXTURE_TOOLS_TTL_MS: declaredTtlMs },
      },
      cwd: process.cwd(),
      stderr: 'ignore',
    })
    const client = new Client({ name: 'probe', version: '0' }, {
      capabilities: {},
      responseCacheStore: shared,
      defaultCacheTtlMs: 300_000,
      versionNegotiation: { mode: 'auto' },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {} } },
    })
    await client.connect(transport)
    const result = await client.listTools(undefined, { cacheMode })
    await client.close()
    return result.tools.map(tool => tool.name).includes('revived')
  }

  console.log('--- part 2: real stdio, server declares nothing ---')
  await stdioSession('first', 'refresh', undefined)
  check('a silent server is listed again (framework emits ttlMs 0)', await stdioSession('second', 'use', undefined), true)

  console.log('--- part 2: real stdio, server declares 60s ---')
  await stdioSession('first', 'refresh', '60000')
  check('a declaring server is reused', await stdioSession('second', 'use', '60000'), false)
}

console.log(failures === 0 ? '\nall expectations held' : `\n${failures} expectation(s) failed`)
process.exit(failures === 0 ? 0 : 1)
