# Changelog

What each release changed, and what was measured before it shipped.

**This file is the source for the annotated tag message, not a copy of it.**
Write the entry here, then tag with the matching slice of it. The release
markers sit outside the text a reader sees, so the section renders as an
ordinary changelog entry while the extraction takes the tag body verbatim,
including any trailing blank line:

```sh
awk '/^<!-- release:0\.5\.0 -->$/{f=1;next} /^<!-- \/release:0\.5\.0 -->$/{f=0} f' CHANGELOG.md > /tmp/notes.md
git tag -a v0.5.0 -F /tmp/notes.md
```

Keeping the notes here is what makes a release's reasoning readable from a
clone: notes that exist only inside a tag are invisible from the working tree.

Each section follows the repository's habit: what changed, then the evidence.
A claim without a measurement says so.

## [Unreleased]

Nothing yet, beyond one note that arrived after 0.4.0 was tagged and so is
recorded forward rather than written back into a published entry.

`dsh-recall-gate` is a new bundle, it is not part of `dsh-uplift`, and it refuses
every write in a session that has no recall tool to call — a profile without one
should mount it with `enabled: false`.

## [0.4.0] - 2026-10-10

<!-- release:0.4.0 -->
0.4.0: a recall gate, Python detection that finds the suite, and the counts that were not counts

Two of these close defects reported by another agent against this harness, with
the reproduction each one carried. One is a new plugin. Everything below was
measured on the reporting tree rather than on a fixture.

`dsh-recall-gate` denies the first file-mutating tool call of a turn until that
turn has recalled its memory. It exists because an agent edited a git worktree
five times before calling `sage_turn`, and the recall that finally ran named a
different concurrent session as the owner of source edits to that same worktree.
Nothing about `edit src/app.py` reveals that, so the only available signal is
ordering, and an instruction to recall is not a gate. The policy is a
`tools/pre-execute` decision because that is the only seam that can stop a call:
`PreToolDecision` offers allow, deny, cancel and ask, while input rewriting is
excluded there because arguments are already logged and presented, and
`tools/execute` may change only `exec.signal`.

`verify-on-edit` reported "no project check is configured or detected" for a
worktree holding 704 passing tests. Detection had no reachable Python branch at
all: it read six configuration files and that tree has none of them. It now
recognises a test suite and a pinned linter, and it names every path it searched
so that "no check exists" can be told apart from "I failed to find the check".
Three findings underneath that are worth more than the fix. A `git worktree`
usually has no environment of its own, so the interpreter is borrowed from an
ancestor that shares declaration files with the workspace and only within three
levels, because an unrelated `/tmp/.venv` was being adopted as the project's. A
linter can be declared without any config file: a requirements pin and a CI job
that lints changed files is a real declaration, and requiring `[tool.ruff]` would
report no check for a repository whose pull requests fail on lint. And scope has
to follow whatever declared it, because a bare pin states the tool and the rules
but not a scope, so that run covers the edited files instead of a tree that was
never fully linted.

`check_claims` now says what it cannot do. It scans paths and git revisions, so
a count that exists only in a tool response is outside its reach; the description
invited the mistake by saying "check countable claims against the source" without
naming that boundary, and a workspace scan looks like a legitimate way to check
"8 open tasks".

The guidance pack's review block now says that a request naming specific files
scopes the subject and not the evidence, and to read the rest of that file's
directory before asserting a finding. That is the one change here whose effect is
unmeasured; it is labelled as such rather than claimed.

Also in this release: the session-audit, reliability and escalation censuses with
their tests, and the upstream reports they produced.

Verified before tagging: 164 root tests, 206 verify-on-edit, 28 recall-gate, 46
check-claims, 21 guidance-pack, 67 apply-patch, 38 approval-memory, 35
compaction-todo, 59 edit-feedback, and 85 files parsing cleanly. The recall gate
was also proven live rather than only in tests: it denied a write in the session
that cut this release, recording an errored tool result carrying its reason, and
permitted the same write after the recall ran. Not verified: verify-on-edit has
not yet run its Python paths in a live Python workspace. That behaviour is
covered by tests against real directories and by executing the rendered commands
in the reporting tree, so a session opened in a Python project remains the
cheapest confirmation.

<!-- /release:0.4.0 -->

## [0.3.0] - 2026-10-03

<!-- release:0.3.0 -->
0.3.0: SAGE over HTTP, the reload boundary, and approval memory

Four things land together, each with its own record of what was measured.

SAGE now mounts over its running HTTP MCP endpoint instead of one stdio child
per workspace, with a per-session bearer sourced from the local operator and
kept in a 0600 cache; the endpoint is validated before any credential moves and
a workspace's stdio declaration cannot displace an operator's HTTP policy.

A profile edit's reach into a running session is settled from the shipped
dsh-hmr source and the session logs: a patch write recomposes the root
composition and lands in seconds, a manifest write matters only through the
ordered bundle list, and a preset's own definition waits for the next mount.
Filed on discussion 8635.

Approval memory answers the approval waterfall from command-prefix rules kept
outside every workspace, so a prefix granted once stops asking, while a command
carrying a shell operator still asks.

The cordis preset's skill root is repaired at the preset's own row, and two
census tools now make the durable records behind these claims countable:
skill catalogs per preset, and tool-surface changes per session.

<!-- /release:0.3.0 -->

## [0.2.0] - 2026-10-01

<!-- release:0.2.0 -->
0.2.0: mount workspace servers per agent

Adds the perAgent mount mode: one mcp-client per live root agent, in that
agent's own scope and from the workspace its session recorded, with every
mounted server given that workspace as cwd when it declares none. A
process-wide mount is wrong wherever the harness process working directory is
not the session workspace, which is every GUI host.

<!-- /release:0.2.0 -->
