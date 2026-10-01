/**
 * Pure mapping from a workspace's `.mcp.json` to DeepSeek Harness
 * `mcp-client` configuration: discovery order, entry parsing, variable
 * substitution, and supersession. No Cordis or MCP dependency lives here, so
 * the whole translation is testable without booting a harness.
 *
 * @module @l33tdawg/dsh-workspace-mcp/map
 */

/** Transport selection understood by the `.mcp.json` dialect. */
export type McpJsonTransport = 'stdio' | 'http'

/** One MCP server as the workspace declared it, before variable substitution. */
export interface RawServerEntry {
  /** Absolute path of the file that declared it. */
  readonly file: string
  /** Server key in `mcpServers`, which becomes the tool namespace. */
  readonly name: string
  /** Transport the entry selects. */
  readonly transport: McpJsonTransport
  /** Executable for `stdio` entries. */
  readonly command?: string
  /** Argument vector for `stdio` entries. */
  readonly args?: readonly string[]
  /** Environment declared by the entry. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory declared by the entry. */
  readonly cwd?: string
  /** Endpoint URL for `http` entries. */
  readonly url?: string
  /** Additional request headers for `http` entries. */
  readonly headers?: Readonly<Record<string, string>>
}

/** One problem found while reading a workspace's declarations. */
export interface ServerDiagnostic {
  /** `error` drops the entry; `warning` keeps the rest of the file in play. */
  readonly level: 'error' | 'warning'
  /** File the problem was found in, absolute. */
  readonly file: string
  /** Server key, when the problem belongs to one entry rather than a file. */
  readonly server?: string
  /** Operator-facing explanation. */
  readonly reason: string
}

/** Values a `.mcp.json` file may reference when substitution is permitted. */
export interface SubstitutionScope {
  /** Replaces `${workspaceFolder}` and `${workspaceRoot}`. */
  readonly workspaceFolder: string
  /** Replaces `${cwd}`; the server's own `cwd` when it sets one. */
  readonly cwd: string
  /**
   * Replaces `${env:NAME}`. Omitted — the secure default — makes every
   * `${env:...}` reference an error, so a cloned repository cannot read the
   * harness process environment through its `.mcp.json`.
   */
  readonly env?: Readonly<Record<string, string>>
}

/** One `mcp-client` configuration produced from a workspace declaration. */
export interface McpClientTarget {
  /** Transport discriminant as `mcp-client` spells it. */
  readonly transport: 'stdio' | 'streamable-http'
  /** Tool namespace, taken verbatim from the `.mcp.json` server key. */
  readonly serverName: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  /** Whether a failed initial connection should fail the mounting plugin. */
  readonly failOnStartupError: boolean
}

/** Everything mapping one server entry needs beyond the entry itself. */
export interface MapContext {
  /** Substitution values; `env` omitted refuses `${env:...}`. */
  readonly scope: SubstitutionScope
  /** Environment entries forced on every spawned server. */
  readonly envOverrides?: Readonly<Record<string, string>>
}

/** Outcome of mapping one file's declarations. */
export interface MapResult {
  /** Accepted servers, in declaration order. */
  readonly entries: readonly RawServerEntry[]
  /** Everything rejected or degraded, in discovery order. */
  readonly diagnostics: readonly ServerDiagnostic[]
}

const ENV_REFERENCE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/
const VARIABLE_REFERENCE = /\$\{(env:[A-Za-z_][A-Za-z0-9_]*|workspaceFolder|workspaceRoot|cwd)\}/g

/** Thrown internally when one string cannot be substituted. */
class SubstitutionError extends Error {}

/**
 * Substitute the references a `.mcp.json` file may carry.
 *
 * Only whole-token `${env:NAME}` is accepted; an `env` reference embedded in a
 * longer string stays literal, which keeps secrets out of command lines that
 * a file happened to compose.
 *
 * @param value - Raw string from the file.
 * @param scope - Values the file may reference.
 * @returns The substituted string.
 * @throws SubstitutionError when an `env` reference is present and `scope.env` is omitted, or names an unset variable.
 */
function substitute(value: string, scope: SubstitutionScope): string {
  if (ENV_REFERENCE.test(value)) {
    const name = ENV_REFERENCE.exec(value)![1]!
    if (scope.env === undefined) {
      throw new SubstitutionError(`\${env:${name}} is refused: workspace files cannot read the harness environment`)
    }
    const resolved = scope.env[name]
    if (resolved === undefined) throw new SubstitutionError(`\${env:${name}} names an unset variable`)
    return resolved
  }
  return value.replace(VARIABLE_REFERENCE, (match, reference: string) => {
    if (reference === 'workspaceFolder' || reference === 'workspaceRoot') return scope.workspaceFolder
    if (reference === 'cwd') return scope.cwd
    throw new SubstitutionError(`${match} is only substituted as a whole value`)
  })
}

/** Whether a parsed JSON value is a plain object rather than an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a string-valued map, ignoring non-string members. */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, member] of Object.entries(value)) {
    if (typeof member === 'string') out[key] = member
  }
  return out
}

/**
 * Classify one `mcpServers` member and substitute every string it carries.
 *
 * @param name - Server key, which becomes the tool namespace.
 * @param raw - The member's parsed JSON value.
 * @param file - Declaring file, for diagnostics.
 * @param scope - Substitution values.
 * @returns The entry, or the reason it was refused.
 */
function mapEntry(
  name: string, raw: unknown, file: string, scope: SubstitutionScope,
): { entry: RawServerEntry } | { diagnostic: ServerDiagnostic } {
  const fail = (reason: string): { diagnostic: ServerDiagnostic } => ({
    diagnostic: { level: 'error', file, server: name, reason },
  })
  if (!isRecord(raw)) return fail('entry is not an object')
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    return fail('server key must match [A-Za-z0-9_-]{1,32} because it becomes the tool namespace')
  }
  const url = raw['url']
  const command = raw['command']
  const declaredType = raw['type']
  if (declaredType === 'sse') {
    return fail('"sse" is the retired HTTP+SSE transport; point the entry at a Streamable HTTP endpoint or use stdio')
  }
  try {
    if (typeof url === 'string') {
      const headers = stringMap(raw['headers'])
      if (raw['headers'] !== undefined && headers === undefined) return fail('"headers" must be an object of strings')
      const resolved: Record<string, string> = {}
      for (const [key, value] of Object.entries(headers ?? {})) resolved[key] = substitute(value, scope)
      return {
        entry: {
          file,
          name,
          transport: 'http',
          url: substitute(url, scope),
          headers: resolved,
        },
      }
    }
    if (typeof command !== 'string' || command === '') {
      return fail('entry needs a "command" (stdio) or a "url" (Streamable HTTP)')
    }
    const rawArgs = raw['args']
    if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== 'string'))) {
      return fail('"args" must be an array of strings')
    }
    const rawEnv = raw['env']
    if (rawEnv !== undefined && !isRecord(rawEnv)) return fail('"env" must be an object')
    for (const member of Object.values(isRecord(rawEnv) ? rawEnv : {})) {
      if (typeof member !== 'string') return fail('"env" values must be strings')
    }
    const rawCwd = raw['cwd']
    if (rawCwd !== undefined && typeof rawCwd !== 'string') return fail('"cwd" must be a string')
    const cwd = typeof rawCwd === 'string' ? substitute(rawCwd, scope) : undefined
    const entryScope: SubstitutionScope = { ...scope, cwd: cwd ?? scope.cwd }
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(stringMap(rawEnv) ?? {})) env[key] = substitute(value, entryScope)
    return {
      entry: {
        file,
        name,
        transport: 'stdio',
        command: substitute(command, entryScope),
        args: (rawArgs as string[] | undefined)?.map((arg) => substitute(arg, entryScope)) ?? [],
        env,
        ...(cwd === undefined ? {} : { cwd }),
      },
    }
  } catch (error) {
    if (error instanceof SubstitutionError) return fail(error.message)
    throw error
  }
}

/**
 * Map one parsed `.mcp.json` document into server entries.
 *
 * @param parsed - Parsed JSON of the file.
 * @param file - Absolute path, for diagnostics and supersession messages.
 * @param context - Substitution values and forced environment.
 * @returns Accepted entries in declaration order, plus diagnostics.
 */
export function mapConfigDocument(parsed: unknown, file: string, context: MapContext): MapResult {
  if (!isRecord(parsed)) {
    return { entries: [], diagnostics: [{ level: 'error', file, reason: 'file does not contain a JSON object' }] }
  }
  const servers = parsed['mcpServers']
  if (servers === undefined) {
    return { entries: [], diagnostics: [{ level: 'warning', file, reason: 'no "mcpServers" key; nothing to register' }] }
  }
  if (!isRecord(servers)) {
    return { entries: [], diagnostics: [{ level: 'error', file, reason: '"mcpServers" must be an object' }] }
  }
  const entries: RawServerEntry[] = []
  const diagnostics: ServerDiagnostic[] = []
  for (const [name, raw] of Object.entries(servers)) {
    if (isRecord(raw) && raw['disabled'] === true) continue
    const mapped = mapEntry(name, raw, file, context.scope)
    if ('entry' in mapped) entries.push(mapped.entry)
    else diagnostics.push(mapped.diagnostic)
  }
  return { entries, diagnostics }
}

/**
 * Convert declared entries into `mcp-client` configurations.
 *
 * A later file supersedes an earlier declaration of the same server, because
 * that is how a workspace file is expected to override a shared one; the
 * dropped declaration is reported rather than silently losing to load order.
 *
 * @param entries - Accepted entries, in discovery order.
 * @param context - Substitution values and forced environment.
 * @returns Configurations in first-declaration order, plus supersession notes.
 */
export function toClientConfigs(entries: readonly RawServerEntry[], context: MapContext): MapResult {
  const lastIndex = new Map<string, number>()
  entries.forEach((entry, index) => lastIndex.set(entry.name, index))
  const diagnostics: ServerDiagnostic[] = []
  const targets: RawServerEntry[] = []
  entries.forEach((entry, index) => {
    const winner = lastIndex.get(entry.name)!
    if (winner === index) {
      targets.push(entry)
      return
    }
    diagnostics.push({
      level: 'warning',
      file: entry.file,
      server: entry.name,
      reason: `superseded by the same server declared in ${entries[winner]!.file}`,
    })
  })
  return { entries: targets, diagnostics }
}

/** Add an optional member only when it has a value, so a produced config stays literally comparable. */
function withTimeout(target: McpClientTarget, toolCallTimeoutMs: number | undefined): McpClientTarget {
  return toolCallTimeoutMs === undefined ? target : { ...target, toolCallTimeoutMs }
}

/**
 * Build the configuration object handed to `mcp-client` for one entry.
 *
 * @param entry - Accepted entry from a workspace file.
 * @param envOverrides - Environment forced on every spawned server.
 * @returns A configuration `mcp-client` accepts as-is.
 */
export function toClientConfig(
  entry: RawServerEntry,
  envOverrides?: Readonly<Record<string, string>>,
  toolCallTimeoutMs?: number,
): McpClientTarget {
  if (entry.transport === 'http') {
    return withTimeout({
      transport: 'streamable-http',
      serverName: entry.name,
      url: entry.url!,
      headers: { ...entry.headers },
      failOnStartupError: false,
    }, toolCallTimeoutMs)
  }
  return withTimeout({
    transport: 'stdio',
    serverName: entry.name,
    command: entry.command!,
    args: [...(entry.args ?? [])],
    // Forced values win over the file: the deploying operator, not the file, decides what a server is told.
    env: { ...entry.env, ...envOverrides },
    cwd: entry.cwd ?? '',
    failOnStartupError: false,
  }, toolCallTimeoutMs)
}
