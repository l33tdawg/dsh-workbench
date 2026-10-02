# 02 — Tool surface: inventory, schemas, and capability gaps

**Axis:** Tool surface — inventory, schemas, and capability gaps.
**Method:** read-only source archaeology. Nothing was modified.

| | Repo | Rev | Language |
|---|---|---|---|
| **DSH** | `/Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src` | `639ed015397290b3745d163aafe02ffee4aa3f84` (tag `dsh-v0.2.0-rc.2`) | TypeScript, pnpm monorepo, `packages/<group>/<name>` |
| **Codex** | `/Users/l33tdawg/nodejs-projects/codex` | `2abb02bc004fe2847d1f99f47610c92d1744b22d` (branch `codex/fix-local-provider-namespace-tools`) | Rust, `codex-rs/<name>` |

**Evidence convention.** Every claim carries `path:line`. **[V]** = VERIFIED (line read directly). **[I]** = INFERRED (derived from adjacent verified evidence). Paths under DSH are relative to the DSH repo root; paths under Codex are relative to `/Users/l33tdawg/nodejs-projects/codex/codex-rs/`.

**Scope note.** DSH ships several *profiles* (`packages/bundle/{base,web-app,headless,sdk-minimal,sdk-app,acp-app}`). Codex ships one binary whose tool list is assembled per turn from features + provider capabilities + model info. Both are therefore *sets of possible tools*, not one fixed list. Where I say "default", I mean DSH `packages/bundle/base` (the plain CLI profile) and Codex's `default_enabled: true` feature set with a namespace-capable provider.

---

## 1. DSH tool-definition contract

### 1.1 Model-facing schema type

`ToolSchema` is deliberately minimal — five fields total:

```ts
// packages/llm/llm/src/types.ts:473-484  [V]
export interface ToolSchema {
  deferLoading?: true          // requests deferred definition loading
  name: string
  description: string
  parameters: Record<string, unknown>
}
```

**There is no namespace field.** Tool identity is one flat string. The `mcp__server__tool` form is a naming *convention* encoded inside the name, not a structured namespace — see `packages/mcp/mcp-client/src/tools.ts:1-10` ("every MCP tool has the stable identity `(serverName, rawName)`; the model-facing public name is `mcp__<serverName>__<rawName>`"). **[V]** A corollary appears in the naming constraint code: public names are truncated/normalized to the 64-char, `[A-Za-z0-9_-]` DeepSeek function-name contract (`mcp-client/src/tools.ts:51-56`). **[V]**

### 1.2 Execution-side definition

`ToolDefinition extends ToolSchema` and adds execution + presentation furniture (`packages/core/tools/src/index.ts:223-300` **[V]**):

| Field | Line | Model-visible? |
|---|---|---|
| `output: ToolOutputDefinition` (**mandatory**) | `index.ts:225` | no |
| `execute(args, exec): Promise<unknown>` | `index.ts:238` | no |
| `projectContent?` | `index.ts:249` | no |
| `finalizeContent?` | `index.ts:258` | no |
| `timeoutMs?` | `index.ts:266` | **explicitly never sent** (`index.ts:262-264`) |
| `isConcurrencySafe?(args)` | `index.ts:280` | no |
| `presentCall?` / `presentResult?` | `index.ts:290`, `index.ts:294` | no |

The allowlist is enforced in one place, `schemaOf`:

```ts
// packages/core/tools/src/index.ts:1282-1295  [V]
private schemaOf(definition: ToolDefinition, detachParameters: boolean): ToolSchema {
  const { name, description, parameters, deferLoading } = definition
  ...
  return { name, description, parameters: detached, ...deferLoading === true ? { deferLoading } : {} }
}
```

`ToolOutputDefinition` (`index.ts:213-221`) requires a raw JSON Schema plus a `render(args, value)` projection, so **every DSH tool declares a canonical output schema** and the registry validates the tool's return value against it (`index.ts:213-218`). **[V]**

### 1.3 Schema DSL and root openness — a real hole

DSH authoring uses a custom DSL (`packages/core/tools/src/schema.ts:1-108`), compiled to raw JSON Schema:

```ts
// packages/core/tools/src/schema.ts:444-457  [V]
/**
 * Compile the implicit open parameter object into raw JSON Schema.
 * ... An object-rooted raw schema with no implicit-root openness override.
 */
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): ParameterJsonSchema {
  const compiled = compilePropertyMap(spec, 'parameters')
  const schema: ParameterJsonSchema = {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  }
  ...
}
```

No `additionalProperties` is emitted at the parameter root, and the validator only rejects undeclared keys when the keyword is *explicitly* present:

```ts
// packages/core/tools/src/json-schema.ts:573-579  [V]
if (Object.hasOwn(frame.node, 'additionalProperties') && frame.node.additionalProperties === false) {
  for (const key of Object.keys(frame.value)) {
    if (!Object.hasOwn(properties, key)) {
      tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`)
    }
  }
}
```

**Consequence [V→I]:** a DSH tool call with a misspelled or extra **top-level** argument is accepted and silently ignored at the schema boundary. Only nested objects that opted in (e.g. `todo_write` items at `packages/todo/tool-todo/src/index.ts:145-154` **[V]**) are closed. Codex closes every root — see §3.2.

### 1.4 Expressive power of the DSL

The DSL supports `enum` + `const` on scalars (`schema.ts:25-56`), `oneOf` (`schema.ts:80-83`), typed arrays (`schema.ts:63-67`), a raw `json` escape hatch (`schema.ts:70-73`), and mandatory `additionalProperties: boolean` on explicit object specs (`schema.ts:74-79`). **[V]**

Real usage in shipped tools — `enum`:

- `packages/todo/tool-todo/src/index.ts:151` — `enum: [...STATUSES]`
- `packages/goal/tool-goal/src/index.ts:243` — `enum: UPDATE_ACTIONS` (`['edit','pause','resume','complete','blocked']`, line 49)
- `packages/lsp/tool-lsp/src/index.ts:117` — `enum: [...LSP_OPERATIONS]`
- `packages/jobs/tool-jobs/src/index.ts:77` — job status; `:387` — kill outcome
- `packages/terminal/tool-terminal/src/index.ts:339` — `SIGINT|SIGTERM|SIGKILL|SIGTSTP|SIGHUP`
- `packages/boot/plugin-manager/src/tools.ts:23` — 8-value action enum
- `packages/fs/tool-str-replace-editor/src/index.ts:436` — `view|create|str_replace|insert`
- `packages/extensions/tool-cordis/src/index.ts:51` — `host|client`

`oneOf`: `packages/fs/tool-fs/src/write.ts:89`, `packages/shell/tool-bash/src/index.ts:410/431-432`, `packages/workflow/tool-workflow/src/index.ts:377`, `packages/goal/tool-goal/src/index.ts:75`, `packages/terminal/tool-terminal/src/index.ts:75/213`. **[V]**

---

## 2. Complete DSH tool inventory

### 2.1 Which packages actually register tools

Exhaustive search for `defineTool(` outside tests/dist returns 42 files. Beyond the task's list I also found: `experimental/tool-agent-team`, `mcp/mcp-client`, `mcp/mcp-resources`, `schedule/schedule`, `subagent/tool-subagent-control`, `shell/tool-pwsh-persistent`, `boot/plugin-manager`, and `core/tools/src/ptc.ts` (`run_code`). **[V]**

Profile membership (from `packages/bundle/*/package.json`) **[V]**:

| Tool package | base | web-app | sdk-minimal | sdk-app |
|---|:-:|:-:|:-:|:-:|
| `tool-fs`, `tool-fs-search` | ✓ | ✓ | | |
| `tool-bash`, `tool-pwsh` | ✓ | ✓ | | |
| `tool-bash-persistent`, `tool-pwsh-persistent` | | ✓ | ✓ | |
| `tool-web`, `tool-todo`, `tool-skill` | ✓ | ✓ | | |
| `tool-subagent`, `tool-subagent-control` | ✓ | ✓ | | |
| `tool-jobs`, `tool-workflow`, `tool-ralph` | ✓ | ✓ | | |
| `tool-goal`, `tool-present` | ✓ | ✓ | | |
| `mcp-resources` | ✓ | | ✓ | |
| `plan-mode` | ✓ | ✓ | | |
| `plugin-manager` | ✓ | ✓ | | |
| `tool-ask-user` | | ✓ | | |
| `tool-cordis` | | ✓ | | |
| `tool-workspace-dependencies` | | | | ✓ |
| `tool-terminal`, `tool-lsp`, `tool-session-query`, `tool-str-replace-editor`, `tool-agent-team`, `schedule` | **none** | | | |

`tool-terminal`, `tool-lsp` and `tool-str-replace-editor` ship in **no** bundle at this SHA — they are opt-in packages. **[V]** (`tool-session-query` and `mcp-client` appear only as root devDependencies at DSH `package.json:221-222`.) **[V]**

### 2.2 Inventory table

Description length is the model-facing string length, measured from source. **[V]** `†` = always present in `base`; `‡` = conditional.

| # | Tool | Package:line | Desc len | Params | Cond? |
|---|---|---|---|---|---|
| 1 | `read` | `fs/tool-fs/src/read.ts:78` | 56 | `file_path`*, `offset`, `limit` | † |
| 2 | `write` | `fs/tool-fs/src/write.ts:73` | 42 | `file_path`*, `content`*, +escalation | † |
| 3 | `edit` | `fs/tool-fs/src/edit.ts:85` | 59 | `file_path`*, `old_string`*, `new_string`*, `replace_all` | † |
| 4 | `read_image` | `fs/tool-fs/src/read-image.ts:210` | 174 | `file_path`* | † |
| 5 | `glob` | `fs/tool-fs-search/src/glob.ts:307` | 250 | `pattern`*, `path` | † |
| 6 | `grep` | `fs/tool-fs-search/src/grep.ts:285` | 221 | `pattern`*, `path`, `include` | † |
| 7 | `bash` | `shell/tool-bash/src/index.ts:374` | 738 | `command`*, `description`*, `timeoutMs`, `workdir`, `run_in_background`, `sandbox_permissions`, `justification` | † |
| 8 | `bash` (persistent) | `shell/tool-bash-persistent/src/index.ts:414` | ~150 | `command`* | web-app/sdk-minimal |
| 9 | `pwsh` | `shell/tool-pwsh/src/index.ts:384` | ~700 | mirrors `bash` | † |
| 10 | `web_fetch` | `web/tool-web/src/fetch.ts:457` | 74 | `url`* | † |
| 11 | `web_search` | `web/tool-web/src/search.ts:326` | 101 | `queries`* (array of string) | † |
| 12 | `todo_write` | `todo/tool-todo/src/index.ts:136` | ~330 | `todos`* (array of `{content*, status*}`) | † |
| 13 | `subagent` | `subagent/tool-subagent/src/index.ts:380` | ~430 | `description`*, `prompt`*, `provider`, `model`, `reasoning_effort`, `run_in_background` | † |
| 14 | `send_message` | `subagent/tool-subagent-control/src/index.ts:29` | 170 | `agent_id`*, `message`* | † |
| 15 | `interrupt_agent` | `subagent/tool-subagent-control/src/index.ts:75` | 203 | `agent_id`* | † |
| 16 | `list_agents` | `subagent/tool-subagent-control/src/list-agents.ts:87` | 276 | `scope` (enum) | † |
| 17 | `job_output` | `jobs/tool-jobs/src/index.ts:311` | 116 | `job_id`*, `wait`, `timeout_ms` | † |
| 18 | `job_list` | `jobs/tool-jobs/src/index.ts:352` | 85 | — | † |
| 19 | `job_kill` | `jobs/tool-jobs/src/index.ts:372` | 49 | `job_id`*, `reason` | † |
| 20 | `skill` | `skill/tool-skill/src/index.ts:82` | 139 | `name`* | † |
| 21 | `present` | `deliverables/tool-present/src/index.ts:39` | 274 | `files`* (array of `{path*, description}`) | † |
| 22 | `workflow` | `workflow/tool-workflow/src/index.ts:329` | ~1700 | `script`*, `meta`*, `args`, `run_in_background` | † |
| 23 | `ralph` | `workflow/tool-ralph/src/index.ts:411` | ~490 | `objective`*, `maxRounds` | † |
| 24 | `get_goal` | `goal/tool-goal/src/index.ts:196` | 95 | — | † |
| 25 | `create_goal` | `goal/tool-goal/src/index.ts:208` | 222 | `objective`*, `max_goal_rounds` | † |
| 26 | `update_goal` | `goal/tool-goal/src/index.ts:235` | 24 | `goal_id`*, `revision`*, `action`* (enum), `objective`, `max_goal_rounds`, `blocked_reason` | † |
| 27 | `list_mcp_resources` | `mcp/mcp-resources/src/tools.ts:34` | 44 | `server`, `cursor` | ‡ MCP configured |
| 28 | `list_mcp_resource_templates` | `mcp/mcp-resources/src/tools.ts:43` | 61 | `server`, `cursor` | ‡ MCP configured |
| 29 | `read_mcp_resource` | `mcp/mcp-resources/src/tools.ts:52` | 101 | `server`, `uri`* | ‡ MCP configured |
| 30 | `plan` (exit) | `plan/plan-mode/src/index.ts:233` | 447 | `plan`* | ‡ plan mode active |
| 31 | `plugin_manager` | `boot/plugin-manager/src/tools.ts:20` | 695 | 9 params incl. 8-value `action`* | † (Web/CLI managed profiles) |
| 32 | `ask_user_question` | `interaction/tool-ask-user/src/index.ts:39`, `timed.ts:107` | ~250 | `questions`* | web-app |
| 33 | `cordis_inspect_list` | `extensions/tool-cordis/src/index.ts:23` | 465 | — | web-app |
| 34 | `cordis_inspect_query` | `extensions/tool-cordis/src/index.ts:42` | 591 | `platform`*, `provider`*, `method`*, `input` | web-app |
| 35 | `load_workspace_dependencies` | `skill/tool-workspace-dependencies/src/index.ts:250` | — | — | sdk-app |
| 36 | `lsp` | `lsp/tool-lsp/src/index.ts:110` | 232 | `operation`*(enum), `file_path`*, `line`*, `character`* | opt-in |
| 37 | `terminal_open/send/read/signal/close/list` | `terminal/tool-terminal/src/index.ts:164,199,302,335,360,391` | 154/210/88/88/85/61 | see source | opt-in |
| 38 | `str_replace_editor` | `fs/tool-str-replace-editor/src/index.ts:430` | config | `command`*(enum), `path`*, 5 nullable | opt-in |
| 39 | `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read` | `session-query/tool-session-query/src/index.ts:66,76,86,96,109` | 104/106/121/110/103 | see `input.ts` | opt-in |
| 40 | `spawn_teammate`, `team_task_{create,list,get,update}`, +5 | `experimental/tool-agent-team/src/index.ts:176-361` | — | — | experimental |
| 41 | `schedule_create/list/delete/update` | `schedule/schedule/src/tools.ts:417,452,470,493` | — | — | experimental |
| 42 | `run_code` (PTC) | `core/tools/src/ptc.ts:336` (`RUN_CODE_NAME` at `ptc.ts:30`) | ~1 KB, language-aware | `code`*, `description`*, + controls | ‡ PTC mode |
| 43 | `mcp__<server>__<raw>` | `mcp/mcp-client/src/tools.ts:132-150` | from server | from server | ‡ only where `mcp-client` is loaded |

`*` = required.

**DSH total in the plain `base` profile, no MCP, no plan mode: 26 tools.** **[V]** (rows 1–4, 5–6, 7, 9, 10–11, 12, 13–16, 17–19, 20, 21, 22, 23, 24–26, 31 → 26.) `run_code` is **not** in that count: it is inserted into the visible set only when `modeFor(scope) !== 'native'` (`core/tools/src/index.ts:1214-1216`), so a native-mode agent cannot even see it (`index.ts:1216`); `mode: 'both'` yields 27. With the Web GUI profile add `ask_user_question` and `cordis_inspect_*`.

### 2.3 DSH guidance lives in the system prompt, not the description

This is the single most important structural fact about the DSH surface. DSH registers **31 system-prompt sections** (`grep -rn "systemPrompt.section({"`, non-test = 31 **[V]**), of which ~20 are named `tool:<name>`. The tool description stays terse; cross-call guidance goes into a prompt section that is **conditional on the tool actually being visible in that agent's scope**:

```ts
// packages/fs/tool-fs/src/read.ts:69-75  [V]
ctx.systemPrompt.section({
  name: 'tool:read',
  order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
  text: ({ scope }) => ctx.tools.get('read', scope) === undefined
    ? ''
    : 'Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.',
})
```

Other examples: `fs/tool-fs/src/edit.ts:76-82` (read-before-edit), `fs/tool-fs-search/src/grep.ts:275-282` (grep-not-rg), `shell/tool-bash/src/index.ts:259-264` (exit-code marker), `jobs/tool-jobs/src/index.ts:250-254` (job hygiene), `web/tool-web/src/fetch.ts:448-454` (untrusted content + cite), `goal/tool-goal/src/index.ts:190-194`, `workflow/tool-ralph/src/index.ts:405-409`, `terminal/tool-terminal/src/index.ts:158-163`, `plan/plan-mode/src/index.ts:217-225`. **[V]**

Runtime corroboration: this very session's system prompt contains those section texts verbatim (e.g. the exit-code marker sentence and the read-before-edit rule), so the mechanism demonstrably fires. **[V]**

---

## 3. Complete Codex tool inventory

### 3.1 Architecture: registry + exposure, not a static list

Codex has **no `tools/spec.rs`** (that file does not exist at this SHA). The tool list is built each turn:

```
build_core_tool_registry()            core/src/tools/spec_plan.rs:281
  └─ add_core_tool_sources()          core/src/tools/spec_plan.rs:996
       ├─ add_shell_tools()           core/src/tools/spec_plan.rs:1097
       ├─ add_mcp_resource_tools()    core/src/tools/spec_plan.rs:1145
       ├─ add_core_utility_tools()    core/src/tools/spec_plan.rs:1154
       └─ add_collaboration_tools()   core/src/tools/spec_plan.rs:1277
finalize_tool_router()                core/src/tools/spec_plan.rs:348
  └─ build_model_visible_specs()      core/src/tools/spec_plan.rs:538
       └─ merge_into_namespaces()     core/src/tools/spec_plan.rs:922
```
**[V]** — each handler is added with `registry.add(..)` / `register_trusted_*`, and `build_model_visible_specs` keeps only `exposure.is_direct()` entries (`spec_plan.rs:544-552`). **[V]**

The spec type is an enum with five wire shapes — `ToolSpec::{Function, Freeform, Namespace, ToolSearch, WebSearch}` (`tools/src/responses_api.rs:46-55` shows `LoadableToolSpec`; `ToolSpec` itself is `tools/src/tool_spec.rs`). **[V]** `ResponsesApiTool` carries `name, description, strict, defer_loading, parameters, output_schema` (`tools/src/responses_api.rs:31-44`). **[V]**

### 3.2 Exposure model — six levels

```rust
// tools/src/tool_executor.rs:51-99  [V]
pub enum ToolExposure {
  Direct,            // in the initial model-visible list (also nested in code mode)
  Deferred,          // registered for later discovery, omitted from the initial list
  DeferredModelOnly, // discoverable via search, not nestable in code mode
  DirectModelOnly,   // initial list only; excluded from the nested code-mode surface
  CodeModeOnly,      // only callable from inside code mode
  Hidden,            // dispatchable, never model-visible
}
```
Default is `Direct` (`tool_executor.rs:113-115`). **[V]**

### 3.3 Inventory table

Desc length = model-facing string, measured from source. **[V]** "Cond" cites the gate.

| # | Tool (wire name) | Spec site | Desc len | Params (R = required) | Cond |
|---|---|---|---|---|---|
| 1 | `exec_command` | `core/src/tools/handlers/shell_spec.rs:96` | 88 (+902 Windows guidance) | `cmd`R, `workdir`, `tty`, `yield_time_ms`, `max_output_tokens`, `shell`, `login`, `environment_id`, `sandbox_permissions`(enum), `justification`, `prefix_rule`, `additional_permissions` | `Feature::ShellTool` (=true), `shell_type != Disabled`, environment ready, `Feature::UnifiedExec` (=true) — `spec_plan.rs:1097-1128` |
| 2 | `write_stdin` | `shell_spec.rs:146` | 80 | `session_id`R, `chars`, `yield_time_ms`, `max_output_tokens` | same, requires `UnifiedExec` |
| 3 | `apply_patch` | `core/src/tools/handlers/apply_patch_spec.rs:19` | 108 + 578-byte Lark grammar | **FREEFORM** (grammar, not JSON) | `model_info.apply_patch_tool_type.is_some()` — `spec_plan.rs:1258-1261` |
| 4 | `view_image` | `core/src/tools/handlers/view_image_spec.rs:43` | 124 | `path`R, `detail`(enum `high|original`), `environment_id` | `Feature::ViewImage` (=true) — `spec_plan.rs:1266` |
| 5 | `update_plan` | `core/src/tools/handlers/plan_spec.rs:43`, handler `plan.rs:50` | 157 | `explanation`, `plan`R (array of `{step`R, `status`R enum`}`) | `config.update_plan_enabled`, default true — `core/src/config/mod.rs:2639-2644` |
| 6 | `request_user_input` | `core/src/tools/handlers/request_user_input_spec.rs:77` | 126 | `questions`R (array of `{id`R, `header`R, `question`R, `options`R`}`) | `experimental_request_user_input_enabled`; `ToolExposure::DirectModelOnly` — `spec_plan.rs:1180-1185` |
| 7 | `request_permissions` | `shell_spec.rs:180` | 486 | `reason`, `environment_id`, `permissions`R | `Feature::RequestPermissionsTool` (default **false**) — `spec_plan.rs:1193` |
| 8 | `list_mcp_resources` | `handlers/mcp_resource_spec.rs:23` | 238 | `server`, `cursor` | `mcp.has_servers()` — `spec_plan.rs:1145-1151` |
| 9 | `list_mcp_resource_templates` | `mcp_resource_spec.rs:51` | 300 | `server`, `cursor` | same |
| 10 | `read_mcp_resource` | `mcp_resource_spec.rs:79` | 93 | `server`, `uri` | same |
| 11 | `mcp__<server>__<tool>` | `core/src/mcp_tool_exposure.rs:88-92` | from server, truncated to 1000 B (`tools/src/mcp_tool.rs:7,50-55`) | from server | always when MCP servers exist; **`Deferred` iff `search_tool_enabled`** |
| 12 | `spawn_agent` (v1) | `handlers/multi_agents_spec.rs:85` | long (model list + agent types) | `agent_type`, `message`, `model`, … | `Feature::Collab` (=true) and spawn depth under `agent_max_depth` — `spec_plan.rs:670-682` |
| 13 | `send_input` (v1) | `multi_agents_spec.rs:170` | — | `agent_id`, `message`, `interrupt` | same; **`Deferred` when `search_tool_enabled`** (`spec_plan.rs:1336-1352`) |
| 14 | `resume_agent` (v1) | `multi_agents_spec.rs:252` | — | — | same |
| 15 | `wait_agent` (v1) | `multi_agents_spec.rs:269` | 264 | `agent_ids`, `timeout_ms` (bounded `multi_agents_common.rs`) | same |
| 16 | `close_agent` (v1) | `multi_agents_spec.rs:323` | — | — | same |
| 17 | `spawn_agent` / `send_message` / `followup_task` / `wait_agent` / `interrupt_agent` / `list_agents` (v2) | `handlers/multi_agents_v2/{spawn,send_message,followup_task,wait,interrupt_agent,list_agents}.rs:32/12/12/23/10/10` | — | — | `MultiAgentVersion::V2` (feature `multi_agent_v2` default **false**) — `spec_plan.rs:1284-1334` |
| 18 | `get_goal` | `ext/goal/src/spec.rs:13` | 122 | — | `Feature::Goals` (=true), extension contributor — `ext/goal/src/extension.rs:457` |
| 19 | `create_goal` | `ext/goal/src/spec.rs:25` | 277 | `objective`R, `token_budget` | same |
| 20 | `update_goal` | `ext/goal/src/spec.rs:60` | **1362** | `status`R (enum `complete|blocked`) | same |
| 21 | `skills.list` | `ext/skills/src/tools/list.rs:31,68` | 187 | `authority`R, `cursor` | orchestrator/executor skills available — `ext/skills/src/tools/mod.rs:65-74` |
| 22 | `skills.read` | `ext/skills/src/tools/read.rs:34,60` | 553 | `package`R, `resource`, `cursor` | same |
| 23 | `memories.add_ad_hoc_note` / `.list` / `.read` / `.search` | `ext/memories/src/lib.rs:19-22` | — | — | `Feature::MemoryTool` (default **false**) — `ext/memories/src/extension.rs:44` |
| 24 | `image_gen.imagegen` | `ext/image-generation/src/tool.rs:119` | `imagegen_description.md` | — | `Feature::ImageGeneration` (=true) — `spec_plan.rs:726` |
| 25 | `web.run` | `ext/web-search/src/tool.rs:53-54` | — | — | `Feature::StandaloneWebSearch` (default **false**) — `spec_plan.rs:1057-1066` |
| 26 | `web_search` (hosted) | `core/src/tools/hosted_spec.rs:32` | provider-side | provider-side | provider `capabilities().web_search` and standalone search unavailable — `spec_plan.rs:629-641` |
| 27 | `history.*` / `notes.*` | `ext/history-notes/src/tools.rs:24-25,56-70` | — | — | extension contributor |
| 28 | `clock.curr_time` | `core/src/tools/handlers/current_time.rs:57-63` | **31** | none | `Feature::CurrentTimeReminder` (default false) **or** model advertises `clock` — `spec_plan.rs:1211-1218` |
| 29 | `clock.sleep` | `core/src/tools/handlers/sleep.rs:49` | 143 | `duration_ms`R | `Feature::SleepTool`(=true) **and** `SleepToolMode::ModelDriven` + clock (default `ModelDriven`, `features/src/feature_configs.rs:402-405`) |
| 30 | `get_context_remaining` | `handlers/get_context_remaining_spec.rs:13` | ~56 | — | `Feature::TokenBudget` (default **false**) — `spec_plan.rs:1199-1201` |
| 31 | `new_context_window` | `handlers/new_context_window_spec.rs:11` | 96 | — | same; `DirectModelOnly` |
| 32 | `wait_for_environment` | `handlers/wait_for_environment.rs:18,84` | configurable | `environment_id`R | `Feature::DeferredExecutor` (default **false**) — `spec_plan.rs:1164-1174` |
| 33 | `tool_search` | `handlers/tool_search_spec.rs:16,97` | ~400 + source list (≤512 KiB, `tool_search_spec.rs:8`) | `query`R, `limit` | `model_info.supports_search_tool` + `namespace_tools_enabled` **and** ≥1 deferred tool with search info — `spec_plan.rs:360-398` |
| 34 | `list_available_plugins_to_install` | `handlers/list_available_plugins_to_install_spec.rs:32` | ~430 | — | `Feature::{ToolSuggest,Apps,Plugins}` (all true) + candidates — `spec_plan.rs:1226-1235` |
| 35 | `request_plugin_install` | `handlers/request_plugin_install_spec.rs:102,161` | ~330 / ~430 (two presentations) | varies | same |
| 36 | `send_user_message_async` | `spec_plan.rs:1188-1191` | — | — | model `experimental_supported_tools`; `DirectModelOnly` |
| 37 | `test_sync_tool` | `handlers/test_sync_spec.rs:59` | 82 | — | model `experimental_supported_tools` |
| 38 | `exec` (code mode) | `core/src/tools/code_mode/execute_spec.rs:26` | `build_exec_tool_description`, long | **FREEFORM** JS with Lark grammar (`// @exec:` pragma) | `ToolMode::{CodeMode,CodeModeOnly}` (features default **false**) — `spec_plan.rs:816-826` |
| 39 | `wait` (code mode) | `core/src/tools/code_mode/wait_spec.rs:9` | ~200 | `cell_id`R, `yield_time_ms`, `max_tokens`, `terminate` | same |
| 40 | dynamic tools | `core/src/tools/spec_plan.rs:1366-1395`, `tools/src/dynamic_tool.rs:5-15` | caller-supplied | caller-supplied | host-supplied `DynamicToolSpec` |

**Codex always-loaded count in a default CLI session** (namespace-capable provider, no MCP, no plan mode): `exec_command`, `write_stdin`, `apply_patch`, `view_image`, `update_plan`, `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`, `get_goal`, `create_goal`, `update_goal`, `skills.list`, `skills.read`, `image_gen.imagegen` = **16 direct tools**, plus `tool_search` if any deferred tool exists, plus hosted `web_search` if the provider supports it, plus every non-deferred MCP tool. **[I]** — the enumeration is VERIFIED per-row; the *count* is inferred because the model-info fields (`apply_patch_tool_type`, `experimental_supported_tools`, `supports_search_tool`) are provider-supplied.

### 3.4 Feature defaults that gate the surface

Extracted from `features/src/lib.rs` `FEATURES` **[V]** — the ones that control tool visibility:

`true`: `ShellTool`, `ViewImage`, `SleepTool`, `UnifiedExec`, `Collab`, `Goals`, `ImageGeneration`, `Apps`, `Plugins`, `ToolSuggest`, `SkillSearch`, `WorkspaceDependencies`, `CodeModeHost`, `GuardianApproval`.
`false`: `CodeMode`, `CodeModeOnly`, `MultiAgentV2`, `MemoryTool`, `TokenBudget`, `RequestPermissionsTool`, `StandaloneWebSearch`, `DeferredExecutor`, `CurrentTimeReminder`, `ToolSearch` (stage `Removed`), `DeferredToolWorldState`.

Note `Feature::WorkspaceDependencies` is `default_enabled: true` (`features/src/lib.rs:1680-1682`) **[V]** but **no tool is registered for it anywhere in this SHA** — grep over all Rust sources finds only the feature definition and two config-schema keys. **[V]** So Codex's `load_workspace_dependencies` analogue is currently dead wiring, while DSH's `load_workspace_dependencies` is a real tool (`skill/tool-workspace-dependencies/src/index.ts:250`). **[V]**

---

## 4. Side-by-side capability table

| Capability | DSH tool | Codex tool | Notes |
|---|---|---|---|
| Read text file | `read` (`fs/tool-fs/src/read.ts:78`) | — (no dedicated file-read tool) | **DSH only.** Codex reads via `exec_command` (`cat`) or code mode. **[V]** |
| Write whole file | `write` (`fs/tool-fs/src/write.ts:73`) | — | **DSH only.** Codex uses `apply_patch` add-file hunks. **[V]** |
| String-replace edit | `edit` (`fs/tool-fs/src/edit.ts:85`) | — | **DSH only**; DSH `str_replace_editor` is a richer opt-in variant. Codex has no literal-replace tool. **[V]** |
| Multi-hunk patch | — | `apply_patch` (FREEFORM + Lark grammar) | **Codex only**, and it is the only non-JSON tool format either harness ships. **[V]** |
| Find files by glob | `glob` (`fs/tool-fs-search/src/glob.ts:307`) | — | **DSH only.** `codex-rs/file-search` exists (`file-search/src/{lib,cli,main}.rs`) but registers **no model tool** at this SHA — it is a CLI/library only. **[V]** |
| Search file contents | `grep` (`fs/tool-fs-search/src/grep.ts:285`) | — (`tool_search` searches *tool metadata*, not files) | **DSH only.** **[V]** |
| Read image | `read_image` (`fs/tool-fs/src/read-image.ts:210`) | `view_image` (`view_image_spec.rs:43`) | Both. Codex adds `detail` enum `high\|original`; DSH auto-downscales with no knob. **[V]** |
| Shell exec | `bash` (`tool-bash/src/index.ts:374`) | `exec_command` (`shell_spec.rs:96`) | Both. See §4.1. |
| Persistent shell state | `bash` persistent variant (`tool-bash-persistent/src/index.ts:414`) | `exec_command` + `write_stdin` (`shell_spec.rs:146`) | **Different designs.** DSH swaps the tool and keeps cwd/env per agent; Codex returns a `session_id` and adds a second tool for stdin. **[V]** |
| PTY / interactive stdin | `terminal_*` (opt-in; `tool-terminal/src/index.ts:164-391`) | `exec_command {tty:true}` + `write_stdin` | Codex's is always available; DSH's ships in **no** bundle. **[V]** |
| Background jobs | `run_in_background` on `bash` + `job_output`/`job_list`/`job_kill` | `yield_time_ms` → session id; `write_stdin` to poll | Both. DSH models first-class jobs; Codex models sessions. **[V]** |
| Plan/todo list | `todo_write` (`todo/tool-todo/src/index.ts:136`) | `update_plan` (`plan_spec.rs:43`) | Near-equivalent. Codex adds `explanation`; DSH enforces "one `in_progress`" except in parallel mode (`tool-todo/src/index.ts:51-57`). **[V]** |
| Plan mode entry/exit by model | `plan` exit tool (`plan/plan-mode/src/index.ts:233`, name `exit_plan_mode` at `:67`) | — | **DSH only.** Codex `ModeKind::Plan` exists (`protocol/src/config_types.rs:673-683`) but no model tool exits it; `update_plan` is explicitly *blocked* in plan mode (`handlers/plan.rs:87-91`). **[V]** |
| Web search | `web_search` (`web/tool-web/src/search.ts:326`) | `web.run` (ext) or hosted `ToolSpec::WebSearch` | Both. **[V]** |
| Web fetch | `web_fetch` (`web/tool-web/src/fetch.ts:457`) | — (hosted search only) | **DSH only** as a distinct tool. **[V]** |
| Ask the user | `ask_user_question` (`tool-ask-user/src/index.ts:39`) | `request_user_input` (`request_user_input_spec.rs:77`) | Both. Codex requires `label` **and** `description` per option with `additionalProperties:false`; DSH marks both objects `additionalProperties: true` (`tool-ask-user/src/index.ts` items). **[V]** |
| Subagent spawn | `subagent` (`tool-subagent/src/index.ts:380`) | `spawn_agent` (v1 `multi_agents_spec.rs:85` / v2 `multi_agents_v2/spawn.rs:33`) | Both, incl. model/agent-type overrides. **[V]** |
| Subagent messaging | `send_message` (`tool-subagent-control/src/index.ts:29`) | `send_input` (v1) / `send_message` + `followup_task` (v2) | Both. Codex v2 distinguishes "deliver" from "trigger a turn" (`multi_agents_spec.rs:232-233`); DSH `send_message` does both and says so. **[V]** |
| Subagent wait/list/interrupt | `list_agents`, `interrupt_agent` | `wait_agent`, `list_agents`, `interrupt_agent`, `close_agent`, `resume_agent` | Codex has more verbs (`wait`, `close`, `resume`). DSH has `interrupt_agent` + `list_agents` only. **[V]** |
| Skills | `skill` (`tool-skill/src/index.ts:82`) | `skills.list` + `skills.read` | Different designs: DSH loads by exact name; Codex pages with cursors and `skill://` resources. **[V]** |
| Goal (create/get/update) | `get_goal`/`create_goal`/`update_goal` | `get_goal`/`create_goal`/`update_goal` (`ext/goal/src/spec.rs:13,25,60`) | Both. Codex constrains `status` to `complete\|blocked`; DSH uses a 5-value enum incl. `edit/pause/resume` (human-authority gated). **[V]** |
| Deliverables / present files | `present` (`tool-present/src/index.ts:39`) | — | **DSH only.** **[V]** |
| Multi-agent workflow scripting | `workflow` (`tool-workflow/src/index.ts:329`) + `ralph` | — (code mode `exec` can call tools) | **DSH only** as a named fan-out tool. **[V]** |
| Programmatic tool calling | `run_code` (`core/tools/src/ptc.ts:336`) | `exec` + `wait` (code mode) | Both; see §6.5. |
| LSP navigation | `lsp` (opt-in; `tool-lsp/src/index.ts:110`) | — | **DSH only** (but not in any bundle). **[V]** |
| Session/event history query | `session_*` × 5 (opt-in) | `history.*` / `notes.*` (ext) | Both, different shapes. **[V]** |
| MCP resources | `list_mcp_resources`/`list_mcp_resource_templates`/`read_mcp_resource` | same three names (`mcp_resource_spec.rs:23,51,79`) | Both — near-identical. **[V]** |
| MCP tools | `mcp__<server>__<tool>` via `mcp-client` (**not in any bundle**) | `mcp__…` namespaced handlers, `Deferred` when search is on | Codex ships it in the default binary; DSH requires loading `@deepseek-ai/dsh-mcp-client`. **[V]** |
| Plugin/connector discovery | `plugin_manager` (`boot/plugin-manager/src/tools.ts:20`) | `list_available_plugins_to_install` + `request_plugin_install` | Different: DSH administers the profile; Codex elicits an install. **[V]** |
| Image generation | — | `image_gen.imagegen` (`ext/image-generation/src/tool.rs:119`) | **Codex only.** **[V]** |
| Memory tools | — | `memories.{add_ad_hoc_note,list,read,search}` | **Codex only**, feature-gated off by default. **[V]** |
| Clock | — | `clock.curr_time` (`current_time.rs:57-63`) | **Codex only.** **[V]** |
| Context-budget introspection | — | `get_context_remaining`, `new_context_window` | **Codex only**, `Feature::TokenBudget` default false. **[V]** |
| Permission escalation | `sandbox_permissions` param on `bash`/`pwsh`/`write`/`edit`/`run_code` | `sandbox_permissions` on `exec_command` **plus** `request_permissions` tool | Codex has both a per-call override and a standalone request tool. **[V]** |
| Multi-environment targeting | — | `environment_id` param on `exec_command`, `view_image`, `request_permissions`, `wait_for_environment` | **Codex only.** **[V]** |
| Tool discovery / lazy loading | `deferLoading` flag only (no shipped user) | `ToolExposure::Deferred` + `tool_search` (BM25) | **Codex only in practice.** See §6. |
| Namespaces | plain names only | `ResponsesApiNamespace` + `tool_namespaces_info` | **Codex only.** See §6.2. |
| Freeform/grammar tools | — | `apply_patch`, code-mode `exec` | **Codex only.** **[V]** |

### 4.1 `bash` vs `exec_command`, parameter by parameter

| Concept | DSH `bash` | Codex `exec_command` |
|---|---|---|
| Command | `command` R | `cmd` R |
| Human summary | `description` R | **absent** |
| Working dir | `workdir` | `workdir` |
| Timeout / yield | `timeoutMs` | `yield_time_ms` (250–30000 ms) |
| Output cap | truncate-to-tail + spill file (`tool-bash/src/index.ts:94`) | `max_output_tokens` (default 10000) |
| Interactive | `run_in_background` → job id | `tty: true` → `session_id` |
| Shell choice | **absent** | `shell`, `login` |
| Environment routing | **absent** | `environment_id` |
| Escalation | `sandbox_permissions` enum + `justification` | `sandbox_permissions` enum + `justification` + `prefix_rule` + `additional_permissions` |
| Root schema closure | **open** (`schema.ts:449-457`) | `additionalProperties: false` (`shell_spec.rs:108-112`) |

Sources: `shell/tool-bash/src/index.ts:374-419` and `core/src/tools/handlers/shell_spec.rs:24-115`. **[V]**

---

## 5. Capabilities Codex has that DSH lacks entirely

Ranked by how much they matter for agent capability.

**C1. Deferred tool loading with model-driven discovery (`tool_search`).** Codex can register a tool without putting it in the initial list (`ToolExposure::Deferred`, `tools/src/tool_executor.rs:58-62`), attach a searchable text blob (`ToolSearchInfo`, `tools/src/tool_search.rs:14-31`), and expose a `tool_search` tool whose description tells the model "Some of the tools may not have been provided to you upfront, and you should use this tool to search for the required tools" (`handlers/tool_search_spec.rs:93-95`). Matching is BM25 over `bm25::SearchEngine` (`handlers/tool_search.rs:11-14`); the default limit is `TOOL_SEARCH_DEFAULT_LIMIT`. DSH has the *word* (`deferLoading`, `llm/llm/src/types.ts:479`) and provider plumbing (`llm-deepseek/src/serialize.ts:164` emits `defer_loading: true`), but **no shipped tool ever sets it** — the only assignment is inside `projectToolUpdates` for mid-session additions (`llm/llm/src/content.ts:391`), and DSH has no discovery tool at all. **[V]**

**C2. First-class namespaces.** `ResponsesApiNamespace { name, description, tools }` (`tools/src/responses_api.rs:57-62`), merged (`spec_plan.rs:922-974`), flattened to `ns__tool` for providers without namespace support (`tools/src/tool_spec.rs:82-107`), de-collided by owner (`spec_plan.rs:437-465`), and mirrored into per-turn metadata (`core/src/tools/tool_namespaces_info.rs:18-111`). Codex ships namespaces: `clock`, `skills`, `memories`, `image_gen`, `web`, `history`, `notes`, `multi_agent_v1`. DSH has no namespace concept anywhere in `ToolSchema`. **[V]**

**C3. Freeform / grammar-constrained tools.** `ToolSpec::Freeform` with a `lark` grammar: `apply_patch` (`apply_patch_spec.rs:18-27`, grammar in `handlers/apply_patch.lark`, 578 bytes) and code-mode `exec` (`code_execute_spec.rs:19-27`). DSH's tool contract is JSON-schema-only. **[V]**

**C4. A patch tool.** `apply_patch` is the only way Codex edits files, and it is a multi-hunk, multi-file, add/delete/update patch applicator (`codex-rs/apply-patch/src/*`). DSH ships `edit`/`write`/`str_replace_editor` but nothing that applies a hunk-based patch. **[V]**

**C5. Image generation.** `image_gen.imagegen`, `Feature::ImageGeneration` default **true** (`features/src/lib.rs` ), registered via `spec_plan.rs:726`; description externalised to `ext/image-generation/imagegen_description.md`. DSH has zero image-generation code. **[V]**

**C6. Model-facing context-budget tools.** `get_context_remaining` (`get_context_remaining_spec.rs:12`) and `new_context_window` (`new_context_window_spec.rs:10`, `DirectModelOnly`). DSH has a token meter and compaction packages but no tool the model can call. **[V]**

**C7. Clock.** `clock.curr_time` in a namespace, plus `clock.sleep` with a mode enum (`SleepToolMode::{ModelDriven,AlwaysOn}`, `features/src/feature_configs.rs:402-408`). DSH: none. **[V]**

**C8. Standalone permission-request tool.** `request_permissions` lets the model ask for a *filesystem/network permission profile* (`shell_spec.rs:161-196`, `permission_profile_schema` at `:280-293`) mid-turn. DSH only offers per-call `sandbox_permissions` escalation attached to a command. **[V]**

**C9. `send_user_message_async`.** `DirectModelOnly`, gated on model support (`spec_plan.rs:1187-1192`). DSH has no equivalent model tool. **[V]**

**C10. `wait_agent` / `close_agent` / `resume_agent` verbs.** Codex's v1 collab set is 5 tools; v2 is 6 (`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`). DSH has 3 (`subagent`, `send_message`, `interrupt_agent`, `list_agents` = 4 counting the spawn tool). Codex can block on a mailbox update (`multi_agents_spec.rs:282-284`) and explicitly close agents to free the concurrency slot (`:323-324`). **[V]**

**C11. Memory tools.** `memories.{add_ad_hoc_note,list,read,search}` (`ext/memories/src/lib.rs:18-22`), gated off by default. **[V]**

**C12. MCP tool bridging in the default binary, with budget controls.** Deferral when search is enabled (`core/src/mcp_tool_exposure.rs:88-92`), 1000-byte description truncation for agent-plugin MCP tools (`tools/src/mcp_tool.rs:7,50-55`), 8 KB schema collapse to an open object (`tools/src/responses_api.rs:136-142`), and an 8 KB/64 KB total agent-plugin budget (`core/src/mcp_tool_exposure.rs:19-20`). DSH's `mcp-client` has none of these budgets and is not in any bundle. **[V]**

**C13. Dynamic host-supplied tools.** `DynamicToolSpec::{Function,Namespace}` → `DynamicToolHandler` (`spec_plan.rs:1366-1395`), with `defer_loading` honoured from the caller (`tools/src/dynamic_tool.rs:13`). DSH's analogue is the plugin system (`ctx.tools.register`), which is a host API rather than a wire-level dynamic-tool channel. **[V]**

**C14. Multi-environment routing.** `environment_id` on four tools plus the `wait_for_environment` lifecycle tool (`wait_for_environment.rs:18,84`). DSH's tools are single-environment. **[V]**

---

## 6. Capabilities DSH has that Codex lacks

Fairness section — DSH is genuinely ahead on several axes.

**D1. Dedicated file tools (`read`, `write`, `edit`, `glob`, `grep`).** Codex has **no** general-purpose file-read, file-write, glob, or ripgrep tool at all. Everything goes through `exec_command` (shell) or `apply_patch`. The only `read_file` string in the tree is the `notes.read_file` action of the history-notes extension (`ext/history-notes/src/tools.rs:77`, namespace `notes` at `:25`) — a note store, not the filesystem. DSH's `read` alone carries offset/limit paging, line numbering, image handling, and an observation policy that *requires* reading before editing (`fs/tool-fs/src/edit.ts:76-82`). The `file-search` crate exists in Codex but exposes no tool. **[V]**

**D2. Mandatory output schemas on every tool.** `ToolDefinition.output` is required (`core/tools/src/index.ts:225`) with a raw JSON Schema that the registry validates the canonical value against. Codex has 16 `output_schema: Some(..)` vs 29 `None`/absent across non-test spec sites, and the field is `#[serde(skip)]` (`tools/src/responses_api.rs:42-43`), so it never reaches the wire and is often simply not declared. **[V]**

**D3. A rich tool-execution pipeline.** DSH tools declare `timeoutMs`, `isConcurrencySafe(args)`, `projectContent`, `finalizeContent`, `presentCall`, `presentResult` (`core/tools/src/index.ts:249-300`), plus registry-level `tools/pre-execute` / `tools/execute` / `tools/post-execute` waterfalls and per-scope restrictions (`index.ts:1097`). Codex has `supports_parallel_tool_calls()` on the executor trait and hook names, but no per-tool presentation or output-projection contract. **[V]**

**D4. Conditional, scope-aware prompt sections.** DSH tool guidance can be a function of `{ scope }` and emitted **only when the tool is visible to that agent** (`fs/tool-fs/src/read.ts:72-74`). Applied together with per-agent `tools.restrict()` (`core/tools/src/index.ts:1097-1125`; child tool filters at `packages/subagent/subagent/src/types.ts:188`) and subagent-composition filters, this means a child agent doesn't pay for guidance about tools it cannot call. Codex's descriptions are static per spec and paid whenever the tool is direct. **[V]**

**D5. First-class background jobs.** `run_in_background` + `job_output`/`job_list`/`job_kill` with owner scoping, spill files, and a completion notice; timeout **promotes** a foreground command to a job instead of killing it (`shell/tool-bash/src/index.ts:385-392`). Codex's equivalent requires the model to hold a `session_id` and poll `write_stdin`. **[V]**

**D6. Multi-agent orchestration tools.** `workflow` (a JS script that fans out subagents with phases and structured results, `tool-workflow/src/index.ts:158-166` documents the whole API in the description) and `ralph` (fresh-agent iterative loop). Codex has no named fan-out tool. **[V]**

**D7. Deliverables (`present`).** `present` marks existing files as final deliverables with per-file descriptions (`tool-present/src/index.ts:39-60`). Codex has nothing similar. **[V]**

**D8. Model-facing plan-mode exit.** `exit_plan_mode` is a real tool with a validated body (`/^#\s+\S/` on the plan markdown, `plan/plan-mode/src/index.ts:233-300`). Codex's plan mode is client-controlled; `update_plan` is explicitly rejected there (`handlers/plan.rs:87-91`). **[V]**

**D9. LSP navigation.** `lsp` with `goToDefinition|findReferences|goToImplementation|hover` and an enum-constrained `operation` (`tool-lsp/src/index.ts:104-125`). Codex: none. **[V]** (Caveat: `tool-lsp` ships in no bundle.)

**D10. Session lineage querying.** `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read` (`session-query/tool-session-query/src/index.ts:60-115`). Codex's `history.*`/`notes.*` is a different, narrower feature. **[V]**

**D11. `plugin_manager` can actually change the profile.** 8 actions including `install_bundle` / `remove_bundle` / `set_version_exemption` with an approval gate (`boot/plugin-manager/src/tools.ts:20-40`). Codex's plugin tools only *suggest* an install to the client. **[V]**

**D12. Cross-call guidance keeps descriptions short without losing instruction.** DSH's `update_goal` description is 24 characters because the normative content lives in a prompt section (`goal/tool-goal/src/index.ts:115-123`). Codex's `update_goal` description is **1362** characters and must be re-sent with the tool block. Which is cheaper depends on caching, but DSH's split lets one section serve several tools with scope-conditional text. **[V]**

**D13. Sandbox escalation is uniform across the write/edit/exec/run_code surface.** `sandbox.escalationModes` / `sandbox.schemaFields()` are spread into `write`, `edit`, `bash`, `pwsh`, and `run_code` (`fs/tool-fs/src/write.ts:78`, `shell/tool-bash/src/index.ts:395-414`, `core/tools/src/ptc.ts`). Codex has it on `exec_command` only. **[V]**

---

## 7. Schema and description quality

### 7.1 Strictness

| Dimension | DSH | Codex |
|---|---|---|
| Root object closed? | **No** — `additionalProperties` never emitted at the root (`schema.ts:444-457`); unknown top-level args accepted (`json-schema.ts:573-579`) | **Yes** — 48 `Some(false.into())` sites across non-test handler/ext sources; e.g. `shell_spec.rs:108-112`, `plan_spec.rs:51-55`, `view_image_spec.rs:48` |
| `strict` mode | n/a (no such concept) | Field exists but is `false` on **every** shipped tool; the source carries a TODO admitting the mode is unimplemented (`responses_api.rs:35-38`) |
| Enum usage | ~20 sites, real (job status, todo status, goal action/phase, lsp op, signal names, sandbox modes, editor command, plugin action, cordis platform) | Real and frequent (`sandbox_permissions`, `plan[].status`, `update_goal.status`, `view_image.detail`, `sleep`/settings enums); much of it generated by `schemars` from Rust enums (`protocol/src/plan_tool.rs:7-13`) |
| `oneOf` / `anyOf` | `oneOf` used in ~7 tools | `any_of` supported by `JsonSchema` (`json_schema.rs`); `oneOf` used in `wait`/union outputs |
| Nested `additionalProperties: false` | Where authored: `todo_write` items (`tool-todo/src/index.ts:145`), `present` items (`tool-present/src/index.ts:49-65`), several output schemas | Nearly universal on inputs |
| Rust-side unknown-key rejection | n/a | `#[serde(deny_unknown_fields)]` on arg structs, e.g. `protocol/src/plan_tool.rs:16,23`, `ext/skills/src/tools/list.rs:22`, `core/src/tools/handlers/sleep.rs:31-32` |
| Schema generated vs hand-written | Hand-written DSL, type-inferred to TS at compile time (`schema.ts:1-108`) | Mixed: hand-built `BTreeMap` (`shell_spec.rs:35-93`) **and** `schemars`-derived (`ext/skills/src/tools/mod.rs:299-307` calls `schema::input_schema_for::<I>()` / `output_schema_for::<O>()`) |

**Verdict [V→I]:** Codex's *input* validation is stricter at the boundary (closed roots + `deny_unknown_fields`), which matters because a hallucinated key fails loudly instead of being dropped. DSH compensates with mandatory *output* schemas and registry-level validation of tool return values, which Codex mostly skips. Neither enforces OpenAI `strict: true`.

### 7.2 Description length and content

Measured model-facing description lengths **[V]**:

| Tool | DSH | Codex |
|---|---|---|
| shell exec | `bash` **738** | `exec_command` **88** (+902 Windows-only guidance) |
| plan/todo | `todo_write` ~330 | `update_plan` **157** |
| update goal | `update_goal` **24** | `update_goal` **1362** |
| create goal | `create_goal` **222** | `create_goal` **277** |
| get goal | `get_goal` **95** | `get_goal` **122** |
| read image | `read_image` **174** | `view_image` **124** |
| skills | `skill` **139** | `skills.list` **187**, `skills.read` **553** |
| ask user | ~250 | **126** |
| MCP resources | 44 / 61 / 101 | 238 / 300 / 93 |
| clock | — | `curr_time` **31**, `sleep` **143** |
| tool discovery | — | `tool_search` ~400 + ≤512 KiB source list |
| richest | `workflow` ~1700, `plugin_manager` 695, `bash` 738 | `update_goal` 1362, `windows_shell_guidance` 902, `skills.read` 553 |

**Where Codex puts guidance:** inline in the description, as normative prose with explicit prohibitions. The clearest example is `update_goal` (`ext/goal/src/spec.rs:60-100`), which enumerates "Set status to `complete` only when…", "Do not use `blocked` merely because the work is hard, slow, uncertain…", and a full audit-restart rule. Similarly `list_available_plugins_to_install` opens with "# List plugin/connector install candidates / Use this tool only when both are true:" (`list_available_plugins_to_install_spec.rs:33`), and `request_plugin_install` ends with "IMPORTANT: DO NOT call this tool in parallel with other tools." (`request_plugin_install_spec.rs:48`). Codex does **not** use JSON-Schema `examples` or `title` anywhere; guidance is prose only. **[V]**

**Where DSH puts guidance:** in `tool:*` system prompt sections that can interpolate runtime values. Examples: `bash` says "Check the `[exit code: N]` marker on every bash result" (`shell/tool-bash/src/index.ts:260-264`); `grep` says "Use the grep tool — not shell grep or rg" (`fs/tool-fs-search/src/grep.ts:275-282`); `goal` composes its blocked-threshold text from config (`goal/tool-goal/src/index.ts:115-123`); `jobs` documents the whole job lifecycle (`jobs/tool-jobs/src/index.ts:250-254`). DSH *does* use `examples` in its DSL (`schema.ts:14-16`) and uses `const` discriminants in output schemas (`workflow/tool-workflow/src/index.ts:382`). **[V]**

**Guidance-density comparison [I]:** For the *description channel*, Codex is denser and more prescriptive per tool. For the *whole prompt*, DSH wins on the two things that matter most: (a) guidance is emitted only when the tool is visible to the current scope, and (b) one section can govern a family of tools and be parameterised at runtime. Codex has no mechanism for either — its descriptions are compile-time constants inside `fn spec()`.

### 7.3 Concrete description-quality defects

| Defect | Where | Severity |
|---|---|---|
| DSH accepts unknown top-level args silently | `schema.ts:449-457` + `json-schema.ts:573-579` | **H** — a misspelled `file_path` on `read` becomes a no-op read of nothing rather than a loud error |
| DSH `update_goal` description is "Update the current goal." while its behaviour is heavily constrained | `goal/tool-goal/src/index.ts:235` vs `:115-123` | M — the constraints are one prompt section away; a model that greps only the tool block misses them |
| `ask_user_question` option objects are `additionalProperties: true` | `interaction/tool-ask-user/src/index.ts:48,61` | L |
| Codex `strict: false` everywhere with an unimplemented-mode TODO | `tools/src/responses_api.rs:35-38` | M |
| Codex has no schema `examples` anywhere | all spec sites | L |
| Codex `test_sync_tool` ships a description but is an internal test hook | `test_sync_spec.rs:59-60` | L (gated on model `experimental_supported_tools`) |
| Codex `Feature::WorkspaceDependencies` is default-true but registers nothing | `features/src/lib.rs:1680-1682` | M — dead wiring that reads as a shipped capability |
| DSH `str_replace_editor`, `lsp`, `terminal_*`, `session_*` are fully implemented but in no bundle | `packages/bundle/*/package.json` | M |

---

## 8. Tool count, context cost, and lazy loading

### 8.1 Always-loaded counts

| | DSH (`base`) | Codex (default features) |
|---|---|---|
| Direct tools | **26** **[V]** | **16** **[I]** (enumeration VERIFIED per-row) |
| Conditional direct tools | +1 plan mode, +3 MCP resources, +`bash`-variant | +`tool_search`, +hosted `web_search`, +MCP tools, +clock/sleep, +plugin tools, +`exec`/`wait` in code mode |
| Non-direct | none | `Deferred`, `DeferredModelOnly`, `CodeModeOnly`, `Hidden` (`tool_executor.rs:51-80`) |
| Namespaced groups | none | `clock`, `skills`, `memories`, `image_gen`, `web`, `history`, `notes`, `multi_agent_v1` |
| Richest descriptions | `workflow` ~1700, `plugin_manager` 695, `bash` 738 | `update_goal` 1362, `tool_search` ~400 + source list, `exec` (long JS API doc) |

Rough per-turn tool-block cost (description + schema, excluding the system prompt) **[I]**: DSH ≈ 8–10 KB of JSON; Codex ≈ 6–9 KB, but with much wider tails — `tool_search`'s source listing is capped at **512 KiB** (`handlers/tool_search_spec.rs:8`), and `exec` re-prints every nested tool's name, signature and description into one description string (`tools/src/code_mode.rs:75-99` prepends the namespace description to each nested definition, then `augment_tool_definition` adds code-mode samples).

### 8.2 Codex's lazy loading — the mechanism in detail

1. **Registration with deferred exposure.** An executor's `exposure()` returning `ToolExposure::Deferred` (`tool_executor.rs:58-62`) keeps it out of `build_model_visible_specs`, which filters on `exposure.is_direct()` (`spec_plan.rs:544-546`). **[V]**
2. **Search metadata.** `ToolExecutor::search_info()` defaults to deriving text from the spec (`tool_executor.rs:117-119`); `default_tool_search_text` concatenates the name, the underscored name, the description, and **recursively every property name and description in the schema** (`tools/src/tool_search.rs:86-131`). **[V]**
3. **The search tool is added only when it can find something.** `finalize_tool_router` requires at least one entry with `exposure.is_deferred() && runtime.search_info().is_some()` (`spec_plan.rs:361-366`). **[V]**
4. **Two-phase call flow.** `tool_search` returns `LoadableToolSpec`s with `defer_loading = Some(true)` for the *next* model call (`tool_search.rs:36-45`); the handler exposes them for the following request (`handlers/tool_search.rs:233-248`). Matching is BM25 (`handlers/tool_search.rs:11-13`). **[V]**
5. **Who actually defers today:** MCP tools when `search_tool_enabled` (`core/src/mcp_tool_exposure.rs:88-92`), agent-plugin MCP tools (`core/src/tools/handlers/tool_search.rs:323-345`), dynamic tools that ask for it (`tools/src/dynamic_tool.rs:13`), and the v1 collab set when search is enabled (`spec_plan.rs:1336-1352`). **[V]** So Codex's deferral is real but concentrated on MCP/dynamic tools, not on built-ins.
6. **Namespaces instead of a flat list.** Where the provider supports it, specs are grouped into `ResponsesApiNamespace`s (`spec_plan.rs:922-974`) and only flattened on providers that can't represent them (`tool_spec.rs:82-107`). For Responses Lite the registry additionally emits per-turn `TurnToolNamespacesInfo` metadata listing each namespace/function with `direct`, `deferred`, `code_mode_name` and `source: Harness|Mcp` flags (`tool_namespaces_info.rs:18-111`, gated at `spec_plan.rs:406-409`). **[V]**
7. **`DeferredToolWorldState`** (`features/src/lib.rs`, default false) switches the `tool_search` description from listing sources to `ToolSearchSourceListing::Omit` (`handlers/tool_search_spec.rs:34-91`) — i.e. the model learns available sources from world state instead of from the tool description. **[V]**

### 8.3 Code mode (Codex) vs PTC mode (DSH)

| | DSH PTC | Codex code mode |
|---|---|---|
| Entry tool | `run_code` (`core/tools/src/ptc.ts:336`), language-aware TS/Python SDK | `exec` (`code_mode/execute_spec.rs:26`), **FREEFORM** JS with a Lark grammar and `// @exec:` pragma |
| Continuation | none — "state is fresh per run" (`packages/core/tools/README.md`) | `wait` tool with `cell_id`, `yield_time_ms`, `max_tokens`, `terminate` (`code_mode/wait_spec.rs:9-30`) |
| Collapse mode | `mode: 'ptc'` emits **only** `run_code` (`core/tools/src/index.ts:1022-1027`); `mode: 'both'` emits everything + `run_code` | `ToolMode::{CodeMode, CodeModeOnly}`; `CodeModeOnly` restricts model-visible tools to `exec`/`wait` (`features/src/lib.rs:122-123`) |
| Nested-tool descriptions | SDK surface section + collapse section in the prompt (`core/tools/src/index.ts:996-999`) | `augment_tool_spec_for_code_mode` rewrites each nested tool's description with code-mode samples (`tools/src/code_mode.rs:8-65`) |
| Names in code | `codex_code_mode::normalize_code_mode_identifier` / `code_mode_name_for_tool_name` → `namespace__tool` (`tools/src/code_mode.rs:180-192`) | same, plus `is_code_mode_nested_tool` gating (`tools/src/code_mode.rs:71,93`) |
| Default on? | config `mode` (`tools.presentAs()`), native by default | `Feature::CodeMode` default **false**, `CodeModeOnly` default **false** |

**Verdict:** functionally comparable, and DSH's version is arguably ahead on ergonomics (a typed SDK with a language renderer table, plus a `both` mode). Codex is ahead on the *await/terminate* cell model and on rewriting nested descriptions into the entry tool's description. **[V]**

### 8.4 DSH's dynamic-availability mechanism (the honest counterweight)

DSH has no `tool_search`, but it does have two dynamic-availability mechanisms:

1. **Mid-session add/remove.** The agent loop diffs the request header's tool names against the previous one and appends a `developer/message` containing `tool-addition` / `tool-removal` blocks (`packages/core/agent-loop/src/agent.ts:633-648`); `projectToolUpdates` then marks historically-declared additions `deferLoading: true` so the provider knows to activate them at the recorded position (`packages/llm/llm/src/content.ts:384-395`, `:452`). **[V]** This is how a late-appearing subagent provider or a late MCP connection enters the surface without re-sending every schema.
2. **Per-scope restrictions.** `ctx.tools.restrict({allow, deny})` narrows the visible set for one agent scope (`core/tools/src/index.ts:1097-1125`), and subagent composition applies a `toolFilter` in the child's creation window (`packages/subagent/subagent/src/types.ts:188`, `packages/subagent/subagent/src/child-agent.ts:218`). **[V]** Combined with the lazy `text: ({scope}) => …` prompt sections, a child agent's tool surface and its guidance shrink together.

**The gap is discovery, not availability.** DSH can hide tools and can add them, but the *model* has no way to ask "what else can you do?" Codex does. **[V]**

---

## 9. Prioritized recommendations

Impact/effort: H/M/L. "Touch" = exact files.

### R1 — Close the DSH parameter root (`additionalProperties: false` by default, with an explicit opt-out)
**Impact H · Effort M**
Silent acceptance of misspelled top-level arguments is the highest-value correctness bug in the DSH surface: a bad `file_path` looks like a successful no-op instead of an error. Emit `additionalProperties: false` on the compiled parameter root and keep an `openRoot?: true` escape hatch for the few tools that genuinely need it (e.g. `workflow`'s `args`, `cordis_inspect_query.input`).
Touch: `packages/core/tools/src/schema.ts` (`parameterSchemaSpecToJsonSchema`, ~line 449), `packages/core/tools/src/json-schema.ts` (root closure enforcement), plus opt-outs in `packages/workflow/tool-workflow/src/index.ts`, `packages/extensions/tool-cordis/src/index.ts`. Expect test churn in `packages/core/tools/tests/*`.

### R2 — Add a model-facing tool-discovery tool (DSH's missing `tool_search`)
**Impact H · Effort H**
DSH already has every ingredient: `deferLoading` in `ToolSchema` (`packages/llm/llm/src/types.ts:479`), provider support in the DeepSeek adapter (`packages/llm/llm-deepseek/src/serialize.ts:164`), and mid-session addition plumbing (`packages/core/agent-loop/src/agent.ts:633-648`). Add (a) a `searchInfo`/`discoverable` metadata channel on `ToolDefinition`, (b) a `tool_search` tool that ranks over that metadata and registers the winners as additions, (c) opt-in deferral for MCP-bridged tools.
Touch: `packages/core/tools/src/index.ts` (`ToolDefinition`, `schemaOf`, `schemas`), new `packages/core/tool-search/*`, `packages/mcp/mcp-client/src/tools.ts` (mark bridged tools deferrable), `packages/bundle/base/package.json`.

### R3 — Put DSH's MCP tool bridge in a shipped bundle, with byte budgets
**Impact H · Effort M**
`@deepseek-ai/dsh-mcp-client` is not in any bundle, so the default profile has MCP *resources* but no MCP *tools*. Codex ships this in the default binary and defends the context budget (1000-byte descriptions, 8 KB schema collapse, 8 KB/64 KB totals).
Touch: `packages/bundle/base/package.json`, `packages/bundle/web-app/package.json`, `packages/mcp/mcp-client/src/tools.ts` (add `MAX_DESCRIPTION_BYTES` / `MAX_SCHEMA_BYTES` guards mirroring Codex's).

### R4 — Even out the collab verb set (add `wait_agent` and `close_agent` semantics)
**Impact M · Effort M**
DSH has `list_agents` but no blocking wait and no explicit close, so a parent must poll and cannot free a concurrency slot. Codex's model is observable in `multi_agents_spec.rs:269-324`.
Touch: `packages/subagent/tool-subagent-control/src/index.ts` (new `wait_agent`), `packages/subagent/tool-subagent-control/src/list-agents.ts`, `packages/subagent/subagent/src/*` (close/limit accounting).

### R5 — Move `update_goal`'s normative text next to the tool, or shorten the gap
**Impact M · Effort L**
DSH's `update_goal` description is 24 chars while its real contract is ~700 chars in a prompt section. Either fold a condensed contract into the description or make the section name explicit in the description ("see the goal policy in your instructions").
Touch: `packages/goal/tool-goal/src/index.ts:235` and `:115-123`.

### R6 — Fix nesting-induced tool death: split `tool:update_goal` guidance into a prompt section that is *validated* against tool visibility
**Impact M · Effort L**
The `tool:*` sections are conditional, but three of them (`tool:jobs`, `tool:goal`, `tool:ralph`) are unconditional (`jobs/tool-jobs/src/index.ts:250`, `goal/tool-goal/src/index.ts:190`, `workflow/tool-ralph/src/index.ts:405`). Make them scope-guarded like `tool:read`/`tool:grep` so a restricted agent doesn't pay for absent tools.
Touch: `packages/jobs/tool-jobs/src/index.ts`, `packages/goal/tool-goal/src/index.ts`, `packages/workflow/tool-ralph/src/index.ts`.

### R7 — Ship or delete the orphaned DSH tool packages
**Impact M · Effort L**
`tool-terminal`, `tool-lsp`, `tool-str-replace-editor`, `tool-session-query`, `tool-agent-team`, `schedule` are implemented, tested, and in no bundle. Either add them to `packages/bundle/{base,web-app}` or mark them explicitly as unsupported in `packages/*/README.md`.
Touch: `packages/bundle/base/package.json`, `packages/bundle/web-app/package.json`, `packages/terminal/tool-terminal/README.md`, `packages/lsp/tool-lsp/README.md`.

### R8 — Add `examples` and `title` to the highest-traffic DSH tool schemas
**Impact L · Effort L**
The DSL supports both (`packages/core/tools/src/schema.ts:14-16`) and almost nothing uses them. `bash.command`, `grep.pattern`, `glob.pattern`, and `edit.old_string` are the four parameters where a concrete example measurably helps.
Touch: `packages/shell/tool-bash/src/index.ts:377`, `packages/fs/tool-fs-search/src/grep.ts`, `packages/fs/tool-fs-search/src/glob.ts`, `packages/fs/tool-fs/src/edit.ts`.

### R9 — (Codex-side, reported for completeness) Either enforce `strict` or remove it
**Impact M · Effort H**
`strict: false` on every shipped tool with an unresolved TODO (`tools/src/responses_api.rs:35-38`) means the field is decorative while `additionalProperties: false` does the real work.
Touch: `codex-rs/tools/src/responses_api.rs`, every `create_*_tool` in `codex-rs/core/src/tools/handlers/*_spec.rs` and `codex-rs/ext/*/src/*spec*.rs`.

### R10 — (Codex-side) Wire or remove `Feature::WorkspaceDependencies`
**Impact L · Effort L**
`default_enabled: true` (`features/src/lib.rs:1680-1682`) with zero registered tools is a capability that reads as shipped and isn't.
Touch: `codex-rs/features/src/lib.rs:1680`, plus whichever `ext/` crate was meant to register it.

---

## 10. Summary judgement

- **DSH is broader on file/system work.** Five dedicated file tools + PTY + jobs + LSP + session query + deliverables + workflow/ralph + plan-mode exit have no Codex counterpart at all.
- **Codex is broader on integration and orchestration plumbing.** Namespaces, deferred tool discovery (`tool_search` + BM25), freeform grammar tools, `apply_patch`, image generation, memory tools, clock, context-budget tools, multi-environment routing, and a shippable MCP tool bridge.
- **Codex validates inputs harder; DSH validates outputs harder.** Only DSH makes an output schema mandatory, and only Codex closes the parameter root by default.
- **The single largest capability gap in either direction is DSH's lack of a tool-discovery path.** DSH hides tools but cannot advertise them; Codex can do both. DSH has the `deferLoading` primitive and provider support already — it is missing the search surface, not the substrate.
- **DSH's prompt-section architecture is the more scalable guidance design** and should be preserved and extended (scope-guard the three unconditional sections), not replaced by Codex-style inline essays.
