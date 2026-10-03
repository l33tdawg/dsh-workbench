# dsh-workbench 

Register the MCP servers a **workspace** declares in `.mcp.json` with DeepSeek
Harness — through Harness's own `mcp-client`, not a reimplementation.

```jsonc
// <workspace>/.mcp.json — the same file Claude Code, Codex, and others read
{
  "mcpServers": {
    "sage": { "command": "/Applications/SAGE.app/Contents/MacOS/sage-gui", "args": ["mcp"] },
    "remote": { "url": "https://example.test/mcp", "headers": { "X-Key": "v" } }
  }
}
```

After a restart, that server's tools appear as `mcp__sage__*` in the session,
exactly as if the server had been configured in the loader configuration.

## Why these plugins exist

A coding agent does not see the filesystem. It sees tool results. These plugins
each close one moment where an agent can end a task without having established
that the work is real: an edit whose landing it never saw, a "done" that no check
gated, a counted claim asserted from memory, an approval question answered for
the tenth time in one session. Each package README explains its own loop; this
section explains the set.

That failure mode is why the repository exists, and it is not the same as
feature parity with another harness. The working premise is narrower: a mistake
is only fixable while the agent can still see it, so the mechanical loops are
worth closing first, ahead of anything that depends on the model behaving well.

The honest half is that closing a loop has not been shown to lower the mistake
rate. The undo-class rate did fall from 3.5 to 1.6 per 100 tool calls across the
install, but one session holds 30.1% of the events and the
[census](tools/README.md) says outright that a pooled rate one session dominates
is not evidence about the harness. Install these because the loops are worth
closing, not because that has been demonstrated to make the model better.

## What is in this repository

The root package is the workspace-mcp plugin, which is what the rest of this
file documents. The same checkout is where the rest of the work lives. Each
package below carries its own README; the directories name their entry point:

| Package | What it does |
| --- | --- |
| [`dsh-uplift`](packages/dsh-uplift) | One bundle that installs the reliability pack below. |
| [`dsh-guidance-pack`](packages/dsh-guidance-pack) | Behavioural prompt guidance: planning, verification, editing constraints, destructive actions, reporting. |
| [`dsh-apply-patch`](packages/dsh-apply-patch) | A multi-file atomic `apply_patch` — one call, many hunks, all or nothing. |
| [`dsh-edit-feedback`](packages/dsh-edit-feedback) | Returns the diff Harness already computes to the model, so it knows where its edit landed. |
| [`dsh-verify-on-edit`](packages/dsh-verify-on-edit) | Tracks file-tool edits through debounce, checks pending edits before completion, reports explicit outcomes and permits one corrective continuation per turn. |
| [`dsh-check-claims`](packages/dsh-check-claims) | Turns a countable claim into a command with an exact answer, against the working tree or a named revision. |
| [`dsh-compaction-todo`](packages/dsh-compaction-todo) | Restores saved task state after compaction without duplicate reminders; optionally adds `workflow_context` for the objective, constraints, decisions and remaining checks. |
| [`dsh-approval-memory`](packages/dsh-approval-memory) | Answers the approval waterfall from command-prefix rules, and for the rest of a session once a human has allowed one escalation of that kind. |

Three directories hold the rest:

- [`tools/`](tools/README.md) — session-log audits, the reliability census,
  request-budget checks and repair utilities. The README explains the reported
  measurements and their limits; individual scripts carry usage headers.
- [`patches/`](patches/) — six reports, one proposal and five comments filed
  against `deepseek-harness`, indexed in
  [`UPSTREAM-REPORTS.md`](patches/UPSTREAM-REPORTS.md), plus the appliers that
  carry local fixes and the corrections made after filing.
- [`research/`](research/SCORECARD.md) — the Codex comparison and the
  measurements behind the pack. The scorecard is the entry point.

## Reliability pack

Install [`dsh-uplift`](packages/dsh-uplift/README.md) to mount the guidance,
editing, verification, claim-checking and continuity plugins together. Its
profile patch enables `workflow_context`; standalone `dsh-compaction-todo`
installs leave that tool off unless `workflowContext: true` is configured.

Verification retains successful file-tool edits made inside the debounce window
and checks pending edits before a normal completion. Edits made through arbitrary
shell commands are outside that tracking. Outcomes distinguish a pass, a reported
failure, a timeout, an unavailable check, no configured check, unparsed failure
output and cancellation. Checks use the session's shell policy and respect
explicit current-turn requests to skip tests or checks. The completion guard
can request one corrective continuation per turn; it respects stop requests
and approval limits. Saved workflow notes are model-authored task state, not
permission to take additional actions.

The [regression cases and evaluation guide](research/RELIABILITY-EVAL.md)
document what is tested and how to compare coding-task outcomes. The local
`node tools/reliability-census.mjs --json` report reads session logs without
uploading transcripts. Missing verification records mean unknown coverage; the
baseline and passing plugin tests do not establish improved model quality, for
the attribution reason given [above](#why-these-plugins-exist).
After replacing installed plugin code, restart Harness to load the new modules.

## Why this exists

Harness reads MCP server configuration only from its own loader configuration
(`cordis.patch.yml` and profile patches). Its `mcp-client` package requires one
plugin instance per server, declared statically. So a project's `.mcp.json` —
the file that already tells every other agent tool which servers it needs — is
invisible to Harness, and every server has to be restated in Harness-specific
configuration. This plugin reads the file and mounts one `mcp-client` per
server, so the workspace file becomes the single place a project declares its
servers.

Upstream cannot take this as a patch: `deepseek-harness` states that it does not
accept external pull requests, and directs changes of this kind to the plugin
ecosystem. This is that plugin.

## A SAGE agent per workspace

### Reuse the running SAGE service

For a desktop host, use SAGE's existing HTTP MCP endpoint. This keeps the
project's approved identity and creates no long-lived `sage-gui mcp` children:

```yaml
- id: workspace-mcp
  config:
    files: ['.dsh/mcp.json']
    perAgent: true
    sage:
      url: http://127.0.0.1:8080/v1/mcp/streamable
      tokenDirectory: /absolute/private/path/dsh-sage-tokens
      tokenCommand: /Applications/SAGE.app/Contents/MacOS/sage-gui
      identities:
        /absolute/path/to/workspace: /absolute/path/to/existing/agent.key
```

The existing SAGE node must be healthy and the pinned identity must already be
approved and managed by that node. At the first mount of a session, the plugin
runs the short-lived `mcp-token create` CLI under the local operator's authority.
It caches that session's ordinary-agent bearer in a mode-0600 file under a
mode-0700 directory; later mounts and restarts reuse it. The MCP client receives
only that bearer, never the operator's signing key. Omit `tokenCommand` after
provisioning if this host should only use existing cached credentials.

Tokens are scoped by endpoint, workspace, identity and durable Harness session
ID. Separate sessions in one project get separate tokens because SAGE scopes
HTTP conversation state and durable work claims to the bearer. Keep the cache
across restarts. To rotate a token, revoke the file's `id` with
`sage-gui mcp-token revoke <id>`, then remove that private cache file before
remounting the session. Cache files contain credentials: never commit them.

HTTP mode takes precedence over a workspace's `sage` stdio declaration. Missing
credentials, an unmapped project or a failed connection is reported without
launching `mcp` or `serve`; other configured MCP servers still mount. A new
project requires an explicitly pinned, approved identity. Existing bridges from
older plugin versions are disposed when this mode mounts, and per-agent
clients now unload when the workspace-mcp plugin is reconfigured.

### Legacy stdio integration

Setting `sage: {}` on the plugin row mounts one
[SAGE](https://github.com/l33tdawg/sage) MCP server per workspace, so each
workspace signs as its own agent instead of sharing one brain across projects.

Identity is pinned explicitly with `SAGE_IDENTITY_PATH`, because that is the
only rule SAGE applies unconditionally (`cmd/sage-gui/mcp.go` resolves
`SAGE_IDENTITY_PATH`, then `SAGE_AGENT_KEY`, then a per-project key derived from
the working directory; `SAGE_PROJECT` is never consulted for identity).

The derived path is not reliable inside a GUI host — the Electron app reuses its
own working directory for spawned children, so a derived identity comes out
named after the *profile* and changes when the profile does. Pin the identity
for each workspace:

```yaml
- id: workspace-mcp
  config:
    sage:
      identities:
        /absolute/path/to/workspace: /absolute/path/to/agent.key
```

A workspace with no entry falls back to SAGE's own derivation, which works for
command-line hosts. Note the plugin still sets `cwd` to the workspace, because
that is the correct working directory for a per-workspace server even though
identity must not depend on it.

Consequences worth knowing:

- **A new workspace registers a new agent** the first time it is opened, and an
  operator must approve it once before it can read or write memories. That is
  the cost of per-workspace separation.
- If your deployment already has a SAGE server declared in the harness loader
  configuration, remove it: two servers claiming `serverName: sage` in one scope
  make `mcp-client` throw and abort the boot.
- Set `sage.serverName`, `sage.command`, `sage.args`, or `sage.env` to change the
  namespace, binary, arguments, or environment.

```yaml
- id: workspace-mcp
  config:
    sage: {}
```

## Install

```sh
# from the profile directory, or with the plugin manager's install action
pnpm add --dir "$DSH_HOME/profiles/web" /path/to/dsh-workspace-mcp
```

The harness's own plugin manager performs those steps too — the Plugins page in
Settings, or the `install_bundle` action an agent can call with this directory as
its target — and a newly installed bundle activates in a running app without a
restart. Replacing an already installed package still needs one, because the
module has to be imported afresh.

Then add the bundle to the profile manifest's ordered list:

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@l33tdawg/dsh-workspace-mcp"] } } }
```

Restart Harness. The included `cordis.patch.yml` inserts one `workspace-mcp`
row; override any of its config fields from the profile patch layer as usual.
Two things about doing that by hand: a manifest edit that leaves the ordered
`dsh.profile.bundles` list unchanged is ignored by a running app, and editing
the patch layer while an app runs recomposes the profile in place — see
[`patches/FINDING-profile-reload-boundary.md`](patches/FINDING-profile-reload-boundary.md)
for what that does and does not reach.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | `''` | Workspace to search. Empty means the Harness process working directory, which is the workspace the session was started in. |
| `files` | `['.mcp.json', '.dsh/mcp.json']` | Files to read, in order. On a shared server key, **later files win** and the loss is logged. |
| `allowEnv` | `false` | Whether files may resolve `${env:NAME}` references at all. |
| `env` | `{}` | Values `${env:NAME}` may resolve to, **only** consulted when `allowEnv` is true. |
| `envOverrides` | `{}` | Values forced onto every spawned server, overriding what the file declares. |
| `perAgent` | `false` | Mount once per live root agent, in that agent's scope, from the workspace its session recorded. |
| `sage` | unset | SAGE integration. `{}` mounts one SAGE server per workspace over stdio; `url` with `tokenDirectory` uses the running SAGE HTTP service instead. See [A SAGE agent per workspace](#a-sage-agent-per-workspace). |
| `clientModule` | unset | The `@deepseek-ai/dsh-mcp-client` namespace to mount. See below. |
| `verbose` | `false` | Log every file read and every server mounted. |
| `toolCallTimeoutMs` | `60000` | Timeout for one tool call or resource request. |

### Per-agent mounting

`perAgent: true` mounts the servers once per live root agent instead of once per
process, into that agent's own tool scope and from the workspace its session
recorded. A process-wide mount cannot be correct in a GUI host: there the Harness
process working directory is the *profile* directory, not the session workspace,
so every workspace resolves the same files and — for SAGE — derives the same
profile-named agent. With this mode the workspace's own `.mcp.json` is read, and
every child runs with that workspace as its `cwd`, which is what SAGE derives an
agent identity from.

### Substitutions

`${workspaceFolder}` and `${workspaceRoot}` resolve to `root`; `${cwd}` resolves
to the entry's own `cwd` once set, otherwise `root`. A whole-value
`${env:NAME}` resolves to `env[NAME]`.

## Security

**A `.mcp.json` declares commands, and this plugin runs them.** Cloning a
repository and opening it in Harness therefore executes whatever that
repository's `.mcp.json` names, as your user. That is inherent to reading
server definitions from a workspace file — the same property that makes the file
convenient. Nothing here sandboxes it.

Two specific decisions follow from that, and both are deliberate:

- **`${env:NAME}` is refused unless an operator opts in.** By default a cloned
  repository cannot read the Harness process environment through its
  `.mcp.json`. Enable `allowEnv` and name values under `env` only for
  workspaces you trust; a whole-value reference is required, so a file cannot
  compose a secret into a longer string such as `--token=${env:TOKEN}`.
- **Remove `.mcp.json` from version control when a repository should not carry
  one.** The plugin ships enabled and reads the conventional filenames, so the
  only reliable opt-out for an untrusted tree is for that tree not to contain
  the file — or to set `files: []` on the profile's `workspace-mcp` row.

## `clientModule`

The plugin must mount *the same* `mcp-client` the running Harness uses. A second
installation would keep its own tool registry, register nothing observable, and
look like an empty workspace. The plugin first tries
`import('@deepseek-ai/dsh-mcp-client')`, which resolves through the running
installation's dependency graph. If that fails or the wrong copy is picked up,
pin it explicitly on the loader row:

```yaml
- id: workspace-mcp
  config:
    clientModule: {!!js ctx.loader.import('@deepseek-ai/dsh-mcp-client')}
```

## Behavior and failure

- A missing file is silent: most workspaces declare nothing.
- Invalid JSON, a non-object document, a `mcpServers` member that is not an
  object, or an entry with neither `command` nor `url` is reported as an error
  and skipped. The rest of the file still loads.
- A server key must match `[A-Za-z0-9_-]{1,32}`, because `mcp-client` uses it
  as the tool namespace (`mcp__<serverName>__<tool>`).
- An entry with `"disabled": true` is skipped, as other clients do.
- `"type": "sse"` is refused: the HTTP+SSE transport is retired. Point the entry
  at a Streamable HTTP endpoint or use stdio.
- One server failing to connect does not fail the others: each is mounted
  separately with `failOnStartupError: false`, so a dead server is logged and
  retried by `mcp-client`'s own reconnect policy rather than blocking startup.
- Servers live and die with the plugin's fiber, so Harness unloads them
  normally.

## Development

```sh
npm install          # dev dependencies only
npm test             # workspace-mcp and session-log tool tests
npm run typecheck    # parse every package and tool the profile loads directly
```

Each package under `packages/` has its own test command. The
[uplift README](packages/dsh-uplift/README.md#tests) lists the bundle's suites;
the [evaluation guide](research/RELIABILITY-EVAL.md#fixed-regression-scenarios)
gives the focused verification, completion and continuity checks.

`tests/integration.test.ts` bootstraps the real tool registry and the real
`mcp-client`, writes a `.mcp.json`, and asserts the fixture's tool lands in the
registry — the tests exercise the actual client rather than a stand-in.

## Verification against the real harness

Beyond the tests above, the plugin was verified on 1 October 2026 against the
published harness, driven with an isolated `DSH_HOME` so no user profile was
touched. The profile was a hand-written copy of the shipped `headless` template
with `@deepseek-ai/dsh` (0.2.0-rc.2) installed into that home and this package
linked into the profile's `node_modules` the way a profile install links it.
What that established, and how:

| Claim | Evidence |
| --- | --- |
| The loader resolves this package from a profile and composes its row | `dsh --profile <p> --dump-config` prints the `workspace-mcp` row with the shipped config, under `# == @l33tdawg/dsh-workspace-mcp` |
| The entry loads as TypeScript through the harness loader | the same import succeeds from a profile directory under plain Node 22 type stripping, so no build step is needed |
| `apply` runs inside a real harness process, in the workspace directory | temporary instrumentation in `apply` recorded `cwd=<workspace> root=""` during a headless boot |
| The plugin's own `@deepseek-ai/*` imports resolve from a bare symlink profile | entry, `schemastery`, and `dsh-mcp-client` all import successfully from a profile containing only the symlink; the harness's runtime resolution supplies the rest |
| The workspace file is found and parsed | the same instrumentation recorded `.mcp.json exists=true`, and a deliberately malformed file produced the plugin's own `invalid JSON` diagnostic |
| A declared server is mounted and its tool registered | booting the real `ToolRuntime` and the real `mcp-client` against a workspace `.mcp.json` registered `mcp__echo__echo` |

To repeat it, in a scratch directory:

```sh
export DSH_HOME=/tmp/dsh-check
mkdir -p "$DSH_HOME/profiles/check/node_modules/@l33tdawg"
cd "$DSH_HOME" && npm install @deepseek-ai/dsh
# copy the shipped headless template into profiles/check, then:
printf '%s' '[]' > "$DSH_HOME/profiles/check/cordis.yml"
ln -s /path/to/dsh-workspace-mcp "$DSH_HOME/profiles/check/node_modules/@l33tdawg/dsh-workspace-mcp"
# add "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless" and this package to
# that profile's package.json dsh.profile.bundles, then, from a workspace that
# has a .mcp.json:
"$DSH_HOME/node_modules/.bin/dsh" --profile check --dump-config   # composes the row
"$DSH_HOME/node_modules/.bin/dsh" --profile check "any task"      # boots it
```

Two notes for anyone repeating this. `root` defaults to the harness process
working directory, which for a profile boot is the workspace the session was
started in — verified rather than assumed, and the reason `files: ['.mcp.json']`
finds the workspace file and not the profile's own directory. And the plugin's
diagnostics go to the harness logger: a failed mount appears in the harness's
logs, not on stdout.
