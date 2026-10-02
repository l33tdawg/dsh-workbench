# `isConcurrencySafe` is unset on the shell tools, so bash batches run serially

**Severity:** low, and I want to be upfront that the measured impact is small. Filed because the fix is one predicate per tool and the primitive already exists.

## What happens

Independent tool calls in one assistant message run concurrently only when a tool opts in, and the predicate fails closed: `isConcurrencySafe(args)` must return exactly `true` (`packages/core/tools/src/index.ts:1303-1313`).

Opted in: `read`, `read-image`, web search, web fetch, the session-query tools, `subagent`, `tool-cordis`.

Not opted in: `bash`, `bash-persistent`, `pwsh`, `write`, `edit`, every MCP-bridged tool, `run_code`.

The scheduler takes one call at a time when the mode is not `parallel` (`packages/core/agent-loop/src/tool-calls.ts:85-100`), so a batch of shell calls pays the sum of their durations rather than the maximum.

## Measurement

Across 41 recorded sessions, pairing `tool/call` to `tool/result` by `callId` and comparing each step's wall span against the sum and the maximum of its individual durations:

```
sessions                          41
multi-call steps                1136   (809 containing bash)
ran serially                     611   (54%)
serial batches   : sum 279260.2s  span 279216.0s
parallel batches : sum  69169.5s  span  34592.8s
recoverable if parallelised          193.5s
```

That is roughly five seconds per session. The distribution has a long tail, which is where the real cost sits:

```
span      longest   calls
104.1s     60.0s      2
 91.2s     60.0s      2
3780.3s  3755.2s      2
```

A batch of a test run, a build, and a status check pays the full sum. On average most commands finish fast, so the aggregate stays small, and I would rather give you that number than claim a large win.

## Suggested shape

An argument-aware classifier on the shell `defineTool` sites. Read-only commands are concurrency-safe; anything that mutates is not, so the predicate has to look at the command rather than the tool name.

`write` and `edit` want a path-scoped claim rather than a blanket `true`, so two edits to the same file in one batch cannot race. That is a larger change than the shell case and worth separating.

## Environment

- DSH `dsh-v0.2.0-rc.2`, commit `639ed0153`
- 41 session logs from `~/.dsh/sessions`
