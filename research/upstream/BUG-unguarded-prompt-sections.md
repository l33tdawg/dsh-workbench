# Ten tool prompt sections render for agents that do not have the tools they describe

**Severity:** low. It costs tokens and, worse, instructs an agent to call tools it was not given.

## What happens

Shipped source under `packages/**/src` registers 30 `systemPrompt.section` calls. Eight guard on scope, so they disappear for an agent whose tool set excludes them. Of the 22 that do not, ten are tool sections.

## The guard

`packages/fs/tool-fs/src/read.ts` and seven others:

```ts
text: ({ scope }) => ctx.tools.get('read', scope) === undefined
  ? ''
  : '...',
```

**Guarded (8):** `tool:edit`, `tool:read`, `tool:write`, `tool:glob`, `tool:grep`, `tool:web_fetch`, `tool:web_search`, `mcp-resource-servers`.

## The ten that are not

| Section | File |
|---|---|
| `tool:bash` | `packages/shell/tool-bash/src/index.ts` |
| `tool:pwsh` | `packages/shell/tool-pwsh/src/index.ts` |
| `tool:pty` | `packages/terminal/tool-terminal/src/index.ts` |
| `tool:goal` | `packages/goal/tool-goal/src/index.ts` |
| `tool:jobs` | `packages/jobs/tool-jobs/src/index.ts` |
| `tool:lsp` | `packages/lsp/tool-lsp/src/index.ts` |
| `tool:session-query` | `packages/session-query/tool-session-query/src/index.ts` |
| `tool:ralph` | `packages/workflow/tool-ralph/src/index.ts` |
| `tool:${toolName}` | `packages/workflow/tool-workflow/src/index.ts` |
| `tool:${STRUCTURED_OUTPUT_TOOL}` | `packages/subagent/subagent-in-process-driver/src/structured.ts` |

Shapes vary, but all are unconditional:

```ts
// jobs
text: 'Track every background job id you start. ... and job_kill jobs that stopped mattering.',

// lsp
text: LSP_PROMPT_TEXT,

// workflow
text: `Use the ${toolName} tool ONLY when the user explicitly asks for a workflow ...`,

// goal
text: guidance(resolved.blockedAfterConsecutiveRounds),
```

The goal one varies by config rather than by scope, so it is unconditional in the same way.

## Why it matters

`tools.restrict(filter)` exists and requires a scoped context
(`packages/core/tools/src/index.ts:1097`), so withholding a tool from one agent is a supported,
shipped operation. An agent on the receiving end of that still reads guidance telling it to call the
tool.

Take `tool:jobs`: an agent without `job_kill` is told to call `job_kill`. It cannot tell whether the
tool is missing, renamed, or withheld by policy, so the reasonable move is to try it and collect
`unknown tool`. That is a wasted call, and the instruction reads as authoritative because it arrives
in the system prompt.

The cost is bounded and small. The inconsistency is the real complaint: eight sections do this
correctly and ten do not, so the behaviour depends on which plugin author wrote the section.

## Correcting an earlier revision of this report

An earlier version said 21 registrations, 16 tool sections, seven guarded and nine unguarded. Those
counts came from a search for `ctx.systemPrompt.section({` and silently missed every registration
made through a different receiver. Nine use another name:

```
promptCtx  scope  inner  scoped  childCtx  runtimeCtx
```

Searching for any identifier gives 30 rather than 21, and the unguarded tool sections number ten
rather than nine. The figure was wrong in the direction that made the defect look smaller, which is
the direction a hand search fails in.

## Suggested fix

Adopt the `ctx.tools.get(name, scope) === undefined ? '' : …` pattern in the ten. For `tool:goal`,
keep the config-driven text and wrap it in the scope check.

## Environment

- DSH `dsh-v0.2.0-rc.2`, commit `639ed0153`
- Counted over shipped source, excluding tests and specs
