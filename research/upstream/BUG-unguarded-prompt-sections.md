# Three prompt sections render for agents that do not have the tools they describe

**Severity:** low. It costs tokens and, worse, instructs an agent to call tools it was not given.

## What happens

`tool:jobs`, `tool:goal` and `tool:ralph` register prompt sections with static text, so they render for every agent regardless of which tools that agent actually has. Other tool plugins guard on scope, and the guard is one line.

## The guard that exists elsewhere

`packages/dsh-apply-patch` (and the shipped `todo` and `fs` plugins) do this:

```ts
text: ({ scope }) => ctx.tools.get(TOOL_NAME, scope) === undefined
  ? ''
  : 'Use apply_patch to make a coherent change ...',
```

## The three that do not

`packages/jobs/tool-jobs/src/index.ts`:

```ts
text: 'Track every background job id you start. ... collect every still-relevant job with job_output ... and job_kill jobs that stopped mattering.',
```

`packages/workflow/tool-ralph/src/index.ts`:

```ts
text: 'Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop ...',
```

`packages/goal/tool-goal/src/index.ts`:

```ts
text: guidance(resolved.blockedAfterConsecutiveRounds),
```

The goal one varies by config rather than scope, so it is unconditional in the same way.

## Why it matters

An agent without `job_kill` reads an instruction to call `job_kill`. It cannot tell whether the tool is missing, renamed, or withheld by policy, so the reasonable move is to try it and collect `unknown tool`. Every restricted agent pays for this in tokens and in one wasted call, and the text reads as authoritative because it comes from the system prompt.

## Suggested fix

Apply the same scope guard to all three. For `tool:goal`, keep the config-driven text and wrap it in the scope check.

## Environment

- DSH `dsh-v0.2.0-rc.2`, commit `639ed0153`
