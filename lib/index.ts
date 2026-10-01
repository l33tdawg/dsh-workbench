/**
 * Workspace-declared MCP servers for DeepSeek Harness.
 *
 * A workspace's `.mcp.json` is the file that already tells other agent tools
 * which MCP servers a project needs. Harness reads server configuration only
 * from its own loader configuration, so this plugin closes the gap: it reads
 * the workspace files, maps each entry to the configuration harness already
 * understands, and mounts one `mcp-client` per server.
 *
 * The plugin does not reimplement MCP. Each server is handed to
 * `@deepseek-ai/dsh-mcp-client` by reference, so namespacing, reconnect
 * policy, tool bridging, and disposal behave exactly as they do for
 * loader-configured servers.
 *
 * @module @l33tdawg/dsh-workspace-mcp
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { mapConfigDocument, toClientConfig, toClientConfigs } from './map.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'workspace-mcp'

/** Services required before mounting: `mcp-client` registers its tools on `ctx.tools`. */
export const inject = ['tools']

/** Files searched inside the workspace when `files` is left at its default. */
const DEFAULT_FILES = ['.mcp.json', '.dsh/mcp.json']

/** Tool-call timeout handed to every server, matching the harness default. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/**
 * A loader-resolved `mcp-client` module: the namespace object, or a promise of
 * it so the config can call `ctx.loader.import(...)`.
 * @typedef {object | Promise<object>} ClientModule
 */

/**
 * Config validator in the Standard Schema form Cordis reads
 * (`Config['~standard'].validate`). Hand-written so the plugin carries no
 * runtime dependency of its own: a version-skewed schema package would either
 * be a second instance of the loader's, or reject configuration silently.
 *
 * @typedef {object} WorkspaceMcpConfig
 * @property {string} root Workspace directory to search; empty means the process working directory.
 * @property {string[]} files Files to read relative to `root`; later files win on a shared server key.
 * @property {Record<string, string>} env Values available to `${env:NAME}` references when permitted.
 * @property {boolean} allowEnv Whether the files may read the harness environment at all.
 * @property {Record<string, string>} envOverrides Values forced on every spawned server.
 * @property {unknown} clientModule The `mcp-client` namespace to mount, when a deployment pins one.
 * @property {boolean} verbose Whether to report every file read and server mounted.
 * @property {number} toolCallTimeoutMs Timeout for one tool call or resource request.
 */

/** Scalars a configuration field may declare, checked against the schema below. */
const FIELD_TYPES = {
  root: 'string',
  files: 'strings',
  env: 'strings-map',
  allowEnv: 'boolean',
  envOverrides: 'strings-map',
  sage: 'sage-config',
  clientModule: 'any',
  verbose: 'boolean',
  toolCallTimeoutMs: 'number',
}

/** Whether a value is a list of strings. */
function isStringList(value) {
  return Array.isArray(value) && value.every((member) => typeof member === 'string')
}

/** Whether a value is a usable per-workspace SAGE mount description. */
function isSageConfig(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (value.command !== undefined && typeof value.command !== 'string') return false
  if (value.args !== undefined && !isStringList(value.args)) return false
  if (value.serverName !== undefined && typeof value.serverName !== 'string') return false
  if (value.env !== undefined) {
    if (typeof value.env !== 'object' || value.env === null || Array.isArray(value.env)) return false
    if (!Object.values(value.env).every((member) => typeof member === 'string')) return false
  }
  return true
}

/** Whether a value matches one declared field type. */
function matchesFieldType(value, kind) {
  if (kind === 'any') return true
  if (kind === 'string') return typeof value === 'string'
  if (kind === 'boolean') return typeof value === 'boolean'
  if (kind === 'number') return Number.isFinite(value)
  if (kind === 'strings') return isStringList(value)
  if (kind === 'strings-map') {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.values(value).every((member) => typeof member === 'string')
  }
  if (kind === 'sage-config') return isSageConfig(value)
  return false
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-workspace-mcp',
    /**
     * Apply defaults and reject unusable values before activation.
     * @param raw - Configuration as written in the loader config.
     * @returns The normalized configuration, or the issues that reject it.
     */
    validate(raw) {
      const input = raw ?? {}
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'config must be an object' }] }
      }
      const issues = []
      for (const [key, kind] of Object.entries(FIELD_TYPES)) {
        if (input[key] !== undefined && !matchesFieldType(input[key], kind)) {
          issues.push({ message: `${key} must be ${kind === 'any' ? 'a module' : kind}`, path: [key] })
        }
      }
      if (issues.length > 0) return { issues }
      return {
        value: {
          root: input.root ?? '',
          files: input.files ?? [...DEFAULT_FILES],
          env: input.env ?? {},
          allowEnv: input.allowEnv ?? false,
          envOverrides: input.envOverrides ?? {},
          sage: input.sage,
          clientModule: input.clientModule,
          verbose: input.verbose ?? false,
          toolCallTimeoutMs: input.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
        },
      }
    },
  },
}

/**
 * Resolve one configured file to an absolute path inside the workspace.
 * @param root - Absolute workspace directory.
 * @param file - Configured absolute or workspace-relative path.
 * @returns The absolute path to search.
 */
function resolveCandidate(root, file) {
  return isAbsolute(file) ? file : resolve(root, file)
}

/**
 * Read and map every configured file that exists.
 * @param root - Absolute workspace directory.
 * @param files - Configured candidate files, in precedence order.
 * @param context - Substitution values shared by every file.
 * @param logger - Sink for per-file results, or undefined when not verbose.
 * @returns Accepted entries in discovery order and every diagnostic.
 */
function readWorkspaceFiles(root, files, context, logger) {
  const entries = []
  const diagnostics = []
  for (const file of files) {
    const path = resolveCandidate(root, file)
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      // Absent is the normal case for a workspace that declares no servers.
      if (error.code !== 'ENOENT') {
        diagnostics.push({ level: 'error', file: path, reason: `cannot read: ${error.message}` })
      }
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      diagnostics.push({ level: 'error', file: path, reason: `invalid JSON: ${error.message}` })
      continue
    }
    const mapped = mapConfigDocument(parsed, path, context)
    entries.push(...mapped.entries)
    diagnostics.push(...mapped.diagnostics)
    logger?.(`${mapped.entries.length} server(s) in ${path}`)
  }
  return { entries, diagnostics }
}

/**
 * Turn whatever the loader handed us into a shape Cordis mounts correctly.
 *
 * Two traps live here, and both are silent:
 *
 * - A module namespace with `name` and `apply` members satisfies Cordis's
 *   `{ apply }` check, but the registry then records an `apply`-named plugin.
 * - `inject` is read off the plugin **function**, so an object plugin's
 *   `inject` is ignored. Without `['tools']` the mounted client fails at tool
 *   registration with `cannot get property "tools" without inject`.
 *
 * Passing one function with `inject` attached, instead of a fresh object per
 * server, also keeps every fiber under a single runtime record.
 *
 * @param clientModule - The `@deepseek-ai/dsh-mcp-client` namespace, or a plugin callback.
 * @returns A plugin function carrying the module's declared dependencies.
 */
function asPlugin(clientModule) {
  const apply = typeof clientModule === 'function' ? clientModule : clientModule?.apply
  if (typeof apply !== 'function') {
    throw new Error('workspace-mcp: clientModule is not @deepseek-ai/dsh-mcp-client (no callable apply export)')
  }
  const plugin = (ctx, config) => apply(ctx, config)
  const inject = typeof clientModule === 'function' ? clientModule.inject : clientModule?.inject
  if (inject !== undefined) plugin.inject = inject
  return plugin
}

/**
 * Mount one `mcp-client` instance per accepted server, as children of this plugin.
 *
 * Each fiber is awaited before the next server starts: `mcp-client` publishes
 * its tools before its fiber activates, so awaiting is what makes the tools
 * present once this plugin finishes activating.
 *
 * @param ctx - Plugin context; children unload with it.
 * @param clientModule - The `@deepseek-ai/dsh-mcp-client` namespace.
 * @param servers - Complete `mcp-client` configurations to mount, in order.
 * @returns A promise that settles once every mounted client has activated.
 */
async function mountServers(ctx, clientModule, servers) {
  const plugin = asPlugin(clientModule)
  for (const server of servers) {
    await ctx.plugin(plugin, server)
  }
}

/**
 * Resolve the `mcp-client` namespace to mount.
 *
 * An explicit `clientModule` wins, because only the deployment knows which
 * installation of the package is the running harness's. Without one a plain
 * import is attempted: a profile-installed plugin resolves through the running
 * installation's dependency graph, so this normally finds the harness's own
 * copy. It has to be that copy — a second installation would keep its own tool
 * registry and register nothing the harness can see.
 *
 * @param configured - The `clientModule` value from configuration, if any.
 * @returns The module namespace, or a promise of it.
 * @throws Error when neither source yields a module.
 */
async function resolveClientModule(configured) {
  if (configured !== undefined && configured !== null) return configured
  try {
    return await import('@deepseek-ai/dsh-mcp-client')
  } catch (error) {
    throw new Error(
      'workspace-mcp: cannot resolve @deepseek-ai/dsh-mcp-client from this installation; set clientModule on the '
      + "plugin loader entry instead, for example clientModule: {!!js ctx.loader.import('@deepseek-ai/dsh-mcp-client')}",
      { cause: error },
    )
  }
}

/**
 * Build the configuration for a workspace's SAGE server.
 *
 * The workspace is the server's working directory, and that is the whole
 * mechanism: `sage-gui mcp` derives its agent identity from the absolute
 * working directory — the basename names the project and the full path picks
 * the key — so each workspace gets its own agent without this plugin computing
 * or pinning anything. Measured: the same path yields the same identity on
 * every run, and the same basename under a different parent yields a different
 * one.
 *
 * @param workspace - Absolute workspace directory.
 * @param sage - SAGE configuration from the plugin config.
 * @param toolCallTimeoutMs - Timeout for one tool call or resource request.
 * @returns A configuration `mcp-client` accepts as-is.
 */
export function toSageConfig(workspace, sage, toolCallTimeoutMs) {
  return {
    transport: 'stdio',
    serverName: sage.serverName ?? 'sage',
    command: sage.command ?? '/Applications/SAGE.app/Contents/MacOS/sage-gui',
    args: [...(sage.args ?? ['mcp'])],
    env: { SAGE_PROVIDER: 'dsh', ...sage.env },
    // The identity mechanism. Never inherit the harness process directory.
    cwd: workspace,
    failOnStartupError: false,
    toolCallTimeoutMs,
  }
}

/**
 * Read the workspace's declared MCP servers, then its SAGE server, and register each one.
 * @param ctx - Cordis context carrying the tool registry.
 * @param config - Resolved plugin configuration.
 * @returns A promise that settles once every server is mounted.
 */
export async function apply(ctx, config) {
  const logger = config.verbose ? (message) => ctx.logger.info('[workspace-mcp] %s', message) : undefined
  const root = config.root === '' ? process.cwd() : resolve(config.root)
  const env = config.allowEnv ? { ...process.env, ...config.env } : undefined
  const context = {
    scope: { workspaceFolder: root, cwd: root, ...(env === undefined ? {} : { env }) },
    envOverrides: config.envOverrides,
  }
  const read = readWorkspaceFiles(root, config.files, context, logger)
  const accepted = toClientConfigs(read.entries, context)
  for (const diagnostic of [...read.diagnostics, ...accepted.diagnostics]) {
    const where = diagnostic.server === undefined ? diagnostic.file : `${diagnostic.server} (${diagnostic.file})`
    if (diagnostic.level === 'error') ctx.logger.error('[workspace-mcp] %s: %s', where, diagnostic.reason)
    else ctx.logger.warn('[workspace-mcp] %s: %s', where, diagnostic.reason)
  }

  const servers = [...accepted.entries.map((entry) => toClientConfig(entry, config.envOverrides, config.toolCallTimeoutMs))]
  if (config.sage !== undefined) servers.push(toSageConfig(root, config.sage, config.toolCallTimeoutMs))
  if (servers.length === 0) {
    logger?.(`no MCP servers declared in ${root}, and no SAGE workspace agent configured`)
    return
  }

  const clientModule = await resolveClientModule(config.clientModule)
  await mountServers(ctx, clientModule, servers)
  logger?.(`mounted ${servers.length} server(s) for ${root}`)
}

export { mapConfigDocument, toClientConfig, toClientConfigs }
