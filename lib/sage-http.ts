/** Connect to the running SAGE HTTP MCP service, with one durable credential per session. */
import { execFile } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const pending = new Map()

/** Validate the endpoint before sending a credential or asking the local operator to issue one. */
export function sageHttpOrigin(url) {
  let endpoint
  try { endpoint = new URL(url) } catch { throw new Error('SAGE HTTP URL is invalid') }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/v1/mcp/streamable') {
    throw new Error('SAGE HTTP URL must use HTTPS or loopback HTTP and end in /v1/mcp/streamable')
  }
  return endpoint.origin
}

/** Read only a managed ordinary agent's key; never give the Harness MCP client the operator key. */
async function agentId(keyPath) {
  if (!isAbsolute(keyPath ?? '')) throw new Error('SAGE HTTP requires a pinned identity for this workspace')
  try {
    const bytes = await readFile(keyPath)
    if (bytes.length !== 32 && bytes.length !== 64) throw new Error()
    const key = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes.subarray(0, 32)]),
      format: 'der', type: 'pkcs8',
    })
    return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
  } catch {
    throw new Error('SAGE HTTP cannot read the pinned agent identity')
  }
}

async function readCredential(file, expectedAgent) {
  let bytes
  try {
    const info = await stat(file)
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error()
    bytes = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error('SAGE HTTP credential cache must be a private readable file')
  }
  try {
    const data = JSON.parse(bytes)
    if (data.agent_id !== expectedAgent || typeof data.token !== 'string'
      || !/^[\x21-\x7e]+$/.test(data.token) || typeof data.id !== 'string') throw new Error()
    return data
  } catch {
    throw new Error('SAGE HTTP credential cache is invalid; repair or rotate it')
  }
}

/** The only permitted SAGE subprocess is a short-lived token-management command, never mcp/serve. */
async function credential(workspace, sage, sessionId) {
  const origin = sageHttpOrigin(sage.url)
  if (!isAbsolute(sage.tokenDirectory ?? '')) throw new Error('SAGE HTTP requires an absolute tokenDirectory')
  const principal = await agentId(sage.identities?.[workspace])
  const scope = createHash('sha256').update(`${origin}\0${workspace}\0${sessionId}\0${principal}`).digest('hex')
  const file = join(sage.tokenDirectory, `${scope}.json`)
  await mkdir(sage.tokenDirectory, { recursive: true, mode: 0o700 })
  if (((await stat(sage.tokenDirectory)).mode & 0o077) !== 0) {
    throw new Error('SAGE HTTP tokenDirectory must be private (mode 0700)')
  }
  const saved = await readCredential(file, principal)
  if (saved) return saved.token
  if (!isAbsolute(sage.tokenCommand ?? '')) {
    throw new Error('SAGE HTTP has no cached session token; configure tokenCommand to provision one')
  }
  // Concurrent mounts of the same durable session must not mint duplicate credentials.
  if (pending.has(file)) return pending.get(file)
  const provision = (async () => {
    const env = { ...process.env, ...sage.env, SAGE_API_URL: origin }
    const options = { env, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true }
    let output
    try {
      output = await runFile(sage.tokenCommand,
        ['mcp-token', 'create', '--agent', principal, '--name', `dsh-${scope.slice(0, 24)}`], options)
    } catch {
      // execFile's Error embeds stdout/stderr, which may contain credentials. Never propagate it.
      throw new Error('SAGE HTTP token issuance failed; check the running node and local operator authorization')
    }
    const token = /^\s*Token:\s+(\S+)\s*$/m.exec(output.stdout)?.[1]
    const id = /^\s*ID:\s+([0-9a-f-]{36})\s*$/m.exec(output.stdout)?.[1]
    const returnedAgent = /^\s*Agent:\s+([0-9a-f]{64})\s*$/m.exec(output.stdout)?.[1]
    if (!token || !id || returnedAgent !== principal) throw new Error('SAGE HTTP token issuer returned an invalid response')
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ id, agent_id: principal, token }) + '\n', { mode: 0o600, flag: 'wx' })
      await chmod(temporary, 0o600)
      await rename(temporary, file)
    } catch {
      await unlink(temporary).catch(() => {})
      await runFile(sage.tokenCommand, ['mcp-token', 'revoke', id], options).catch(() => {})
      throw new Error('SAGE HTTP could not save the session token privately')
    }
    return token
  })()
  pending.set(file, provision)
  try { return await provision } finally { pending.delete(file) }
}

/** No command, args, cwd or stdio fallback is handed to the MCP client in HTTP mode. */
export async function toSageHttpConfig(workspace, sage, toolCallTimeoutMs, sessionId = 'profile') {
  const token = await credential(workspace, sage, sessionId)
  return {
    transport: 'streamable-http',
    serverName: sage.serverName ?? 'sage',
    url: sage.url,
    headers: { Authorization: `Bearer ${token}` },
    failOnStartupError: false,
    toolCallTimeoutMs,
  }
}
