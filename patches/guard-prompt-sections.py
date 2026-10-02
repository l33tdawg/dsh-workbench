#!/usr/bin/env python3
"""Scope-guard the nine unguarded tool prompt sections.

Each section is registered by the same plugin that registers its tool, so at
registration time the tool is always present. `tools.restrict` can remove it
from a scope afterwards, and the section then still renders: an agent is told to
call a tool it does not have. The guard reads the live registry at render time,
which is what the seven already-guarded sections do.
"""
import pathlib
import sys

EDITS = [
    # (file, tool names, old text expression, new text expression)
    (
        'packages/shell/tool-bash/src/index.ts',
        ['bash'],
        "    text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',",
        "    text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',",
    ),
    (
        'packages/shell/tool-pwsh/src/index.ts',
        ['pwsh'],
        "    text: 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. '\n"
        "      + 'On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.',",
        "    text: 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. '\n"
        "      + 'On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.',",
    ),
    (
        'packages/terminal/tool-terminal/src/index.ts',
        ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list'],
        "    text: 'Use a terminal session only when work needs persistent terminal state or interactive stdin; prefer shell/read/write/edit for bounded one-shot operations. Track every terminal session id and close sessions that no longer matter. An inferred_idle or timeout result does not prove the foreground command exited.',",
        "    text: 'Use a terminal session only when work needs persistent terminal state or interactive stdin; prefer shell/read/write/edit for bounded one-shot operations. Track every terminal session id and close sessions that no longer matter. An inferred_idle or timeout result does not prove the foreground command exited.',",
    ),
    (
        'packages/goal/tool-goal/src/index.ts',
        ['get_goal', 'create_goal', 'update_goal'],
        "    text: guidance(resolved.blockedAfterConsecutiveRounds),",
        "    text: guidance(resolved.blockedAfterConsecutiveRounds),",
    ),
    (
        'packages/jobs/tool-jobs/src/index.ts',
        ['job_output', 'job_list', 'job_kill'],
        "    text: 'Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job\\'s work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.',",
        "    text: 'Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job\\'s work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.',",
    ),
    (
        'packages/lsp/tool-lsp/src/index.ts',
        ['lsp'],
        "    text: LSP_PROMPT_TEXT,",
        "    text: LSP_PROMPT_TEXT,",
    ),
    (
        'packages/session-query/tool-session-query/src/index.ts',
        ['session_search', 'session_event_search', 'session_trace', 'session_event_trace'],
        "    text: PROMPT_TEXT,",
        "    text: PROMPT_TEXT,",
    ),
    (
        'packages/workflow/tool-ralph/src/index.ts',
        ['ralph'],
        "    text: 'Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory. Completion and blockers are worker reports, not independent evaluation. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.',",
        "    text: 'Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory. Completion and blockers are worker reports, not independent evaluation. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.',",
    ),
    (
        'packages/workflow/tool-workflow/src/index.ts',
        ['${toolName}'],
        "    text: `Use the ${toolName} tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.`,",
        "    text: `Use the ${toolName} tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.`,",
    ),
]


def guard(names, expression):
    """Wrap a text expression in a live-registry scope check.

    The source property ends with a trailing comma, which belongs after the
    whole conditional. Leaving it on the expression puts it inside the ternary
    and the file stops parsing.
    """
    value = expression.strip()[len('text: '):].rstrip()
    if value.endswith(','):
        value = value[:-1].rstrip()

    if names == ['${toolName}']:
        return (
            "    text: ({ scope }) => ctx.tools.get(toolName, scope) === undefined\n"
            "      ? ''\n"
            f"      : {value},"
        )
    if len(names) == 1:
        return (
            f"    text: ({{ scope }}) => ctx.tools.get('{names[0]}', scope) === undefined\n"
            "      ? ''\n"
            f"      : {value},"
        )
    listed = ', '.join(f"'{name}'" for name in names)
    return (
        f"    text: ({{ scope }}) => [{listed}].some((name) => ctx.tools.get(name, scope) !== undefined)\n"
        f"      ? {value}\n"
        "      : '',"
    )


changed = 0
for path, names, old, _new in EDITS:
    p = pathlib.Path(path)
    text = p.read_text()
    if old not in text:
        print(f'MISS  {path}')
        continue
    text = text.replace(old, guard(names, old), 1)
    p.write_text(text)
    changed += 1
    print(f'ok    {path}  -> {", ".join(names)}')

print(f'\n{changed} of {len(EDITS)} sections guarded')
sys.exit(0 if changed == len(EDITS) else 1)
