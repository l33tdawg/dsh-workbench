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
 * @property {boolean} perAgent Mount once per live root agent, from that agent's session workspace.
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
  perAgent: 'boolean',
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
  if (value.identities !== undefined) {
    if (typeof value.identities !== 'object' || value.identities === null || Array.isArray(value.identities)) return false
    if (!Object.entries(value.identities).every(([k, v]) => typeof k === 'string' && typeof v === 'string')) return false
  }
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
          perAgent: input.perAgent ?? false,
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
 * Identity is pinned with `SAGE_IDENTITY_PATH` whenever the deployment names
 * one, because that is the only rule SAGE applies unconditionally: its
 * resolution order is `SAGE_IDENTITY_PATH`, then `SAGE_AGENT_KEY`, then a
 * per-project key derived from the working directory (`cmd/sage-gui/mcp.go`).
 * `SAGE_PROJECT` is never consulted for identity.
 *
 * This matters because the derivation is not reliable inside a GUI host: the
 * Electron app reuses its own working directory for spawned children, so a
 * derived identity comes out named after the profile and changes with it. The
 * `cwd` below is still set, since it is correct for command-line hosts and the
 * least surprising thing for a per-workspace server, but identity must not
 * depend on it.
 *
 * @param workspace - Absolute workspace directory.
 * @param sage - SAGE configuration from the plugin config.
 * @param toolCallTimeoutMs - Timeout for one tool call or resource request.
 * @returns A configuration `mcp-client` accepts as-is.
 */
export function toSageConfig(workspace, sage, toolCallTimeoutMs) {
  const identity = sage.identities?.[workspace]
  return {
    transport: 'stdio',
    serverName: sage.serverName ?? 'sage',
    command: sage.command ?? '/Applications/SAGE.app/Contents/MacOS/sage-gui',
    args: [...(sage.args ?? ['mcp'])],
    env: {
      SAGE_PROVIDER: 'dsh',
      ...sage.env,
      // Applied last so a workspace pin cannot be shadowed by a generic env map.
      ...(identity === undefined ? {} : { SAGE_IDENTITY_PATH: identity }),
    },
    cwd: workspace,
    failOnStartupError: false,
    toolCallTimeoutMs,
  }
}

/**
 * Report file-read and entry-mapping diagnostics through a mounting context.
 * @param target - Context whose logger receives the diagnostics.
 * @param diagnostics - Diagnostics collected while reading and mapping.
 */
function reportDiagnostics(target, diagnostics) {
  for (const diagnostic of diagnostics) {
    const where = diagnostic.server === undefined ? diagnostic.file : `${diagnostic.server} (${diagnostic.file})`
    if (diagnostic.level === 'error') target.logger.error('[workspace-mcp] %s: %s', where, diagnostic.reason)
    else target.logger.warn('[workspace-mcp] %s: %s', where, diagnostic.reason)
  }
}

/**
 * Read one workspace's declared servers and mount them, plus its SAGE server, into a context.
 *
 * Every mounted server is given `cwd` when it declares none. Without that the
 * child inherits the harness process working directory, which in a GUI host is
 * the profile directory rather than the session's workspace. SAGE derives an
 * agent identity from that directory, so the child would sign as the profile
 * instead of as the workspace it belongs to.
 *
 * @param target - Context to mount into: the plugin context for a process-wide mount, or one agent's scope.
 * @param workspace - Absolute workspace directory whose files are read.
 * @param config - Resolved plugin configuration.
 * @param clientModule - The `mcp-client` namespace to mount.
 * @param logger - Sink for verbose progress, or undefined when not verbose.
 * @returns A promise that settles once every mounted client has activated.
 */
async function mountWorkspace(target, workspace, config, clientModule, logger) {
  const env = config.allowEnv ? { ...process.env, ...config.env } : undefined
  const context = {
    scope: { workspaceFolder: workspace, cwd: workspace, ...(env === undefined ? {} : { env }) },
    envOverrides: config.envOverrides,
  }
  const read = readWorkspaceFiles(workspace, config.files, context, logger)
  const accepted = toClientConfigs(read.entries, context)
  reportDiagnostics(target, [...read.diagnostics, ...accepted.diagnostics])

  const servers = accepted.entries.map((entry) => {
    const server = toClientConfig(entry, config.envOverrides, config.toolCallTimeoutMs)
    return server.cwd === undefined || server.cwd === '' ? { ...server, cwd: workspace } : server
  })
  const sageName = config.sage?.serverName ?? 'sage'
  // A workspace that declares its own SAGE server wins. Mounting the configured
  // one as well would claim the same serverName twice, which `mcp-client`
  // refuses by aborting the boot. The workspace file is also where SAGE itself
  // reads a pinned identity from, so it is the more specific declaration.
  if (config.sage !== undefined && !servers.some((server) => server.serverName === sageName)) {
    servers.push(toSageConfig(workspace, config.sage, config.toolCallTimeoutMs))
  } else if (config.sage !== undefined) {
    logger?.(`SAGE server declared by the workspace as "${sageName}"; using it instead of the configured default`)
  }
  if (servers.length === 0) {
    logger?.(`no MCP servers declared in ${workspace}, and no SAGE workspace agent configured`)
    return
  }

  await mountServers(target, clientModule, servers)
  logger?.(`mounted ${servers.length} server(s) for ${workspace}`)
}

/**
 * The workspace one agent works in: the working directory its session recorded.
 *
 * A session that recorded none — detached, legacy, or created without one — falls
 * back to the configured root, or to the process working directory when empty.
 *
 * @param agent - Live agent whose session header is inspected.
 * @param config - Resolved plugin configuration.
 * @returns An absolute workspace directory.
 */
function agentWorkspace(agent, config) {
  const recorded = agent.session?.header?.cwd
  if (typeof recorded === 'string' && recorded !== '') return recorded
  return config.root === '' ? process.cwd() : resolve(config.root)
}

/**
 * Read the workspace's declared MCP servers, then its SAGE server, and register each one.
 *
 * With `perAgent` the servers are mounted once per live root agent, in that
 * agent's own scope and from that agent's session workspace, so each workspace
 * gets its own SAGE identity even where the harness process working directory is
 * not the workspace. Without it the mount is process-wide, exactly as before.
 *
 * @param ctx - Cordis context carrying the tool registry.
 * @param config - Resolved plugin configuration.
 * @returns A promise that settles once every server is mounted.
 */
export async function apply(ctx, config) {
  const logger = config.verbose ? (message) => ctx.logger.info('[workspace-mcp] %s', message) : undefined
  const clientModule = await resolveClientModule(config.clientModule)

  if (config.perAgent === true) {
    const mounted = new Set()
    const mountAgent = (agent) => {
      if (mounted.has(agent.id)) return
      mounted.add(agent.id)
      Promise.resolve(mountWorkspace(agent.ctx, agentWorkspace(agent, config), config, clientModule, logger))
        .catch((error) => {
          ctx.logger.error('[workspace-mcp] agent "%s": mount failed: %s', agent.id, error?.message ?? String(error))
        })
    }
    // `agents` is injected dynamically: a host with no agent registry (a bare CLI
    // boot) must still load this plugin, it simply never enters this mode.
    ctx.inject(['agents'], (scoped) => {
      for (const agent of scoped.agents.roots()) mountAgent(agent)
      scoped.on('agent/created', ({ agent }) => {
        if (scoped.agents.roots().includes(agent)) mountAgent(agent)
      })
    })
    return
  }

  const root = config.root === '' ? process.cwd() : resolve(config.root)
  await mountWorkspace(ctx, root, config, clientModule, logger)
}

export { mapConfigDocument, toClientConfig, toClientConfigs }
