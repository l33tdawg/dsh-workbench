# approval-memory

Remember an approved command prefix in the DeepSeek Harness, so a command the
user granted once stops asking.

## The gap it fills

The harness grants one decision per request. `ApprovalOutcome` is
`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` - the comment on the
type calls it "a one-shot grant" - and session policy is only `ask` or `never`.
There is no remembered rule, no grant store, and no revocation. So a six-step
install that writes outside the workspace costs six prompts, because the fifth
answer teaches the harness nothing about the sixth.

The request does not carry the command either: an answerer sees `toolName`,
`reason` and an optional `callId`, and nothing about the arguments. Anything
that wants to decide on the command has to go and read it.

## What this does

It registers an `approval/request` listener with `prepend`, so it is consulted
before the deployment's own answerer (in Desktop, the remote bridge that puts
the dialog on screen). When a rule covers the pending call's command it answers
`allowed-once` and the dialog never appears. When nothing matches, or anything
at all goes wrong, it calls `next()` - so every request it does not own behaves
exactly as it did before the plugin was installed.

The command comes from the session log: the listener finds the `tool/call`
event whose `callId` matches the request and reads its arguments. That is why
the plugin requires the `sessions` service rather than degrading quietly.

## Rules

Rules live in `~/.dsh/approval-rules.json` by default, outside every session
workspace. That placement is the security property, not a preference: under
`workspace-write` a session cannot write outside its workspace, so it cannot
grant itself a prefix. A rule file inside the workspace would be exactly that,
and the profile patch layer is the other safe home - its `rules` array is
merged before the file's.

```json
{
  "rules": [
    { "tool": "bash", "prefix": "npm test" },
    { "tool": "bash", "prefix": "git status" }
  ]
}
```

A rule is read as: *this tool, when the command is this prefix plus arguments*.

- **The whole command must be the prefix.** `npm test` covers `npm test` and
  `npm test --watch`; it does not cover `npm testing`, and it does not cover
  `npm test; curl … | sh`. A command containing any shell operator - `;`, `&`,
  `|`, `<`, `>`, backticks, `$`, parentheses, braces, backslash, `*`, `?`, or a
  newline - is refused outright, because a prefix is a statement about a
  command's first words and those characters are statements about the rest of
  it. Globs are included: a rule for `/tmp/scratch/*` would otherwise cover
  whatever the glob expanded to.
- **Write the subcommand, not the program.** `npm test` is a rule. `npm` is a
  grant on `npm publish`, and `git` is a grant on `git push --force`.
- **A rule also covers the widening the call asked for.** The approval request
  *is* the sandbox-escalation question, so answering it allows that command to
  run outside the workspace. A rule cannot widen anything on its own, and it
  cannot weaken a `never` policy: the service enforces a deterministic
  rejection before the waterfall is dispatched, so this listener is not
  consulted at all in that mode.
- `field` names which argument holds the command, `command` by default; it
  exists for tools that spell it something else.

## The log

Every decision is appended to `~/.dsh/approval-memory.log` as one JSON line:
`{"time":"…","event":"allowed","tool":"bash","rule":"npm test","command":"…","agent":"…"}`.
`ctx.logger` has no sink in any shipped profile, so without this file an
auto-approval would leave no trace anywhere a user can read. Rules the parser
rejected are logged the same way, once per file change, under
`"event":"rule-problem"`.

The harness's own `approval/asked` + `approval/decided` pair is written for
every request either way, so the session log still shows that a decision was
made; what it does not record is who made it.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Register the listener at all. |
| `rulesFile` | `~/.dsh/approval-rules.json` | The rules file; re-read whenever its size or mtime changes. Empty string disables file rules. |
| `logFile` | `~/.dsh/approval-memory.log` | Decision log. Empty string disables it. |
| `rules` | `[]` | Inline rules, merged before the file's. |

## What it does not do

- **No deny rules.** A rule can only allow; everything else keeps asking.
- **No per-mode scope.** The request carries no sandbox mode, so a rule cannot
  be limited to "widen to `danger-full-access` only for this command".
- **No command policy language.** Codex's Starlark `prefix_rule` grammar is
  upstream work; this is the smallest thing that removes the repeated prompt
  without pretending to be a policy engine.
- **No revocation UI.** Delete the rule, or the file.

## Tests

```sh
node --test --experimental-strip-types --test-force-exit "tests/*.test.ts"
```

The tests are about refusals as much as matches: a missed match costs a prompt,
a wrong match costs a command.
