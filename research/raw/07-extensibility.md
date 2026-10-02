# 07 — Extensibility: MCP, Skills, Plugins/Hooks, Subagents, Memory, Configuration

**Axis:** extensibility (MCP, skills, plugins/hooks, subagents, memory, configuration)
**Method:** read-only source inspection. No files modified in either tree.
**DSH:** `/Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src` @ `639ed015397290b3745d163aafe02ffee4aa3f84` (tag `dsh-v0.2.0-rc.2`)
**CODEX:** `/Users/l33tdawg/nodejs-projects/codex` @ `2abb02bc004fe2847d1f99f47610c92d1744b22d`

**Evidence convention.** Every claim carries `file:line` (relative to the tree root named above) and a short quote where it matters.
**VERIFIED** = read directly in source or docs at the cited line. **INFERRED** = my deduction or judgement, not a literal source claim.

**Note on the Codex tree.** This SHA is not vanilla upstream Codex: it carries `codex-rs/ext/` (14 extension crates, 51 363 lines), `plugin`/`core-plugins` (a plugin *marketplace*), `memories`, `hooks`, and `worktree`. Statements below describe **this tree**.

---

## 0. Surface-size map

| DSH package | files | lines | Codex crate | files | lines |
|---|---:|---:|---|---:|---:|
| `packages/mcp` | 23 | 5 332 | `rmcp-client` | 75 | 28 142 |
| `packages/skill` | 15 | 7 462 | `codex-mcp` | 43 | 20 984 |
| `packages/subagent` | 114 | 34 747 | `mcp-server` | 20 | 4 167 |
| `packages/workflow` | 36 | 7 168 | `skills` | 17 | 2 566 |
| `packages/hooks` | 33 | 4 944 | `ext/skills` | 82 | 22 063 |
| `packages/preset` | 20 | 2 211 | `plugin` | 7 | 914 |
| `packages/bundle` | 29 | 4 637 | `core-plugins` | 77 | 43 557 |
| `packages/schedule` | 31 | 10 141 | `hooks` | 34 | 15 037 |
| `packages/settings` | 12 | 1 504 | `memories` + `ext/memories` | 28 + 19 | 5 131 + 2 506 |
| | | | `config` | 72 | 25 536 |
| | | | `features` | 4 | 3 130 |
| | | | `worktree` | 6 | 621 |

Counts are `find … -name '*.ts'`/`'*.rs'` and `cat | wc -l`. **VERIFIED.**
The headline: DSH invests in **subagents** (34 747 lines) and **app composition**; Codex invests in **MCP** (49 126 lines across `rmcp-client` + `codex-mcp` + `mcp-server`), **skills** (24 629), and **plugins** (44 471).

---

## 1. MCP — maturity comparison

### 1.1 Transport

| | DSH | Codex |
|---|---|---|
| stdio | yes — `packages/mcp/mcp-client/src/transport.ts:33-39` (`StdioClientTransport`) | yes — `codex-rs/config/src/mcp_types.rs:534-545` (`Stdio { command, args, env, env_vars, cwd }`) |
| Streamable HTTP | yes — `transport.ts:40-43` (`StreamableHTTPClientTransport`) | yes — `config/src/mcp_types.rs:546-567` (`StreamableHttp { url, bearer_token_env_var, http_headers, env_http_headers, http_headers_helper }`) |
| HTTP+SSE (legacy) | refused | absent |

DSH declares exactly two transport variants and nothing else:
> `export type Config = StdioConfig | StreamableHttpConfig` — `packages/mcp/mcp-client/src/index.ts:104`

Codex likewise declares exactly two:
> `pub enum McpServerTransportConfig { Stdio { … }, StreamableHttp { … } }` — `config/src/mcp_types.rs:533-567`

**VERIFIED: transport parity — two transports each, no SSE on either side.** For DSH the SSE refusal is deliberate and surfaced by the workspace plugin (`README.md:171`: *"`"type": "sse"` is refused: the HTTP+SSE transport is retired"*).

DSH adds one transport nicety Codex lacks: a **negotiation probe**. Stdio negotiation starts a throwaway process before the serving process, so an incompatible server is discovered before the real child is committed:
> *"stdio negotiation starts a temporary probe process before the serving process"* — `packages/mcp/mcp-client/README.md`

It also scrubs the ambient environment before spawning a child, sharing the definition with the subprocess seam rather than re-implementing it:
> `function buildChildEnv(extra) { return { ...scrubbedParentEnv(), ...extra } }` — `transport.ts:27-29`

### 1.2 Auth — the largest single MCP gap

**Codex has a full OAuth 2 stack. DSH has static headers and nothing else.**

Codex, from filenames alone (`codex-rs/rmcp-client/src/`): `oauth.rs`, `oauth_callback.rs`, `oauth_client_registration.rs`, `perform_oauth_login.rs`, `oauth_http_client.rs`, `oauth_http_client_security_tests.rs`, `www_authenticate.rs`, `auth_status.rs`, plus an enterprise identity path (`ema_auth_policy.rs`, `ema_claims.rs`, `ema_exchange.rs`, `ema_identity.rs`). `oauth_client_registration.rs` implies dynamic client registration and `www_authenticate.rs` implies 401-challenge discovery. `auth_status.rs` implies a queryable login state. **VERIFIED (file inventory + the `perform_oauth_login` entry point).**

Codex's config surface for auth is correspondingly richer (`config/src/mcp_types.rs:549-563`):
> `bearer_token_env_var` — *"Name of the environment variable to read for an HTTP bearer token."*
> `env_http_headers` — headers whose values come from env vars
> `http_headers_helper` — *"Local-only shell command that prints a JSON object of dynamic HTTP headers."*

DSH's entire HTTP auth surface is:
> `headers: Record<string, string>` — "Additional headers attached to MCP requests." — `packages/mcp/mcp-client/src/index.ts:91-92`

A grep for `oauth|bearer|refresh_token|pkce` across `packages/mcp/` returns **only test fixtures** (`tests/mcp-client.spec.ts:1125`, `tests/apply.spec.ts:436`, `tests/mcp-client.e2e.ts:512,554` — literal `'Bearer …'` strings). No OAuth code, no token store, no refresh, no login command. **VERIFIED.**

DSH does ship a `packages/credentials/` group (`authorization`, `credentials`, `credentials-local`, `deepseek-account`, `deepseek-account-platform`), but `mcp-client` does not inject it — its declared dependencies are `export const inject = ['tools']` (`index.ts:34`). So credentialed MCP auth is *possible* in the platform but **not wired to MCP**. **VERIFIED.**

**Consequence for this workspace.** `dsh-workspace-mcp` reads `.mcp.json`, which carries static `headers`. For OAuth-protected remote servers the only options today are (a) a pre-obtained static token, or (b) `envOverrides` + a `${env:NAME}` header. There is no refresh path, so a rotating token breaks on expiry. See Recommendation R1.

### 1.3 Tool-name namespacing

Both use the same public shape, `mcp__<server>__<tool>`:

- DSH: `packages/mcp/mcp-client/src/tools.ts:81-87`
  ```ts
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
  ```
  with `MAX_PUBLIC_NAME_LENGTH = 64` (`tools.ts:48`) and `HASH_LENGTH = 12` (`tools.ts:54`).
- Codex: `codex-mcp/src/tools.rs:225-226` — `MCP_TOOL_NAME_DELIMITER = "__"`, `MAX_TOOL_NAME_LENGTH = 128`; `LEGACY_MCP_TOOL_NAME_PREFIX = "mcp__"` (`tools.rs:22`); hash suffix via `append_hash_suffix`/`append_namespace_hash_suffix` (`tools.rs:139-210`).

Neither parses the public name to recover the raw one. DSH states the invariant explicitly and it is the stronger documentation of the two:
> *"The raw name is only ever sent on the wire (`tools/call`); the public name is never parsed to recover it."* — `tools.ts:9-10`

**Codex's scheme is more complete at the namespace level.** Codex normalizes and de-duplicates both `callable_namespace` *and* `callable_name`, hashing each independently when a collision is detected (`tools.rs:153-181`):
> *"`callable_namespace` / `callable_name` are sanitized and, when necessary, hashed so every model-visible name is unique and <= 128 bytes."* — `tools.rs:108-111`

DSH de-duplicates only the flattened public name (two servers both offering `search` are fine because `serverName` is in the string — `README.md`, *"Tool naming and coexistence"*), and rejects a duplicate *within* one server's list outright (`tools.rs:126-130`). Both reserve the server name against collisions: DSH via `activeServerNames` scoped by registration scope (`index.ts:47,162-176`), Codex via config validation. **Net: functional parity, Codex mildly stronger; DSH's 64-char budget is tighter and forces a hash on long names sooner (INFERRED from the two constants).**

Note DSH's namespace is **scope-aware**: two agents may each own a server named `sage` while two *global* instances may not:
> *"Agent-scoped MCP servers may reuse a namespace in another Agent, while global instances and duplicates inside one Agent remain mutually exclusive."* — `index.ts:43-46`

Codex has no visible per-agent namespace reuse. **DSH advantage (VERIFIED for DSH; absence in Codex is an absence-of-evidence claim, INFERRED).**

### 1.4 Lazy tool surfacing — Codex wins, and DSH's `deferLoading` is not the same thing

**Codex has a real tool-search / deferred-exposure mechanism.**

- `ToolExposure` has explicit `Deferred` / `DeferredModelOnly` variants:
  > `/// … model-visible tool list. Deferred tools must provide search metadata via …` — `codex-rs/tools/src/tool_executor.rs:51-88`
- MCP tools are moved into deferred exposure per turn by `apply_mcp_tool_exposure_policy` (`codex-rs/core/src/tools/spec_plan.rs:205-275`), gated on `search_tool_enabled`:
  ```rust
  exposures = if search_tool_enabled(turn_context, model_info) && exposures.contains(ToolExposures::DEFERRED) … {
      exposures.difference(ToolExposures::DIRECT)
  } else { exposures.difference(ToolExposures::DEFERRED) }
  ```
  (`spec_plan.rs:253-261`)
- `search_tool_enabled` = model supports the search tool **and** the provider supports namespace tools (`spec_plan.rs:651-653`).
- Per-server opt-out exists: `server.config().omit_tools_from` (`spec_plan.rs:220-228`).
- The model calls a genuine tool: `create_tool_search_tool` (`core/src/tools/handlers/tool_search_spec.rs:16`), function name `tool_search_tool` (`core/src/tools/tool_namespaces_info.rs:16`), with a 512 KiB cap on rendered source descriptions (`tool_search_spec.rs:10`).

**DSH has no tool search.** A grep for `toolSearch|tool_search|searchTools` across `packages/` returns **zero** non-test hits. **VERIFIED.**

DSH *does* have a field called `deferLoading`, and it is easy to mistake for the same feature. It is not. It is a **prompt-cache optimisation** that defers a tool *declaration* into conversation history rather than searching for it:
> *"Requests deferred loading of the tool definition into model context … Uses Anthropic's `defer_loading` terminology."* — `packages/llm/llm/src/types.ts:473-479`
> `ToolUpdate = 'in-history' | 'addition-only'` — *"`'addition-only'`: the model reads a `tool-addition` block in a later developer message as activating a tool declared with `deferLoading`…"* — `types.ts:398-403`

The provider-visible effect is a serialization flag, not a search index:
> `...tool.deferLoading === true ? { defer_loading: true as const } : {}` — `packages/llm/llm-deepseek/src/serialize.ts:164`
> and DSH injects `deferLoading: true` onto history-replayed additions — `packages/llm/llm/src/content.ts:391`

Crucially, when the route does not support mid-conversation tool updates, DSH **strips the flag and declares everything immediately**:
> `if (tools?.some(tool => tool.deferLoading === true)) { immediateTools = tools.map(({ deferLoading: _loading, ...tool }) => tool) }` — `content.ts:433-435`

So on an unsupported route DSH's entire tool list is always present. **VERIFIED.**

**Verdict.** Codex can run a server with 80 tools and show the model one search tool. DSH shows all 80. At a handful of MCP servers this is academic; with a large `.mcp.json` — exactly what `dsh-workspace-mcp` encourages by reading a workspace file with `mcpServers` — it becomes a real context and tool-selection cost. See Recommendation R2.

### 1.5 Resources and prompts

| | DSH | Codex |
|---|---|---|
| resources | yes — three shared tools | yes — client only |
| resource templates | yes | not found |
| prompts | **no** | **no** |

DSH exposes resources as three *shared* tools registered once per scope that has at least one provider, rather than one tool set per server:
> `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` — `packages/mcp/mcp-resources/src/tools.ts:34-64`

with explicit server selection as a parameter (`tools.ts:18-21`), scope-aware provider resolution that fails before any network call (`index.ts:135-140`), and a prompt section advertising the available server names (`index.ts:57-70`). Resource operations route through the live connection generation and are rejected when disconnected:
> `if (!generation || connectedAt === undefined) throw new Error(`${label}: server is disconnected`)` — `packages/mcp/mcp-client/src/connection.ts:368-369`

Codex has `read_resource` on the client (`codex-mcp/src/resource_client.rs:217`) but no equivalent advertised triple of tools was found. **INFERRED (absence of evidence).**

Prompts: a grep for `get_prompt|list_prompts|PromptCapability` across `codex-mcp/src` and `rmcp-client/src` returns **nothing**, and DSH documents the gap in prose:
> *"MCP prompt templates are unsupported."* — `packages/mcp/mcp-client/README.md`

**VERIFIED: parity at zero on MCP prompts.** Neither harness can turn a server's prompt templates into slash commands or tools.

### 1.6 Error handling

DSH's error discipline is the most carefully specified part of its MCP client, and it is better than Codex's here.

- **Atomic tool-set swap.** Two phases; the fetch phase builds the whole next generation and only then does the swap dispose the previous one. A failure in either phase leaves the model seeing the full previous set or none — never a partial set:
  > *"A registry conflict here can only mean a foreign registration squats on this server's `mcp__<serverName>__` namespace — the partial generation is rolled back (zero tools from this server)"* — `tools.ts:96-103`, implemented at `tools.ts:145-161`
- **Duplicate listing is rejected, previous set preserved:** `throw new Error(… server listed tool "${tool.name}" more than once — invalid tool list)` — `tools.ts:126-130`.
- **Server-reported errors are surfaced as failures, not fake successes:**
  > `if (result.isError === true) { throw new Error(text) }` — `tools.ts:296-299`
  > *"If the server reports an error, the call fails visibly — the model does not see a fake success."* — `README.md`
- **Result validation before projection:** the raw result is schema-validated and an invalid result throws with issue text (`tools.ts:287-290`).
- **Declared-but-unsupported protocol features are refused, not silently ignored:**
  > `throw new Error(\`Tool "${rawName}" requires task-based execution, which this bridge does not support\`)` — `tools.ts:279-281`
- **Image results degrade with an explicit, per-image diagnostic** rather than vanishing, distinguishing "invalid data" from "not admitted" from "model has no image input" (`tools.ts:376-440`), and every refusal keeps the raw value for programmatic callers.
- **Registration failure policy is per-phase:** strict at startup when `failOnStartupError`, contained on re-syncs (`connection.ts:130-140`).

Codex's comparable mechanisms are a per-server tool allow/deny filter and a catalog cache:
> `ToolFilter { enabled: Option<HashSet<String>>, disabled: HashSet<String> }` — `codex-mcp/src/tools.rs:74-103`
> `TOOL_CATALOG_CACHE_CAPACITY: usize = 32`, `TOOL_CATALOG_CACHE_TTL: Duration = Duration::from_secs(30 * 60)` — `codex-mcp/src/tool_catalog_cache.rs:32-33`

The Codex catalog cache is genuinely useful — it keeps recently-seen tool definitions reusable across reconnects, so a flapping server does not force a fresh `tools/list`. DSH re-lists on every sync:
> `await client.listTools(undefined, { cacheMode: 'refresh' })` — `packages/mcp/mcp-client/src/tools.ts:123`

**Verdict: DSH wins on correctness and diagnosability; Codex wins on catalog reuse.** These are not mutually exclusive; see Recommendation R5.

### 1.7 Timeouts, cancellation, reconnection

**DSH has the more rigorous reconnection design of the two, by a wide margin.**

Timeouts and cancellation (DSH):
> `const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000` — `index.ts:37`, overridable per server (`index.ts:127`)
> `const options = { signal: exec.signal, timeout: config.toolCallTimeoutMs }` — `connection.ts:370`

Every call carries the caller's abort signal, so MCP calls cancel like native tools.

Reconnection (DSH), a bounded-per-outage supervisor (`connection.ts:1-16` documents the whole model):
> `RECONNECT_DEFAULTS = { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 }` — `connection.ts:41-46`
> `const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))` — `connection.ts:236`

Four details that make it more than naive retry:
1. **One shared attempt budget per outage, not per failure.** A connection that stays up past the stability window (= `maxDelayMs`) resets the budget, so a crash-looping server that briefly connects still exhausts the cap instead of restarting forever:
   > `if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0` — `connection.ts:222`
2. **Give-up unregisters the tools** so the model is not offered tools that cannot work, with an actionable message:
   > `giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect` — `connection.ts:233`
3. **A close barrier prevents overlapping child processes.** If a failed generation's transport closure cannot be confirmed within 5 s, reconnection stops rather than starting a second server process:
   > `GENERATION_CLOSE_TIMEOUT_MS = 5_000` — `connection.ts:54`
   > `failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes` — `connection.ts:193`
4. **`listChanged` notifications re-sync the tool set**, and every sync is serialized through one promise chain so two syncs cannot interleave their dispose/register swap (`connection.ts:168-177`, `index.ts:263-269`).

Codex has `rmcp-client/src/streamable_http_retry.rs` (with tests) and a `connection_manager` with deferred startup:
> `let allow_deferred_startup = …` — `codex-mcp/src/connection_manager.rs:254`; `let defer_startup = allow_deferred_startup …` — `connection_manager.rs:535`

Deferred startup is a real property DSH lacks — Codex can boot a session without waiting on an MCP server handshake. But no equivalent of DSH's bounded outage budget, stability-window reset, or close barrier was found. **INFERRED (absence of evidence); I did not exhaustively read all 28 142 lines of `rmcp-client`.**

**Verdict: DSH wins reconnection rigor and cancellation; Codex wins non-blocking startup.** DSH's `ready` promise deliberately blocks activation until the first connect+sync settles, which is why `failOnStartupError` can be meaningful (`index.ts:194-202`) — but it also means a slow server delays boot unless `failOnStartupError: false`, which is exactly the default `dsh-workspace-mcp` uses (`README.md:173-175`). That is the right call and is verified against the real harness (`README.md:202-207`).

### 1.8 Beyond the client

Codex has capabilities DSH's MCP layer simply does not have:

| Capability | Codex | DSH |
|---|---|---|
| elicitation (server asks the user) | yes — `codex-mcp/src/elicitation.rs`, `rmcp-client/src/elicitation_client_service.rs`; policy-gated (`elicitation.rs:265`, `AskForApproval::Granular(config) if !config.allows_mcp_elicitations()`) | no |
| Codex as an MCP *server* | yes — `codex-rs/mcp-server/` (20 files, `main.rs`, `codex_tool_runner.rs`, `exec_approval.rs`, `patch_approval.rs`, `active_turn_registry.rs`) | no first-party MCP server mode (DSH exposes ACP + SDK instead — `packages/bundle/acp-app`, `sdk-app`) |
| progress/logging notifications | yes — `rmcp-client/src/logging_client_handler.rs`, `event_notification_transport.rs` | not found |
| cross-process MCP transport | yes — `executor_process_transport.rs`, `in_process_transport.rs`, `stdio_server_launcher.rs` | stdio child only |
| connection identity / trusted access | yes — `codex-mcp/src/trusted_access.rs`, `binding.rs`, `server.rs` (`McpServerConnectionIdentity`, `has_explicit_http_authorization`) | no |

The elicitation omission matters in one concrete way: DSH cannot let a *server* ask a clarifying question. Everything the server needs must be in the call arguments. **VERIFIED for Codex; NOT FOUND for DSH.**

The absence of MCP-server mode is a deliberate architectural split, not a gap: DSH says so in its own README — *"the `mcp/` group lets the model call external Model Context Protocol (MCP) tools"* (`packages/mcp/README.md`) — and reaches other harnesses through ACP/SDK/subagent drivers instead (see §4). **INFERRED.**

### 1.9 MCP section summary

| Dimension | Winner | Margin |
|---|---|---|
| transports | tie | 2 each, no SSE |
| **auth / OAuth** | **Codex** | decisive — full OAuth + enterprise identity + dynamic headers vs static headers |
| tool namespacing | Codex | mild — namespace-level dedup; DSH better documented |
| **lazy tool surfacing** | **Codex** | decisive — real `tool_search` vs none |
| resources | DSH | mild — three scoped shared tools vs client-only |
| prompts | tie | both absent |
| **error handling** | **DSH** | strong — atomic swap, rollback, no fake successes, typed refusals |
| **reconnection** | **DSH** | strong — bounded outage budget, close barrier, serialized sync |
| non-blocking startup | Codex | deferred startup |
| elicitation / server mode | Codex | absent in DSH |

---

## 2. Skills

### 2.1 Definition and discovery

Both use `SKILL.md` with YAML frontmatter.

**Codex** — `codex-rs/skills/`:
> `/// Validated metadata parsed from a `SKILL.md` frontmatter block.` with `pub name: String, pub description: String, pub short_description: Option<String>` — `skills/src/parser.rs:22-27`
> `const SKILLS_DIR_NAME: &str = "skills";` / `const SYSTEM_SKILLS_DIR_NAME: &str = ".system";` / `SYSTEM_SKILLS_DIR: Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/src/assets/samples");` — `skills/src/lib.rs` (const block at end of file)

Codex **compiles sample skills into the binary** via `include_dir!`, then materialises them to a `.system` directory guarded by a marker file and salt:
> `SYSTEM_SKILLS_MARKER_FILENAME: &str = ".codex-system-skills.marker";` / `SYSTEM_SKILLS_MARKER_SALT: &str = "v1";` — `skills/src/lib.rs`

That is a genuinely different capability: **built-in skills that require no installation.** DSH has no equivalent — its bundled skills arrive as plugin-contributed providers (`BUNDLED_SKILL_RANK`, `packages/skill/skill/src/index.ts:28`). **VERIFIED.**

Codex's parser is also deliberately tolerant of real-world mess:
> *"Some third-party skills use prose like `description: Build for AWS: ECS`"* — `skills/src/parser.rs:53`

Codex's rich metadata goes well beyond DSH's (`skills/src/model.rs`):
```rust
pub struct SkillMetadata {
    pub name, pub description, pub short_description: Option<String>,
    pub interface: Option<SkillInterface>,        // icons, brand colour, default_prompt
    pub dependencies: Option<SkillDependencies>,  // tool deps, incl. MCP servers
    pub policy: Option<SkillPolicy>,              // allow_implicit_invocation, products
    pub path_to_skills_md, pub scope, pub plugin_id, pub remote_plugin_id,
}
```
(`skills/src/model.rs:8-24`). Skill **dependencies** are actionable, not decorative: a mentioned skill's MCP dependencies are promoted into `required_servers` for the turn (`core/src/session/turn.rs:745-760`).

DSH's metadata is narrower but has two properties Codex lacks: a **kebab-case name grammar** enforced at the registry boundary (`const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`, `packages/skill/skill/src/index.ts:25`, exported as `isSkillName`) and a **two-axis invocation policy**:
> `interface SkillInvocationPolicy { readonly modelInvocable: boolean; readonly userInvocable: boolean }` — `packages/skill/skill/src/index.ts:47-53`

`userInvocable` without `modelInvocable` gives a slash-command-only skill, and DSH documents that the path really is separate:
> *"This is the only entry point for `disable-model-invocation` skills; the catalog and the `skill` tool below never see them."* — `packages/skill/tool-skill/src/index.ts:175-176`

Codex models this as a single flag: `allow_implicit_invocation` (`skills/src/model.rs:64-68`). **DSH advantage, minor.**

**Discovery and precedence:**
- DSH: a **provider registry** with scoped layers and precedence ranks — `RUNTIME_RANK = 250`, `BUNDLED_SKILL_RANK = 600` (`packages/skill/skill/src/index.ts:25,28`), *"Lower ranks win duplicate skill names before provider registration order is considered"* (`index.ts:76-79`), plus source buckets `'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled'` (`index.ts:42`). Providers are pluggable — `packages/skill/skill-filesystem` (1 049 lines) is the filesystem one.
- Codex: `LoadedSkills`/`LoadedSkillRoot` snapshots with a `SkillRootSnapshotCache` (`skills/src/loading.rs:23-93`), roots merged by `ext/skills/src/loader/host_merge.rs`, scopes carried as `SkillScope` (`skills/src/model.rs:19`), and providers partitioned into **host / executor / orchestrator / custom** (`ext/skills/src/catalog.rs` — `SkillSourceKind`, `SkillAuthority`, `SkillPackageId`).

**DSH's registry is the cleaner composition seam** (rank-based shadowing, per-agent scoping, `modelInvocable`). **Codex's is the broader one** — it addresses skills that do not live on the local filesystem at all, which DSH cannot express. **VERIFIED.**

### 2.2 Progressive disclosure and context economy

Both practice the core discipline: names + descriptions are advertised, bodies load on demand. The implementations differ sharply in how the catalog is *carried*.

**DSH — per-step injection with digest dedup.** The catalog is not a static system-prompt block; it is re-derived every step and emitted only when it changes (`packages/skill/tool-skill/src/index.ts:210-270`):
> `const digest = digestCatalogEntries(entries)` … `if (history.visibleDigest === digest) { … }` — `tool-skill/src/index.ts:227-236`

and when it does change it is a **replacement**, not an append:
> *"The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session"* — `tool-skill/src/index.ts:275-283`

Descriptions are capped before rendering:
> `const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500` — `tool-skill/src/index.ts:27`

Two further economies: the catalog is emitted **only if this plugin's exact `skill` tool is visible to the calling agent**, so a restricted or shadowed agent pays nothing:
> `const toolVisible = ctx.tools.get(skillTool.name, agent) === skillTool` … `: await ctx.skills.snapshot(…)` : `{ skills: [], complete: true }` — `tool-skill/src/index.ts:220-223`

and the catalog carries a typed durable source so UI/transcript layers read structured entries rather than re-parsing the model-facing prose:
> `export interface SkillCatalogSource { readonly kind: 'skill-catalog'; readonly form: 'catalog'; … readonly entries: readonly { name, description }[] }` — `tool-skill/src/index.ts:29-45`
> *"a consumer presenting the list must not re-parse the `<available_skills>` block, whose framing exists for the model"* — `tool-skill/src/index.ts:29-34`

**Codex — a developer block, plus a large behavioural preamble.** The catalog is a `<skills_instructions>` developer message whose injection is configurable:
> `/// Whether to inject the `<skills_instructions>` developer block.` / `pub include_skill_instructions: bool` — `codex-rs/core/src/config/mod.rs:696-697`

built per turn in `build_skills_and_plugins` (`core/src/session/turn.rs:773`). The prompt is **not** a bare list — it is a template selected from three variants by skill source kind (`ext/skills/src/catalog_prompt.rs:55-80`):
> `enum SkillPromptKind { Unaliased, HostAliases, ResourceAliases }` — `catalog_prompt.rs:50-54`

and the "how to use" half is a long block of hard-coded behavioural instruction (~20 lines) covering trigger rules, read-completely-before-acting, reference-chasing limits, coordination, context hygiene, and a *"Do not delegate reading, summarizing, or interpreting skill instructions to a subagent"* rule (`catalog_prompt.rs:9-16`).

That preamble is not free — it is emitted whenever skills are present. **It buys something DSH does not have: alias tables.** Non-filesystem skills are addressed by short package locators resolved against a `### Skill roots` table (`catalog_prompt.rs:3-5`, `RESOURCE_ALIAS_INSTRUCTIONS` at `catalog_prompt.rs:6`), and host skills get short paths expanded via aliases.

**Codex's context-economy levers that DSH lacks:**
1. **Cheap pre-selection.** Ten interchangeable selectors — BM25, character n-gram, routing-card, and LRU hybrids including RRF fusion (`ext/skills/src/dynamic_skill_selector.rs:1-20`) — run **in shadow mode** as an experiment: *"Implementations must be deterministic, side-effect free, and cheap enough to run in shadow mode on every turn"* (`dynamic_skill_selector.rs:53-58`). This is aimed squarely at catalogs too large to inject wholesale. **DSH has no selector at all.**
2. **Structured, paginated reading.** A `skills` tool namespace (`ext/skills/src/tools/mod.rs:54`) exposing `list` and `read` with a bounded response:
   > `const MAX_SKILL_RESPONSE_BYTES: usize = 512 * 1024;` / `const MAX_HANDLE_BYTES: usize = 2_048;` — `tools/mod.rs:55-56`
   and *"If a read is paginated, follow `next_cursor` until EOF"* (`catalog_prompt.rs:10`). DSH's `skill` tool returns the whole body in one result with no pagination.
3. **Per-agent suppression.** A child session can have skill instructions removed entirely:
   > `next_config.include_skill_instructions = false;` — `core/src/agent/role.rs:223`
   DSH's nearest equivalent is per-agent provider scoping plus `modelInvocable` — coarser.

**DSH's context-economy levers that Codex lacks:**
1. **Digest-based no-op suppression** (`tool-skill/src/index.ts:227-236`) — an unchanged catalog costs nothing after the first step. Codex rebuilds the developer block per turn (`core/src/session/turn.rs:773`) and relies on provider caching.
2. **500-character description cap** (vs Codex's much larger `MAX_TOOL_SEARCH_SOURCE_DESCRIPTION_BYTES = 512 * 1024` budget philosophy elsewhere).
3. **Short catalog framing.** DSH's catalog message is ~6 lines of framing; Codex's is ~20 plus a roots table.
4. **Typed catalog source for non-model consumers** (`skill-catalog` form) — a durability/inspection win Codex appears to lack.

**Verdict on progressive disclosure:** *Both* are genuinely progressive. DSH is better at **steady-state token cost** (dedup, cap, short framing, visibility-gated). Codex is better at **scaling and addressing** (lexical pre-selection, paginated reads, alias tables, non-filesystem sources, per-agent suppression). For a harness with tens of skills — the realistic case — DSH's economy wins. For hundreds, Codex's selector wins. **INFERRED judgement; the individual mechanisms are VERIFIED.**

**The catalog mechanism, stated precisely for each:**
- **DSH:** `ctx.skills.snapshot({ cwd, signal, scope })` merges provider catalogs through `ScopedLayers`/`NamedEntries` by rank; the result is filtered by `isModelInvocable`, mapped to `{name, description}` entries, digested, and rendered into a per-step `<system-reminder>` carrying a `skill-catalog`-form typed source. Bodies load via the single `skill` tool (`tool-skill/src/index.ts:81-161`), which re-checks `isModelInvocable` at load time (`tool-skill/src/index.ts:145-147`).
- **Codex:** `SkillCatalog` of `SkillCatalogEntry` records assembled from host/executor/orchestrator/custom providers (`ext/skills/src/catalog.rs`), snapshotted per turn (`turn_context.skills_snapshot()`, `core/src/session/turn.rs:745`), optionally narrowed by a `CheapSkillSelector`, and rendered by `catalog_prompt.rs` into `<skills_instructions>`; bodies load via `skills.read` (structured, paginated) or direct file access for host-sourced skills.

---

## 3. Hooks and lifecycle events

### 3.1 Event coverage — Codex has roughly twice the surface

**Codex, 12 events:**
```rust
pub const HOOK_EVENT_NAMES: [&str; 12] = [
    "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
    "SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop",
    "Stop", "Interrupt",
];
```
— `codex-rs/hooks/src/lib.rs:22-36`, with 9 of them matcher-capable (`lib.rs:42-52`: `HOOK_EVENT_NAMES_WITH_MATCHERS`).
Persisted state keys are defined per event at `lib.rs:91-106` (`hook_event_key_label`).

**DSH, 6 then 5** — and the count is dialect-dependent because DSH's hooks are *compatibility bridges*, not a native event bus:
> `export const CLAUDE_CODE_EVENTS = ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SubagentStop']` — `packages/hooks/hooks-claude-code/src/config.ts:12-18`
> `/** The five Codex hook points this bridge supports. */` `export const CODEX_EVENTS = ['PreToolUse','PostToolUse','SessionStart','UserPromptSubmit','Stop']` — `packages/hooks/hooks-codex/src/config.ts:11`

DSH is **missing**: `PermissionRequest`, `PreCompact`, `PostCompact`, `SessionEnd`, `SubagentStart`, `Interrupt`. The compaction pair is notable — DSH has a `packages/compaction` subsystem but no hook fires around it. The `PermissionRequest` gap means a DSH hook cannot participate in the approval decision as its own event; it can only block at `PreToolUse`. **VERIFIED.**

**UNEXPECTED FINDING — the two systems converged on the same format.** Codex's hook engine is literally named `ClaudeHooksEngine` (`codex-rs/hooks/src/events/pre_tool_use.rs:16`), and both products read the **same** `hooks.json` matcher-group shape that Claude Code established:
```ts
interface MatcherGroup { matcher?: string; hooks: CommandHook[] }  // "Both dialects share this shape (CC's hooks.json and Codex's hooks.json)"
```
— `packages/hooks/hook-protocol/src/types.ts`
DSH even models the matcher-mode difference explicitly, choosing literal-vs-regex by dialect (`MatcherMode = 'claude-code' | 'codex'`, `types.ts`). So DSH's hook surface is *defined by what Claude Code and Codex support*, deliberately. That is a coherent interop strategy — but it caps DSH's ceiling at its competitors' feature set, and today that cap sits below Codex's. **VERIFIED.**

### 3.2 What a hook can do

**Codex — two handler kinds, including MCP-backed hooks:**
```rust
ConfiguredHandlerKind::Command { command, env, .. } => run_command(…),
ConfiguredHandlerKind::McpTool { server, tool, input } => run_mcp_tool(engine.mcp_executor.as_ref(), …),
```
— `codex-rs/hooks/src/engine/dispatcher.rs:197-217`

That second arm is a genuine capability DSH has no analogue for: a hook can be **an MCP tool call**, so hook logic can live behind a server. DSH's protocol explicitly narrows to commands only:
> *"Non-command hook types (CC's `prompt`/`agent`/`http`) are parsed-and-skipped by a bridge, so only this shape reaches the runner."* — `packages/hooks/hook-protocol/src/types.ts`

**Codex — decisions are typed and include input rewrite:**
```rust
pub struct PreToolUseOutcome {
    pub hook_events: Vec<HookCompletedEvent>,
    pub should_block: bool,
    pub block_reason: Option<String>,
    pub additional_contexts: Vec<String>,
    pub updated_input: Option<Value>,     // ← rewrites the tool call
}
```
— `codex-rs/hooks/src/events/pre_tool_use.rs:39-46`
and `PermissionRequestDecision::Allow` / `Deny { message }` (`hooks/src/events/permission_request.rs:48-53`), folded *"any deny wins, otherwise the last allow wins"* (`permission_request.rs:10-13`).

**DSH — rich neutral parse, but two capabilities dropped.** DSH's `HookOutput` is actually a *better-normalised* model than Codex's, folding CC's two distinct decision channels into one enum:
> *"the legacy top-level `decision` (`approve`/`block` only) and `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`)… We normalize them to one enum"* — `packages/hooks/hook-protocol/src/types.ts`
carrying `continue`, `stopReason`, `decision`, `reason`, `additionalContext`, `systemMessage`. But:
> *"A tool-input rewrite a hook requested (CC `updatedInput`). PARSED but NOT honored — input rewrite is deferred…; a bridge logs + warns when this is present."* — `packages/hooks/hook-protocol/src/types.ts:132-136`

**This is the sharpest hook-level capability gap: Codex hooks can rewrite tool arguments; DSH hooks cannot.** A DSH hook can block, allow, ask, inject context, and warn — but not redirect `rm -rf /` into `rm -rf ./build`. See Recommendation R3.

### 3.3 Security — Codex gates hooks on a trust hash; DSH does not

Codex computes a hash of each hook definition and compares it against a stored `trusted_hash`, exempting managed sources:
```rust
let current_hash = hook_hash(event_name, matcher, &group, config);
let state = source.hook_states.get(&key);
let enabled = hook_enabled(source.is_managed, state);
let trusted_hash = hook_trusted_hash(source.is_managed, state);
let trust_status = hook_trust_status(source.is_managed, &current_hash, trusted_hash);
```
— `codex-rs/hooks/src/engine/discovery.rs:661-667`

with per-hook persisted state:
```rust
pub struct HookStateToml { pub enabled: Option<bool>, pub trusted_hash: Option<String> }
```
— `codex-rs/config/src/hook_config.rs:34-38`

The effect: **editing a hook invalidates its trust**, so a repository that ships a hooks file cannot silently gain execution. This matters because a hook is arbitrary code execution triggered by agent activity — the same threat model `dsh-workspace-mcp`'s README calls out for `.mcp.json` (*"A `.mcp.json` declares commands, and this plugin runs them… Nothing here sandboxes it"*, `README.md:127-133`).

DSH's hook package has no trust gate found. It has a **different** strength: durable paired audit events with bounded output:
> `'hook/invoked'` / `'hook/result'` session events, `DEFAULT_STDERR_SUMMARY_MAX_CHARS = 500`, `durationMs` — `packages/hooks/hook-protocol/src/events.ts`
> *"`turn` is the open turn the invocation lives inside"*, *"a stable id correlating the invoked event with its result"* — `events.ts:13-25`

and a deliberate rule that a *native* interception plugin writes no such records: *"A native plugin at the interception points is not a bridge and writes no `hook/*` invocation/result records"* (`types.ts`). **Codex wins security; DSH wins auditability.** Both are real and neither substitutes for the other. See Recommendation R4.

### 3.4 Configuration and placement

| | DSH | Codex |
|---|---|---|
| Claude-Code-style `hooks.json` | yes (both bridges) | yes (`ClaudeHooksEngine`) |
| `config.toml` hooks | n/a | yes — `HooksToml` flattening `HookEventsToml`, `config/src/hook_config.rs:25-46` |
| hooks shipped by plugins | no | **yes** — `PluginManifestHooks::Paths(Vec<Resource>) \| Inline(Vec<HooksFile>)`, `plugin/src/manifest.rs:35-38`; `plugin_hook_declarations()`, `hooks/src/declarations.rs` |
| runtime | subprocess command (runner at `hook-protocol/src/runner.ts`) | subprocess command **or** MCP tool |
| durable audit records | yes (`hook/invoked` + `hook/result`) | `HookCompletedEvent` + `HookRunSummary` (`events/*.rs`) |
| interception points beyond hooks | yes — native plugins can register interception extension points that bypass the hook protocol | `core/src/hook_runtime.rs` (1 191 lines) |

**Verdict:** Codex's hook system is materially more capable — 12 events vs 5–6, MCP-backed handlers, typed decisions with input rewrite, plugin-shipped hooks, and a trust gate. DSH's is a well-engineered *interop shim* whose value is that it runs existing Claude Code and Codex hook files verbatim, with better audit trails and a documented escape hatch (write a native DSH plugin instead of a hook).

---

## 4. Subagents

### 4.1 Tool surface — near-identical, independently arrived at

| Operation | DSH | Codex |
|---|---|---|
| spawn | `subagent` (name configurable) — `packages/subagent/tool-subagent/src/index.ts:323` (`config.toolName ?? 'subagent'`) | `spawn_agent` — `core/src/tools/handlers/multi_agents_spec.rs:85,124` |
| message a child | `send_message` — `tool-subagent-control/src/index.ts:29` | `send_input` — `multi_agents_spec.rs:170` |
| interrupt | `interrupt_agent` — `tool-subagent-control/src/index.ts:75` | `close_agent` — `multi_agents_spec.rs:323` |
| resume | (continuable children via `send_message`) | `resume_agent` — `multi_agents_spec.rs:252` |
| list children | `list_agents` — `tool-subagent-control/src/list-agents.ts:87` | (`wait` in `multi_agents/wait.rs`, 327 lines) |
| model selection | `list_subagent_models` — `tool-subagent/src/list-models.ts:88` | per-role config |

Both also expose a wait/notify path. **The convergence is striking and suggests the tool vocabulary for delegation is now settled.** **VERIFIED.**

### 4.2 Spawning, isolation, and the driver question

**DSH — one seam, six providers, honest capability negotiation.**

The service (`packages/subagent/subagent`, `ctx.subagents`) is a *Service Definition* with a named-provider registry:
> *"Multiple providers coexist: each registers under a unique name and callers select one by name."* — `packages/subagent/subagent/src/index.ts:10-11`

Providers, from `packages/subagent/README.md`:

| Provider | Isolation | Mechanism |
|---|---|---|
| `subagent-spawn-in-process` | none (same process) | fresh child |
| `subagent-fork-in-process` | none | child seeded from parent's completed history |
| `subagent-acp` | **process** | Agent Client Protocol |
| `subagent-codex` | **process** | official Codex app-server protocol |
| `subagent-claude-code` | **process** | official Claude Code Agent SDK |
| `subagent-dsh-sdk` | **process** | DSH TypeScript SDK |

The architecturally interesting part is that **providers advertise capabilities and the service refuses requests they cannot honour, rather than accepting and silently degrading**:
> *"The capability advertisement of an out-of-process backend: NONE. A child in another process cannot honor parent-enforced start features (`agentOptions`/`outputSchema`/`maxDepth`/`toolFilter`/`persona`), so the service rejects a request needing any of them before `start` runs — never accepted-then-ignored."*
> — `packages/subagent/subagent/src/out-of-process.ts:53-60`, constant `NO_START_CAPABILITIES` at `out-of-process.ts:57`

That is a real design virtue: a caller that asks for an output schema on an out-of-process child gets a clear error, not a plausible-looking unvalidated result. **VERIFIED.**

**Codex — one runtime, deeper per-child configuration.**

`codex-rs/core/src/agent/` (registry, roles, control with `spawn.rs`/`residency.rs`/`service_tier.rs`/`user_authorization.rs`). Isolation is by *thread* within one runtime, not by process. What it buys instead is **typed per-role configuration override**:
```rust
struct AgentRoleOverrides {
    developer_instructions, model, model_reasoning_effort, model_reasoning_summary,
    model_verbosity, personality, service_tier,
    features: BTreeMap<String, bool>,
    skills: Option<SkillsConfig>,
}
```
— `core/src/agent/role.rs:34-52`, applied by `apply_role_to_config` (`role.rs:57-`), with the governing principle stated at the top of the file:
> *"Applies bounded agent-role overrides to an existing session config. Roles may customize the child or reduce its capabilities, but never replace the parent session's authority."* — `core/src/agent/role.rs:1-4`

Roles are **declared in TOML files** parsed by `parse_agent_role_file_contents` (`role.rs:8`), with two builtins: `core/src/agent/builtins/awaiter.toml` (1 213 bytes — a full worked role with a `developer_instructions` prompt, `model_reasoning_effort = "low"`, `background_terminal_max_timeout = 3600000`) and `core/src/agent/builtins/explorer.toml`, which is **0 bytes** — an empty placeholder. **VERIFIED** (`wc -c` = 0). Worth flagging: a shipped filename with no content is either dead weight or an unfinished feature.

DSH's `tool-subagent` reaches comparable terrain through parameters rather than role files — it accepts `provider`, `model`, and `reasoning_effort` per call with provider-supplied `agentRouteDefaults`, and tells the model so:
> *"Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and this provider's route defaults."* — `packages/subagent/tool-subagent/src/index.ts:376-378`

**Trade-off: Codex's roles are operator-declared and reusable; DSH's selection is model-declared per call.** Codex is safer (an operator pre-approves which models children may use; `AGENT_TYPE_UNAVAILABLE_ERROR` at `role.rs:36` rejects unknown roles). DSH is more flexible. **INFERRED.**

### 4.3 Cost controls

| Control | DSH | Codex |
|---|---|---|
| recursion depth cap | yes — `delegationDepthOf`, `assertSubagentMaxDepth` (`subagent/src/depth.ts`), with header-authoritative monotone depth: *"runtime `AgentOptions.subagentDepth` may DEEPEN the count but can never lower it — a resumed child arrives with fresh options, and counting it from zero would let it delegate as if it were top-level"* (`depth.ts:24-27`) | yes — `exceeds_thread_spawn_depth_limit(depth, max_depth)` (`agent/registry.rs:87-93`) |
| **global concurrency budget** | **not found** | **yes** — `reserve_spawn_slot(max_threads)` → `SpawnReservation` (`agent/registry.rs:95-99`) |
| model / effort per child | yes, per call | yes, per role |
| capability reduction | `toolFilter`, `persona`, `outputSchema` on in-process providers | `features: BTreeMap<String,bool>`, `skills: Option<SkillsConfig>` |
| context-suppression for children | provider scoping + `modelInvocable` | `include_skill_instructions = false` (`agent/role.rs:223`) |
| recursion guard for internal agents | n/a | explicit — the memory consolidation agent runs with *"collab disabled (to prevent recursive delegation)"* (`memories/README.md`) |

**Codex's `reserve_spawn_slot` is the notable unique control: a global thread budget.** DSH bounds *depth* but not *breadth* — nothing in the read surface stops a fan-out from spawning many siblings at once (the `workflow` engine's own child lifecycle is the practical limiter — `packages/workflow/README.md`: *"Workflow hooks and child lifecycle remain owned by the workflow engine"*). **VERIFIED for both; the gap framing is INFERRED.**

DSH's monotone depth rule (`depth.ts:24-27`) is a subtle correctness win Codex's simpler counter does not visibly have — a resumed child in DSH cannot launder its depth back to zero. **DSH advantage, minor.**

### 4.4 Result return

- DSH: `SubagentResult` with a hard diagnostic cap and a truncation suffix that avoids splitting UTF-8:
  > `MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096`, `DIAGNOSTIC_TRUNCATION_SUFFIX = '\n[diagnostic truncated]'` — `subagent/src/out-of-process.ts:20-23`
  and a *"never-reject result settlement"* discipline (`out-of-process.ts:3-8`). Continuable children never become a `SubagentRun`; the continuation manager owns their handle directly and orders turns through the child's inbox (`subagent/src/index.ts:20-27`).
- Codex: `AgentStatus` + `agent_status_from_event` (`agent/status.rs`), polled/awaited by `wait.rs`, surfaced as subagent notifications (`core/tests/suite/subagent_notifications.rs`).

**DSH's result contract is better specified** (byte cap, truncation semantics, never-reject, durable continuation ordering). **Codex's status model is more uniform** across in-process and cross-process children because there is only one kind. **INFERRED.**

### 4.5 Is DSH's many-driver design a real advantage?

**Yes — as breadth and interop, not as delegation quality.** *[INFERRED judgement; the mechanisms are VERIFIED.]*

**For it:**
1. **Capability negotiation is honest.** `NO_START_CAPABILITIES` + rejection-at-request (`out-of-process.ts:53-60`) means one seam serves both zero-isolation and full-process children without lying to callers. Codex has one isolation model, so the question never arises.
2. **The drivers interoperate with the competition.** `subagent-codex` speaks Codex's *official app-server protocol*; `subagent-claude-code` uses Claude Code's *official Agent SDK*. A DSH parent can delegate to a real Codex or Claude Code child that uses its own authentication, model entitlement, and tool set. That is not reproducible in Codex, which has no mechanism to delegate to a rival harness at all.
3. **It turns a comparison axis into a product feature.** Users with an existing Claude Code subscription can route a child to it. Codex has no answer to "use my other subscription."
4. **The provider seam is genuinely pluggable** — four of six providers are out-of-process and every one registers against the same `SubagentProvider` interface (`subagent/src/types.ts:344-348`).

**Against it:**
1. **No per-driver depth.** Each driver is its own integration with its own failure modes; `subagent-*` totals 34 747 lines, more than DSH's entire MCP + skills + hooks surface combined. Codex gets delegation in ~7 600 lines of `multi_agents*` plus the agent module.
2. **Breadth is not the bottleneck.** Neither harness verifies a child's output; both rely on the parent to judge the returned report. Six drivers do not make a delegated task more likely to succeed.
3. **Cross-harness children are capability-poor by construction** — no `maxDepth`, no `outputSchema`, no `toolFilter`, no `persona`. The richest DSH features are unavailable precisely on the drivers that are most distinctive.
4. **No global child budget** (see §4.3), so six ways to spawn with no breadth cap is a cost-control gap, not a cost-control feature.

**Bottom line:** a real advantage in *interoperability surface*, roughly neutral in *delegation quality*, and it carries a *cost-control* debt that Codex has already paid.

---

## 5. Memory

### 5.1 What Codex's memory actually does

Codex has a **real, automatic, two-phase, cross-session memory pipeline**, gated behind a feature flag:
> `FeatureSpec { id: Feature::MemoryTool, key: "memories", stage: Stage::Stable, default_enabled: false }` — `codex-rs/features/src/lib.rs:1063-1068`

**It is off by default.** That is important to the comparison and easy to miss.

The pipeline is documented in `codex-rs/memories/README.md` (157 lines) and split into crates:
> *"`codex-rs/memories/read` (`codex-memories-read`) owns the read path: memory developer-instruction injection, memory citation parsing, and read-usage telemetry classification."*
> *"`codex-rs/memories/write` (`codex-memories-write`) owns the write path: Phase 1 and Phase 2 prompt rendering, filesystem artifact helpers, workspace diff helpers, and extension resource pruning."*
> — `memories/README.md:7-15`

Trigger conditions (`memories/README.md:30-38`): *"the session is not ephemeral, the memory feature is enabled, the session is not a sub-agent session, the state DB is available"* — and it *"runs asynchronously in the background"*.

**Phase 1 — rollout extraction (per thread).** Claims a bounded set of rollout jobs from the **state DB**; filters to memory-relevant response items; sends each rollout to a model *"in parallel, with a concurrency cap"*; expects structured output — *"a detailed `raw_memory`, a compact `rollout_summary`, and an optional `rollout_slug`"*; **redacts secrets**; stores results as stage-1 outputs. Jobs are *"leased/claimed in the state DB before processing, which prevents duplicate work"* and failures get *"retry backoff, so they are retried later instead of hot-looping."* (`memories/README.md:40-80`)

**Phase 2 — global consolidation.** Takes a single global lock, selects a bounded top-N of stage-1 outputs ranking *"by `usage_count` first, then by the most recent `last_usage` / `generated_at`"*, honours a `max_unused_days` window, then syncs a filesystem workspace:
> `raw_memories.md` (merged raw memories, stable ascending thread-id order) / `rollout_summaries/` (one summary file per selected rollout) — `memories/README.md:105-108`

and the memories root is **itself a git repository used as a diff baseline**:
> *"keeps the memories root itself as a git-baseline directory, initialized under `~/.codex/memories/.git` by `codex-git-utils`"* — `memories/README.md:110-111`

If that workspace is dirty, it spawns an internal consolidation sub-agent with a hard safety envelope:
> *"runs it with no approvals, no network, and local write access only"* … *"disables collab for that agent (to prevent recursive delegation)"* — `memories/README.md:127-131`

then *"resets the memory git baseline after the agent completes successfully; the generated diff file is removed before this reset so deleted content is not kept in the prompt artifact or unreachable git objects"* (`memories/README.md:132-134`). Cleanup is observable through the diff: stale `rollout_summaries/` are pruned and *"prunes memory extension resource files older than the extension retention window, so cleanup appears in the workspace diff"* (`memories/README.md:112-115`).

**Why two phases** (`memories/README.md:152-157`): Phase 1 scales across rollouts; Phase 2 serializes global consolidation *"so the shared memory artifacts are updated safely and consistently."*

**Read path.** `codex-memories-read` (`memories/read/src/`: `citations.rs`, `usage.rs`, `metrics.rs`) does developer-instruction injection, **memory citation parsing**, and read-usage telemetry. Templates live beside the crates: `read_path.md`, `stage_one_system.md`, `stage_one_input.md`, `consolidation.md` (`memories/README.md:19-27`).

**Tool surface** — namespace `memories` (`ext/memories/src/lib.rs:18-27`):
```rust
pub(crate) const MEMORY_TOOLS_NAMESPACE: &str = "memories";
pub(crate) const ADD_AD_HOC_NOTE_TOOL_NAME: &str = "add_ad_hoc_note";
pub(crate) const LIST_TOOL_NAME: &str  = "list";
pub(crate) const READ_TOOL_NAME: &str  = "read";
pub(crate) const SEARCH_TOOL_NAME: &str = "search";
```
with explicit caps: `DEFAULT_LIST_MAX_RESULTS = 2_000`, `DEFAULT_SEARCH_MAX_RESULTS = 200`, `DEFAULT_READ_MAX_TOKENS = 20_000`, and a developer-instruction budget of `MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT = 2_500` (`ext/memories/src/lib.rs:10-16`). Backends are pluggable (`backend.rs`) with a local implementation (`local/ad_hoc_note.rs`, `list.rs`, `path.rs`, `read.rs`, `search.rs`) that is security-conscious — it rejects symlinks, hides dotfiles, and sorts deterministically (`ext/memories/src/local/path.rs:26-58`).

**So: Codex memory is automatic (no model initiative), cross-session, model-summarised, deduplicated and pruned by an agent against a git diff, usage-ranked, citation-tracked, token-budgeted, secret-redacted, and off by default.**

### 5.2 Does DSH have an equivalent? No.

**DSH has no persistent-memory package.** Evidence:

1. **No memory crate.** The `packages/` listing contains `compaction`, `context`, `session`, `session-query`, `schedule`, `settings`, `storage` — and no `memory`/`memories` package. **VERIFIED.**
2. **Memory is delegated to third-party MCP servers, explicitly.** `docs/user/guide/mcp-memory.md`:
   > *"These three **default-off reference configurations** connect one memory system to DSH through `@deepseek-ai/dsh-mcp-client`."*
   > *"These third-party configurations are provided as interoperability examples only. Their inclusion does not imply endorsement, recommendation, partnership, or ongoing support by DeepSeek."*
   The three: Memorix, `@modelcontextprotocol/server-memory`, and Engram.
3. **DSH disclaims the whole pipeline.** Same doc:
   > *"DSH does **not** download the server, initialize its database, choose its model or embedding provider, create a cloud account, migrate vendor data, or supervise a separate HTTP service."*
4. **Nothing is automatic.** Enabling memory requires a CLI flag or a hand-merged patch:
   > `dsh web --patch "$PWD/apps/cli/config/examples/mcp-memory/memorix.cordis.yml"` … *"No memory server is present in the shipped composition, so omitting `--patch` keeps all three disabled."*
5. **The glue is a prompt suggestion, not a mechanism.** The guide recommends adding to model instructions:
   > *"When the user asks you to remember something, call a memory write tool. When historical information may be relevant, search memory and use relevant results."* — described as *"additive guidance only."*
6. **Even DSH's own acceptance test is user-driven.** The recall check requires the operator to prompt *"What is my validation drink? **Check memory.**"*
7. **The providers are honest about their own limits.** The reference server's *"Search is case-insensitive substring matching… not semantic retrieval"* and *"does not add embeddings, automatic summarization, conflict resolution, or a forgetting policy"* — i.e. none of the properties Codex's Phase 2 provides.

**Nearest DSH facilities, none of which is memory:**
- `packages/compaction` — intra-session context shrinking.
- `packages/session` + `packages/session-query` — durable session history and search *within* stored sessions.
- `packages/schedule` — *"Host-owned reminders"*, *"one-shot, fixed-rate, daily, weekly, or cron reminders… Due reminders arrive as ordinary follow-up messages"* (`packages/schedule/README.md`). Time-based recall, not learned recall.
- `packages/context` — context assembly, not persistence.
- `packages/goal` — within-session objective tracking.

### 5.3 Is the gap material?

**Yes — for a coding agent, this is a top-three extensibility gap.** *[INFERRED judgement; the underlying facts are VERIFIED.]*

1. **Automatic vs manual.** Codex's memory accrues without the model deciding to write it, so recall does not depend on the model having been told to look. DSH's depends on the model choosing to call a write tool *and* the operator having added a prompt nudge. Every failure mode of an opt-in convention — model forgets, guidance isn't installed, user didn't say "check memory" — is live in DSH.
2. **Consolidated vs append-only.** Codex deduplicates, ranks by usage, expires by `max_unused_days`, and prunes — the hard parts. DSH's documented providers explicitly *"do not add … conflict resolution, or a forgetting policy."* A memory store that only grows degrades: stale preferences win over current ones.
3. **Cross-session by construction vs per-server.** Codex's memories root is one filesystem location with a git baseline. DSH's memory is however many MCP servers the user mounted, each with its own storage scope and its own idea of project identity — the guide itself warns *"keep the provider's storage scope unchanged throughout"* to make the test pass.
4. **Cited vs opaque.** Codex's read path parses memory citations, so recalled content is attributable. No DSH equivalent.
5. **Cost controls.** Codex budgets 2 500 tokens for memory developer instructions and 20 000 for a read, and caps search at 200 results. DSH has no memory-level budget because it has no memory layer.

**Fair mitigations, in DSH's favour:**
- **No vendor lock-in.** Memory is a swappable MCP server; a user who dislikes Codex's consolidation can point DSH at anything. Codex's pipeline is opinionated and entangled with its state DB and git-baseline tooling.
- **Codex's is off by default anyway** (`features/src/lib.rs:1067`), so out-of-the-box the two are closer than the code volume suggests — but Codex's is *one flag* away, with an implemented pipeline behind it; DSH's requires assembling a third-party service.
- **DSH's route is honest.** The guide scopes what it guarantees. A first-party DSH memory could reuse `packages/session-query` and the existing subagent seam rather than inventing a store.

**Recommendation R6 offers a staged path.**

---

## 6. Configuration and plugin composition

### 6.1 DSH — one ordered patch pipeline over an entry tree

DSH composes a profile as an **ordered list of patch documents applied to a YAML entry tree.** Layers, lowest to highest:
1. shipped bundle patches — each bundle declares `dsh.bundle.patch`:
   > `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — `packages/bundle/base/package.json`
   > *"Each package declares `dsh.bundle.patch`; the launcher stacks those patch documents to assemble a named profile."* — `packages/bundle/README.md`
2. user patch layers under the harness home — `$DSH_HOME/cordis.patch.yml` (all profiles) and `$DSH_HOME/profiles/<name>/cordis.patch.yml` (one profile) (`docs/user/guide/mcp-memory.md`);
3. CLI `--patch` overlays (same doc);
4. and the workspace plugin's own layer, per `cordis.patch.yml:7-27` in this workspace.

Patch semantics are small and sharp (`vendor/include/src/index.ts:54-140`):
```ts
export interface PatchOptions {
  id?: string; insert?: EntryOptions[]; name?: string; config?: any
  group?: boolean | null; disabled?: boolean | null; inject?: any
  intercept?: any; isolate?: any; [key: string]: any
}
```
- `insert` with no `id` appends at top level; `insert` **with** an `id` appends into that group's children.
- Any other patch must name an `id` and then **overrides arbitrary fields on that entry** — including `disabled`, `config`, `group`, `inject`, `intercept`, `isolate`.
- Patches are applied in order, and **later patches can target rows earlier patches inserted**:
  > *"Index what this patch added so a LATER patch in the same list can target it. Patch lists compose one layer per source (each bundle layer, then the user's, then `--patch` overlays), and a layer must be able to configure or disable a row an earlier layer inserted"* — `vendor/include/src/index.ts:102-108`
- A patch that matches nothing **warns and is skipped**, never throws:
  > *"A patch that matches nothing warns and is skipped."* — `vendor/include/src/index.ts:53`
- The same function serves live mounting and offline `dsh --dump-config`, so a dump cannot drift from a boot (`vendor/include/src/index.ts:45-52`) — a genuinely good property.

**Composition is live.** `reconcileProfilePatches` applies a whole patch generation to the running loader, awaits activation, and throws only if a *new* entry failed:
> *"Diagnostics for unchanged pre-existing inactive entries; new or changed failures reject."* — `packages/boot/app-boot/src/index.ts:266-273`
> and emits `'app-boot/config-reload'()` on success (`index.ts:49-56`).

Supporting pieces: **presets** register `{ id, name, description, order, plugins[] }` into `ctx.agentPresets` (`packages/preset/agent-preset/src/index.ts:18-27`) as *"a declarative preset row in an ordinary Cordis composition"*; **settings** derives editable forms from each plugin's own Config schema and *"The active profile patch stores edits, and Loader applies them"* (`packages/settings/README.md`); **bundles** ship the whole tree (`base`, `web-app`, `headless`, `acp-app`, `sdk-app`, `sdk-minimal`).

**Everything is a plugin.** MCP servers, skills providers, subagent drivers, hooks bridges, and workflow tools are all Cordis entries with `inject`-declared dependencies and `ctx.effect` lifetimes. This workspace's own `cordis.patch.yml:7-27` is a minimal, readable example of the whole model.

### 6.2 Codex — typed config layers + features + profiles + a plugin marketplace

**Nine config layers with explicit numeric precedence** (`codex-rs/config/src/config_layer_source.rs:6-52`):
```rust
PackagedDefaults => -10,  Mdm => 0,  System => 10,  EnterpriseManaged => 15,
User { profile: Some(_) } => 21,  User { profile: None } => 20,
Project => 25,  SessionFlags => 30,
LegacyManagedConfigTomlFromFile => 40,  LegacyManagedConfigTomlFromMdm => 50,
```
with the rule stated plainly: *"A setting from a layer with a higher precedence overrides a setting from a layer with a lower precedence."* (`config_layer_source.rs:31-32`).

The MDM / EnterpriseManaged / requirements layers signal what this system is *for*: centrally governed deployment. `config/src/config_requirements.rs` (643+ lines touching **`profiles`** and `allowed_permission_profiles`) lets an administrator constrain what users may configure at all — a capability with no DSH analogue found.

**Profiles** are typed units of ~60 named settings: `ConfigProfile { model, service_tier, model_provider, approval_policy, sandbox_mode, model_reasoning_effort, personality, model_instructions_file, tools, web_search, … }` (`config/src/profile_toml.rs:20-60`), `#[schemars(deny_unknown_fields)]` so a typo is a load error, and a JSON Schema is generated for editor tooling.

**Features** are a first-class registry with lifecycle:
```rust
pub enum Stage { UnderDevelopment, Experimental { name, menu_description, announcement },
                 Stable, Deprecated, Removed }
```
— `codex-rs/features/src/lib.rs:43-57`
`133` `FeatureSpec`s (`grep -c "id: Feature::"`), each with `id`, `key`, `stage`, `default_enabled` (`features/src/lib.rs:862-866`). The `Stage` taxonomy is the interesting part: `Experimental` carries *user-facing menu strings and an announcement* (`lib.rs:48-52`), and `Removed` exists to *"kept for backward compatibility reason"* — so retired flags still parse. That is unusually disciplined feature-flag hygiene. **VERIFIED.**

**Plugins are a distribution system, not just a config layer.** A manifest declares components:
```rust
pub struct PluginManifest<Resource> {
    pub name: String, pub version: Option<String>, pub description: Option<String>,
    pub keywords: Vec<String>, pub paths: PluginManifestPaths<Resource>,
    pub interface: Option<PluginManifestInterface<Resource>>,
}
pub struct PluginManifestPaths<Resource> {
    pub skills: Vec<Resource>, pub mcp_servers: Option<PluginManifestMcpServers<Resource>>,
    pub apps: Option<Resource>, pub hooks: Option<PluginManifestHooks<Resource>>,
}
```
— `codex-rs/plugin/src/manifest.rs:8-24`, with `PluginManifestInterface` carrying `display_name`, `capabilities`, `logo`, `screenshots`, `brand_color`, `default_prompt` (`manifest.rs:42-58`).

And `core-plugins` (77 files, 43 557 lines) implements the marketplace: `marketplace.rs`, `marketplace_add`, `marketplace_remove`, `marketplace_upgrade`, `installed_marketplaces.rs`, `npm_source.rs`, `remote_bundle.rs`, `plugin_bundle_archive.rs`, `store.rs`, `manager.rs`, `loader.rs`, `discoverable.rs`, `recommended_plugin_install.rs`, plus a model-facing tool `list_available_plugins_to_install_spec.rs`. Hooks can ship from plugins (`hooks/src/declarations.rs` — `PluginHookDeclaration`, `plugin_hook_declarations`).

### 6.3 Which is more approachable, and which is more powerful?

**More approachable: Codex, clearly.** *[INFERRED, well-supported.]*
- A user edits one TOML file with a generated JSON schema, `deny_unknown_fields`, named profiles, and a documented feature-key list.
- DSH requires understanding a Cordis loader *tree*, stable entry `id`s, ordered patch *layers* from four sources, group-targeted `insert`, and `!!js` expressions whose evaluation context differs per row. The failure modes are real and documented — this workspace's own README has to warn:
  > *"Do not copy over an existing file: it may already contain unrelated user patches."* — `docs/user/guide/mcp-memory.md`, echoed at `README.md:93-94`
  and
  > *"If your deployment already has a SAGE server declared in the harness loader configuration, remove it: two servers claiming `serverName: sage` in one scope make `mcp-client` throw and abort the boot."* — `README.md:68-70`
  An abort-on-duplicate-namespace rule is defensible (it is loud and actionable), but it is a sharp edge a typed config with `deny_unknown_fields` avoids by validating earlier.
- Codex's `Stage` taxonomy plus an experimental menu gives users a safe discovery path for new features; DSH's equivalent onboarding is reading a package README.

**More powerful: DSH, on composition.** *[INFERRED, well-supported.]*
- DSH's patch layer can **restructure the boot graph itself** — insert whole subsystems, disable or replace any entry by id, rewrite `config`/`inject`/`intercept`/`isolate`, reorder, and hot-reload the result through `reconcileProfilePatches` (`boot/app-boot/src/index.ts:266-300`). A third party can change how DSH boots without touching DSH.
- Codex's layers merge **values into a fixed schema**. Adding a subsystem means writing Rust and adding a `FeatureSpec`. The marketplace distributes *content* (skills, MCP servers, apps, hooks) with rich presentation metadata — it does not let a plugin alter the config layer stack or entry graph.
- The `dsh-workspace-mcp` workspace is itself the proof: it is a fourth-party plugin that changes MCP-server *discovery* (reading `.mcp.json`, per-agent mounting, environment-substitution policy) purely through the patch model and a config row. There is no equivalent move in Codex without a Rust change.

**Framing.** DSH is a **plugin kernel with a config overlay**; Codex is a **configured application with a plugin marketplace**. DSH optimises hackability and composability; Codex optimises distribution, governance, and safe default-on discovery. Both are coherent; they are answers to different questions.

**Where each is objectively ahead:**
- DSH: composability, live recomposition, `--dump-config` fidelity guaranteed by sharing the apply function, everything-is-a-plugin uniformity, per-agent scoping.
- Codex: approachability, typed validation, precedence that is a single documented number, enterprise/MDM governance and requirements layers, feature lifecycle discipline with 133 registered flags, and an actual plugin *distribution* mechanism with npm/remote/archive sources.

---

## 7. Worktrees and git isolation

### 7.1 What Codex's `worktree` crate does

`codex-rs/worktree` — 6 files, 621 lines (`git.rs`, `lib.rs`, `metadata.rs`, `settings.rs`, tests).

It is a **managed-worktree lifecycle and ownership manager** keyed to the Codex Desktop contract:
> `/// Creates and identifies worktrees using the existing Codex Desktop contract.` — `worktree/src/lib.rs:14-16`
> `pub fn bind_thread(&self, checkout: &Path, thread_id: &str) -> Result<()>` / `pub fn owner(&self, checkout: &Path) -> Result<Option<String>>` — `lib.rs:33-41`

It validates that a checkout really is a *linked* worktree, not merely a repository root:
> `if git_dir == common_dir { bail!("{} is not a linked worktree", checkout.display()); }` — `worktree/src/lib.rs:59-63`
with `has_managed_layout(&managed_root, &checkout)` gating everything (`lib.rs:46-49`).

Settings come from the existing `[desktop]` config namespace rather than a new format (deliberately):
> *"Resolves the existing `[desktop]` values without introducing another config format."* — `worktree/src/settings.rs:30-31`
```rust
const WORKTREE_ROOT: &str  = "git-worktree-root";
const AUTO_CLEANUP: &str   = "worktree-auto-cleanup-enabled";
const KEEP_COUNT: &str     = "worktree-keep-count";
pub const DEFAULT_WORKTREE_KEEP_COUNT: usize = 15;
```
— `settings.rs:17-22`; default root `codex_home.join("worktrees")`, auto-cleanup default `true`, non-absolute roots rejected (`settings.rs:37-48, 60-62`).

### 7.2 Is it agent-facing? No — an important qualification

A grep for `WorktreeManager` across `codex-rs` returns **only `worktree/tests/worktree.rs`**. `core` does not link it. **VERIFIED.**

So `worktree` is a **host-local checkout lifecycle helper for the Desktop application** — create/identify/bind a managed worktree to a thread, keep the newest 15, clean up the rest — and **not** a per-subagent git-isolation primitive. It does not appear in `core/src/agent/` or `multi_agents*`.

### 7.3 Does DSH have an equivalent? No.

A grep for `worktree` across `packages/` returns exactly one unrelated hit (a Windows ACL sandbox token file, `packages/sandbox/sandbox-windows-acl/src/token.ts`). **VERIFIED: DSH has no worktree support of any kind.**

DSH's isolation story is different in kind:
- `packages/sandbox/*` — platform sandboxes (including the Windows ACL package above, and `bwrap`-class equivalents).
- `packages/fs` — filesystem access mediation.
- `packages/workspace` — workspace roots.
- The DSH **file policy** in force for this very session — *"Current DSH file policy: workspace-write"*, confining writes to the session workspace.

That is **path-based confinement**, which is arguably the more fundamental control (it bounds what *any* child can touch, worktree or not). What it is not is **checkout-based isolation**: two DSH subagents working the same repository share one working tree and can overwrite each other's files and index.

### 7.4 Is the gap material?

**Partially — the honest answer is that neither harness gives a subagent its own worktree, so this is not a competitive deficit.**

- **Against calling it a DSH gap:** Codex's `worktree` crate is not wired into its agent runtime, so a Codex subagent does not get an isolated worktree either. On the axis "does delegation get git isolation," the two are **at parity: no**.
- **For calling it a DSH gap:** Codex at least has a managed-worktree concept with ownership metadata, linked-worktree validation, retention and cleanup — the primitives a future per-agent isolation feature would need. DSH has none, so building it means starting from zero.
- **Where it actually bites in DSH:** parallel subagents and the `workflow` fan-out engine (`packages/workflow/README.md` — *"scripted fan-out"*) run multiple children against one checkout. Nothing in the read surface serialises their filesystem writes. DSH's file policy bounds *where* they may write but not *whether they collide*.

**INFERRED conclusion:** low competitive priority, moderate practical value. The cheapest high-value move is not "port `worktree`" — it is a **worktree-per-subagent provider** plugging into DSH's existing `SubagentProvider` seam. See Recommendation R7.

---

## 8. Scorecard

| # | Dimension | Winner | Margin | Decisive evidence |
|---|---|---|---|---|
| 1 | MCP transports | tie | — | 2 each, no SSE |
| 2 | MCP auth | **Codex** | decisive | full OAuth + enterprise identity vs static headers |
| 3 | MCP namespacing | Codex | mild | namespace-level dedup (`tools.rs:153-181`) |
| 4 | MCP lazy surfacing | **Codex** | decisive | `tool_search` (`spec_plan.rs:205-275`) vs none |
| 5 | MCP resources | DSH | mild | 3 scoped shared tools vs client-only |
| 6 | MCP prompts | tie | — | both absent |
| 7 | MCP error handling | **DSH** | strong | atomic swap, rollback, no fake successes |
| 8 | MCP reconnection | **DSH** | strong | bounded outage budget + close barrier |
| 9 | MCP elicitation / server mode | **Codex** | decisive | `elicitation.rs`; `mcp-server/` crate |
| 10 | Skill definition / metadata | Codex | mild | deps, interface, product gating; DSH better name+invocation grammar |
| 11 | Skill discovery / composition | DSH | mild | rank-based registry, scoped layers, 2-axis policy |
| 12 | Skill catalog economy | **DSH** | moderate | digest dedup, 500-char cap, short framing, typed source |
| 13 | Skill scaling / addressing | **Codex** | decisive | selectors, paginated `skills.*`, aliases, non-host sources |
| 14 | Hook events | **Codex** | decisive | 12 vs 5–6 |
| 15 | Hook capabilities | **Codex** | decisive | `updated_input`, MCP-backed handlers |
| 16 | Hook safety | **Codex** | strong | `trusted_hash` gate; DSH none |
| 17 | Hook auditability | DSH | mild | paired bounded `hook/*` events |
| 18 | Subagent tool vocabulary | tie | — | spawn/send/interrupt/resume/list on both |
| 19 | Subagent isolation breadth | **DSH** | decisive | 6 drivers incl. ACP, Codex, Claude Code |
| 20 | Subagent capability honesty | **DSH** | moderate | `NO_START_CAPABILITIES` + reject-early |
| 21 | Subagent cost control | **Codex** | moderate | `reserve_spawn_slot` global budget, role model-gating |
| 22 | Subagent result contract | DSH | mild | byte cap, truncation semantics, never-reject |
| 23 | Memory | **Codex** | decisive | full pipeline vs none |
| 24 | Config approachability | **Codex** | decisive | typed TOML + schema + profiles + feature stages |
| 25 | Config composability | **DSH** | decisive | patch can restructure the boot graph, live |
| 26 | Plugin distribution | **Codex** | decisive | marketplace, npm/remote/archive, manifests |
| 27 | Plugin capability surface | DSH | moderate | plugins alter config/boot; Codex plugins supply content |
| 28 | Worktrees | Codex* | marginal | crate exists but is not agent-wired; DSH has nothing |

\* Row 28 is effectively a tie on the axis that matters (per-agent git isolation): neither provides it.

---

## 9. Prioritized Recommendations

Impact/effort are H/M/L. `[WS]` = actionable in **this** workspace (`/Users/l33tdawg/nodejs-projects/dsh-workspace-mcp`, which can ship plugins and patch layers). `[UP]` = upstream DSH change (`dsh-src`); note `dsh-workspace-mcp/README.md:30-32` records that upstream *"does not accept external pull requests, and directs changes of this kind to the plugin ecosystem"* — so `[UP]` items are for a DSH maintainer, and `[WS]` items are the ones this project can actually execute.

---

### R1 — MCP credential injection and refresh for `.mcp.json` servers `[WS]`
**Impact: H · Effort: M**

DSH has no MCP OAuth (§1.2 — `packages/mcp/mcp-client/src/index.ts:91-92` is the entire auth surface), and `.mcp.json` carries only static `headers`. Any OAuth-protected or token-rotating remote server therefore cannot be used from a workspace file. Codex solves this with `bearer_token_env_var`, `env_http_headers`, and `http_headers_helper` (`codex-rs/config/src/mcp_types.rs:549-563`).

**Files to touch**
- `lib/index.ts` — add an `auth` config block (`{ [serverKey]: { tokenCommand?: string, bearerEnvVar?: string, headerTemplate?: string } }`); resolve a fresh token at mount time and pass it into the `mcp-client` config's `headers`; re-resolve on a timer and remount (or expose the token through `envOverrides` + a resolved header).
- `cordis.patch.yml` — add the `auth: {}` block with inline documentation mirroring the existing `allowEnv` comment style.
- `README.md` — document the security posture: *a token command is a command; it is refused unless the server key is explicitly listed*, matching the existing `allowEnv` reasoning at `README.md:135-141`.
- `tests/` — extend `tests/integration.test.ts` with a fixture server asserting the injected header, plus a test that an unlisted server's auth block is ignored.

**Constraint to respect:** do not weaken the existing rule that `${env:NAME}` is whole-value-only (`README.md:138-141`). A token *command* is a stronger capability than an env read, so it needs the same operator opt-in shape.

---

### R2 — Lazy tool surfacing for large workspace `.mcp.json` sets `[WS]` primary, `[UP]` ideal
**Impact: H · Effort: M (workspace) / H (upstream)**

This workspace's entire premise is "mount everything the project declares." DSH has **no tool-search mechanism** (§1.4), so every declared server's every tool is declared on every request. A workspace declaring three or four MCP servers can add dozens of tools. DSH's `deferLoading` is a prompt-cache flag, not search, and is stripped entirely on routes that don't support mid-conversation tool updates (`packages/llm/llm/src/content.ts:433-435`).

**Files to touch**
- **Workspace path** — `lib/index.ts`: add a `searchTool: true` mode that mounts MCP servers into a scope *without* registering their tools directly, instead registering one `mcp_tool_search` / `mcp_tool_call` pair over the collected definitions. Tools are then discovered through the search tool. Also add `maxToolsPerServer` / `toolAllowlist` to bound the blast radius per server.
- `README.md` — document the mode and its trade-off (an extra hop, and the model must search before calling).
- **Upstream path** — `packages/mcp/mcp-client/src/tools.ts`: build definitions but register them under a deferred exposure; add `tool_search` to `packages/core/tools`; wire `deferLoading` semantics to *actual* deferral rather than only provider-side `defer_loading`. Reference implementation: `codex-rs/core/src/tools/spec_plan.rs:205-275` and `codex-rs/core/src/tools/handlers/tool_search_spec.rs:16`.
- **Cheaper upstream alternative (Impact M · Effort S):** make `mcp-client` honour `disabled_tools`/`enabled_tools` per server, as Codex does at `codex-mcp/src/tools.rs:74-103`. This is a much smaller change that solves the common case of one noisy server.

---

### R3 — Honour `updatedInput`: let hooks rewrite tool arguments `[UP]`
**Impact: M · Effort: M**

DSH parses `updatedInput` and explicitly drops it:
> *"PARSED but NOT honored — input rewrite is deferred…; a bridge logs + warns when this is present."* — `packages/hooks/hook-protocol/src/types.ts:132-136`

Codex implements it (`codex-rs/hooks/src/events/pre_tool_use.rs:44`, `pub updated_input: Option<Value>`). Without it, a DSH hook's only options are allow / deny / ask / inject text — it cannot safely narrow a dangerous argument.

**Files to touch**
- `packages/hooks/hook-protocol/src/types.ts` — promote `updatedInput` from parsed-and-ignored to a supported outcome field; update the doc comment that currently declares it deferred.
- `packages/hooks/hooks-claude-code/src/index.ts:246` — the `PreToolUse` `runPoint` call site must thread a rewritten-argument outcome into the `PreToolDecision` it returns.
- `packages/hooks/hooks-codex/src/index.ts` — same, at its own `PreToolUse` call site.
- `packages/hooks/hook-protocol/src/merge.ts` — decide the fold rule for multiple handlers proposing different rewrites (last-wins matches Codex's `PermissionRequest` fold at `hooks/src/events/permission_request.rs:10-13`; a deny-wins rule is safer for rewrites).
- Tests: `packages/hooks/hooks-claude-code/tests/bridge.spec.ts`, `hooks-codex/tests/bridge.spec.ts`, `hook-protocol/tests/merge.spec.ts`.
- **Before starting:** read the DSH Agent Note *"interception extension-points"* referenced from `types.ts:132-136`. The deferral may be deliberate (native interception plugins may be the intended path), in which case the right change is documentation, not code.

---

### R4 — Trust gate for hook and MCP-server definitions `[WS]`
**Impact: M · Effort: S–M**

Two arbitrary-code-execution surfaces are read from a cloned repository: `.mcp.json` and (via DSH's hook bridges) a workspace `hooks.json`. This workspace already documents the MCP half unflinchingly — *"Cloning a repository and opening it in Harness therefore executes whatever that repository's `.mcp.json` names, as your user… Nothing here sandboxes it."* (`README.md:127-133`).

Codex gates its equivalent with a per-definition trust hash that invalidates on edit (`codex-rs/hooks/src/engine/discovery.rs:661-667`, `config/src/hook_config.rs:34-38`).

**Files to touch**
- `lib/index.ts` — add `trust: { mode: 'off' | 'warn' | 'enforce', store?: string }`; hash the normalised `{command,args,env,cwd}` (or `{url,headers}`) per server key; on change, refuse the mount and log an actionable error naming the file and key. Reuse the existing `verbose` logging channel.
- `cordis.patch.yml` — add the `trust` block; default to `'warn'` so existing users are not broken on upgrade.
- `README.md` — extend the **Security** section with a trust subsection and a one-line migration note.
- `tests/` — a test that an edited `command` for a previously-trusted key is refused under `'enforce'`, and that unchanged definitions mount silently.

**Why this is worth doing:** it is the single smallest change that converts an unqualified warning into an enforced, documented boundary — and `dsh-workspace-mcp` is the plugin that *introduced* workspace-file MCP discovery, so it owns the mitigation.

---

### R5 — Cache MCP tool catalogs across reconnects `[UP]`
**Impact: L–M · Effort: S**

DSH re-lists on every sync, including every reconnect:
> `await client.listTools(undefined, { cacheMode: 'refresh' })` — `packages/mcp/mcp-client/src/tools.ts:123`

Codex keeps a process-scoped LRU of recent tool catalogs (32 entries, 30-minute TTL — `codex-mcp/src/tool_catalog_cache.rs:32-33`), so a flapping or slow server does not force a fresh `tools/list` on each reconnect. DSH's reconnect supervisor will retry up to 10 times per outage (`connection.ts:41-46`), so a server that accepts a connection but is slow to list tools pays that cost repeatedly.

**Files to touch**
- `packages/mcp/mcp-client/src/tools.ts` — use a cached catalog when the transport generation was just re-established and the previous generation's list is still within a TTL; keep `cacheMode: 'refresh'` for the initial connect and for genuine `listChanged` notifications.
- New `packages/mcp/mcp-client/src/catalog-cache.ts` — bounded LRU keyed by `(serverName, transportIdentity)` with TTL, mirroring the existing `DEFAULT_COLLECT_CACHE_ENTRIES = 128` style in `packages/skill/skill/src/index.ts:23`.
- `packages/mcp/mcp-client/src/connection.ts:169-177` — thread the cache through `enqueueSync` so a reconnect can reuse it.
- Tests: `packages/mcp/mcp-client/tests/reconnect.spec.ts` (617 lines already exist) — assert a reconnect reuses the catalog within TTL and refreshes after it.

**Caveat:** `listChanged` correctness must be preserved. The current design deliberately refreshes (`tools.ts:123`); any cache must be invalidated by the `onChanged` path (`index.ts:263-269`) and by `dispose()`.

---

### R6 — Ship a default memory path rather than a reference document `[WS]` then `[UP]`
**Impact: H · Effort: M (MCP-backed) / H (first-party)**

DSH has no memory (§5.2), and the gap is material (§5.3). DSH's own guide concedes the current answer requires the operator to install a third-party server, pass `--patch`, and add a prompt nudge — and its providers *"do not add embeddings, automatic summarization, conflict resolution, or a forgetting policy."*

**Staged plan**
- **Stage 1 `[WS]` (Impact H · Effort M).** Add an opt-in memory row to this workspace's patch: a `memory: {}` config block that mounts a pinned memory MCP server with `serverName: memory` and a documented env override for its data directory. Reuse the existing `sage: {}` row pattern (`cordis.patch.yml:19-25`) and the `${env:}` policy already implemented. Files: `lib/index.ts`, `cordis.patch.yml`, `README.md`, `tests/`.
  **Deliberately do not default it on** — the MCP threat model in `README.md:127-133` applies with full force to memory servers, which read and write a store across every project.
- **Stage 2 `[WS]` (Impact M · Effort S).** Ship the recall guidance the guide currently asks the user to paste (`docs/user/guide/mcp-memory.md`, *"Optional shared model instruction"*) as a plugin-contributed system-prompt section, so the convention is installed by the package rather than by the user. DSH's `systemPrompt.section({...})` API is already used this way by `mcp-resources` (`packages/mcp/mcp-resources/src/index.ts:57-70`).
- **Stage 3 `[UP]` (Impact H · Effort H).** A first-party `packages/memory` with automatic capture, usage-ranked retrieval, and consolidation. The building blocks already exist and should be reused rather than reinvented: `packages/session-query` for history access, `packages/subagent` for a consolidation agent (it already supports out-of-process children and `maxDepth`), `packages/storage` for persistence, and `packages/compaction` for budget discipline. Reference model: `codex-rs/memories/README.md` — in particular the two-phase split (*"Phase 1 scales across many rollouts… Phase 2 serializes global consolidation"*), the git-baseline diff that decides whether consolidation has work, and the consolidation agent's safety envelope (*"no approvals, no network, local write access only"*, *"collab disabled (to prevent recursive delegation)"*).

**Do not copy Codex's default-off posture without also copying its discovery path.** Codex's memory is off by default (`features/src/lib.rs:1067`) but one flag plus a feature registry entry away. A DSH equivalent should be discoverable through the settings form mechanism (`packages/settings/README.md`) rather than requiring a hand-edited patch layer.

---

### R7 — Worktree-per-subagent subagent provider `[UP]`
**Impact: M · Effort: M**

Neither harness isolates a subagent's checkout (§7.4), but DSH's fan-out engines (`packages/workflow`'s *"scripted fan-out"*; parallel `subagent` calls) run multiple children against **one** working tree with nothing serialising their writes. DSH's file policy bounds *where* they write, not *whether* they collide.

DSH already has the right seam: a `SubagentProvider` registering against `ctx.subagents` (`packages/subagent/subagent/src/index.ts:10-11`), with `packages/subagent/subagent-spawn-in-process` as the closest template.

**Files to touch**
- New package `packages/subagent/subagent-worktree/` — a provider that, per child: runs `git worktree add` into a managed root, sets the child's `cwd` to the new checkout, and on completion either merges, leaves the branch, or removes the worktree per policy. Note DSH's existing child-cwd resolution already has the right hook point (`packages/subagent/subagent/src/out-of-process.ts:3-8` documents *"child working-directory resolution (config override, else the delegating parent session's workspace)"*).
- `packages/subagent/README.md` — add the row to the provider table.
- `packages/workflow/` — let the workflow engine select the worktree provider so fan-out children are isolated by default.
- **Reuse rather than re-derive:** `codex-rs/worktree/src/lib.rs:33-63` is a compact reference for the correctness details that matter — validating `--git-dir != --git-common-dir` to prove a path is a *linked* worktree, keeping ownership metadata, and having an explicit retention count (`DEFAULT_WORKTREE_KEEP_COUNT = 15`, `worktree/src/settings.rs:20`). Do not port the crate; port the three checks.

**Alternative (Impact M · Effort S):** if a provider is too much, at minimum make the workflow engine serialise children that share a checkout, or warn when more than one concurrent child targets the same workspace.

---

### R8 — Close the DSH hook event gap, or document it as permanent `[UP]`
**Impact: M · Effort: M (code) / S (docs)**

DSH fires 5–6 hook events; Codex fires 12 (§3.1). The missing ones that matter most for a coding agent are **`PreCompact`/`PostCompact`** (DSH has a `packages/compaction` subsystem but no hook around it, so an operator cannot react to or veto context loss) and **`PermissionRequest`** (a DSH hook can only block at `PreToolUse`, never participate in the approval decision as its own event).

**Files to touch**
- `packages/hooks/hook-protocol/src/types.ts` — extend the dialect-neutral vocabulary with the new points.
- `packages/hooks/hooks-claude-code/src/config.ts:12-18` and `packages/hooks/hooks-codex/src/config.ts:11` — extend both event lists *only* for points the dialect actually defines; do not invent points a dialect's own `hooks.json` cannot express, since the bridges' contract is fidelity.
- `packages/hooks/hook-protocol/src/events.ts` — the new points must satisfy the existing invariant that `hook/*` records are *"turn-enclosed and invoked/result paired"*; `SessionEnd` in particular sits outside a turn and the file already notes `SessionStart` *"records injected context instead and does not append `hook/*` outside a turn."* Resolve this deliberately for each new point.
- **If the answer is "no":** `packages/hooks/README.md` should state plainly that the event set is bounded by the Claude Code and Codex dialects and is therefore a deliberate ceiling, with a pointer to native interception plugins as the path for other lifecycle points. Right now a reader cannot tell deferral from omission.

---

### R9 — Fix or remove the empty `explorer.toml` role `[UP]`
**Impact: L · Effort: S**

`codex-rs/core/src/agent/builtins/explorer.toml` is **0 bytes** while its sibling `awaiter.toml` is a complete 1 213-byte worked role (§4.2). This is a Codex-side finding, included because it is a concrete, verified defect surfaced by this comparison.

**Files to touch**
- `codex-rs/core/src/agent/builtins/explorer.toml` — either implement the role (an explorer child typically wants read-only tools, a low reasoning effort, and a bounded report format) or delete the file.
- Verify against `codex-rs/core/src/agent/role.rs:57` (`apply_role_to_config`) and the role-file parser (`parse_agent_role_file_contents`, `role.rs:8`) whether an empty role file registers a usable role or fails. If it registers, it is a live footgun: a caller naming `explorer` gets an unconstrained child.

---

### R10 — Adopt Codex's feature-stage discipline for DSH plugin rows `[UP]`
**Impact: M · Effort: M**

Codex registers 133 feature flags with an explicit lifecycle:
```rust
pub enum Stage { UnderDevelopment, Experimental { name, menu_description, announcement },
                 Stable, Deprecated, Removed }
```
— `codex-rs/features/src/lib.rs:43-57`
with `Removed` retained *"for backward compatibility reason"* so retired keys still parse (`lib.rs:54-55`), and `Experimental` carrying user-facing menu text and an announcement (`lib.rs:47-52`).

DSH has no equivalent concept. New capability arrives as a plugin row whose readiness is conveyed only in prose — this workspace's own `sage: {}` row, for instance, mounts a per-workspace agent that *"an operator must approve"* (`README.md:65-67`), which is exactly the kind of consequence a `Stage::Experimental { announcement }` exists to surface.

**Files to touch**
- `packages/boot/app-boot/src/config-schema/` — carry an optional `stage` and `announcement` through the generated config schema, alongside the existing plugin-compatibility machinery (`plugin-compatibility.ts`).
- `packages/settings/settings/src/` — render experimental rows distinctly in the derived forms, and surface the announcement once per activation.
- `packages/boot/plugin-manager/` — gate row enablement on stage, so an `UnderDevelopment` row cannot be enabled from the GUI without an explicit override.
- Follow-up: `docs/config-catalog.md` (referenced from `packages/mcp/mcp-client/README.md`) should render the stage per row.

---

## 10. Overall assessment

**Codex is the more mature extensibility platform; DSH is the more composable one.**

Codex's advantages cluster in *surface and governance*: full MCP OAuth with enterprise identity, MCP elicitation and server mode, real deferred tool search, twice the hook events with input rewriting and a trust gate, a two-phase memory pipeline, a 133-flag feature registry with lifecycle stages, a typed nine-layer config system with MDM and requirements, and an actual plugin marketplace with npm/remote/archive distribution. Across the 28 dimensions scored, Codex takes 16.

DSH's advantages cluster in *engineering discipline and composability*: the atomic MCP tool-set swap with rollback and typed refusals, the bounded reconnection supervisor with a close barrier, digest-deduplicated skill catalogs with visibility-gated injection and a typed non-model source, honest subagent capability negotiation across six genuinely different drivers, paired bounded hook audit events, and — most of all — a patch model that can restructure the boot graph itself and hot-reload the result. DSH takes 8 dimensions, several by a wide margin.

**Three findings should shape what happens next.**

1. **DSH's largest extensibility gap is memory, and it is unmitigated.** Codex has a full pipeline with `Stage::Stable`; DSH has a document recommending three third-party MCP servers and a prompt nudge. This is the one axis where the gap is not an engineering-taste difference but a missing capability, and it is the one most likely to be felt by users who work across sessions. (R6)

2. **DSH's MCP client is better than Codex's at the things that break, and worse at the things that scale.** Atomic swaps, rollback, bounded reconnect budgets, and typed refusals (`tools.ts:96-161`, `connection.ts:41-54`) are the parts a user notices when a server misbehaves — and DSH wins there. OAuth and lazy surfacing are the parts a user notices when a deployment grows — and DSH loses there, decisively. The reconnect design should be preserved and cited when the other two are addressed. (R1, R2, R5)

3. **The workspace plugin is where DSH's architecture pays off, and where its gaps are most visible.** `dsh-workspace-mcp` exists because DSH reads MCP configuration only from its own loader config (`README.md:19-32`) — a real gap that a fourth-party plugin closed through the patch model alone, without a Rust or TypeScript change upstream. That is DSH's composability advantage made concrete. But every server that plugin mounts inherits DSH's missing OAuth, missing tool search, and missing trust gate — so the plugin also inherits the obligation to mitigate them. (R1, R2, R4)

---

### Verification notes and limitations

- **Read directly:** all `packages/mcp/*`, `packages/skill/*`, `packages/hooks/*` sources; `packages/subagent/README.md` + `subagent` service, `depth.ts`, `out-of-process.ts`, and both tool packages; `packages/preset/agent-preset`; `packages/bundle` READMEs and `base/package.json`; `packages/boot/app-boot/src/index.ts` (composition portions); `vendor/include/src/index.ts`; this workspace's `README.md` and `cordis.patch.yml`; `docs/user/guide/mcp-memory.md`.
- **Read directly (Codex):** `codex-mcp/src/tools.rs`, `tool_catalog_cache.rs`, `elicitation.rs` (header + function inventory), `resource_client.rs` (partial); `rmcp-client` file inventory; `skills/src/lib.rs`, `parser.rs`, `model.rs`, `loading.rs` (signatures); `ext/skills/src/catalog_prompt.rs`, `dynamic_skill_selector.rs` (header), `tools/mod.rs` (constants); `hooks/src/lib.rs`, `events/pre_tool_use.rs`, `events/permission_request.rs`, `engine/dispatcher.rs` (handler dispatch), `engine/discovery.rs` (trust gate), `config_rules.rs`; `memories/README.md` (complete); `ext/memories/src/lib.rs`, `local/path.rs`; `core/src/agent/{mod,role,registry}.rs` + builtins; `core/src/tools/handlers/multi_agents_spec.rs` (tool names), `tool_search_spec.rs`, `tool_namespaces_info.rs`, `spec_plan.rs` (exposure policy); `tools/src/tool_executor.rs` (exposure enum); `config/src/{mcp_types,config_layer_source,profile_toml,hook_config}.rs`; `features/src/lib.rs` (Stage + spec table); `plugin/src/manifest.rs`; `core-plugins/src/lib.rs`; `worktree/src/{lib,settings}.rs`.
- **Not exhaustively read (large surfaces):** `rmcp-client` (28 142 lines) — file inventory plus targeted greps only; `core-plugins` (43 557 lines) — structure, `lib.rs`, and manifest schema; `ext/skills` (22 063 lines) — catalog/prompt/tool/selector surfaces; `ext/guardian-v2` (10 718 lines) — out of axis; `hooks` (15 037 lines) — events, dispatcher, discovery, config.
- **Absence claims** ("DSH has no OAuth", "DSH has no tool search", "Codex has no MCP prompts", "DSH has no worktree support") rest on whole-tree greps over `--include=*.ts` / `--include=*.rs` with the patterns quoted inline. They are strong but are absence-of-evidence, not proof; each is marked **VERIFIED** only where the grep covered the full candidate surface and a positive doc statement corroborates it.
- **No files were modified in either source tree.** The only write was this report.
