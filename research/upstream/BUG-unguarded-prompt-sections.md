# Nine tool prompt sections render for agents that do not have the tools they describe

**Severity:** low. It costs tokens and, worse, instructs an agent to call tools it was not given.

## What happens

Of the 21 `ctx.systemPrompt.section` registrations in `packages/`, 16 are tool sections. Seven guard on scope, so they disappear for an agent whose tool set excludes them. Nine do not, so they render for every agent.

## The guard

`packages/fs/tool-fs/src/read.ts` and six others:

```ts
text: ({ scope }) => ctx.tools.get('read', scope) === undefined
  ? ''
  : '...',
```

**Guarded (7):** `tool:edit`, `tool:glob`, `tool:grep`, `tool:read`, `tool:web_fetch`, `tool:web_search`, `tool:write`.

## The nine that are not

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
| `tool:workflow` | `packages/workflow/tool-workflow/src/index.ts` |

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

The cost is bounded and small. The inconsistency is the real complaint: seven sections do this
correctly and nine do not, so the behaviour depends on which plugin author wrote the section.

## Suggested fix

Adopt the `ctx.tools.get(name, scope) === undefined ? '' : …` pattern in the nine. For `tool:goal`,
keep the config-driven text and wrap it in the scope check.

## Environment

- DSH `dsh-v0.2.0-rc.2`, commit `639ed0153`
- Counted by parsing every `ctx.systemPrompt.section({...})` object literal under `packages/`
