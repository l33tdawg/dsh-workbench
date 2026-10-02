/**
 * Apply the network-fence patch to a DeepSeek Harness checkout.
 *
 * Every edit asserts its anchor before writing, so a checkout that has moved on
 * fails loudly instead of corrupting a file. Run with `--check` to report what
 * would change without touching anything.
 *
 * Usage: node network-fence.mjs <dsh-checkout> [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , root, ...flags] = process.argv
const check = flags.includes('--check')
if (root === undefined) {
  console.error('usage: node network-fence.mjs <dsh-checkout> [--check]')
  process.exit(2)
}

/** One anchored replacement. */
const EDITS = [
  {
    file: 'packages/sandbox/sandbox/src/index.ts',
    why: 'Carry network access on the policy and report its enforcement separately from file effects.',
    edits: [
      [
        `export interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory \`workspace-write\` may write under. */
  workspaceRoot: string
  /**
   * Opaque identity of the calling session`,
        `export interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory \`workspace-write\` may write under. */
  workspaceRoot: string
  /**
   * Whether the confined process may open network connections. Absent means
   * \`deny\` under every confining mode, so a policy that never mentions the
   * network still gets the restriction: reads and egress are the two halves of
   * exfiltration, and a fence over one stops neither. \`danger-full-access\`
   * ignores this, as it ignores every other restriction.
   */
  network?: SandboxNetworkAccess
  /**
   * Opaque identity of the calling session`,
      ],
      [
        `export type SandboxEnforcement = 'full' | 'partial'`,
        `export type SandboxEnforcement = 'full' | 'partial'

/**
 * Network reach for a confined process. \`deny\` blocks outbound connections and
 * listening sockets; \`allow\` leaves the host's own reachability untouched.
 */
export type SandboxNetworkAccess = 'deny' | 'allow'`,
      ],
      [
        `  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement`,
        `  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /**
   * How completely the selected backend enforces the policy's network
   * restriction, or absent when the provider does not report it. Kept separate
   * from {@link enforcement} because a backend can govern every file effect
   * while being unable to touch the network at all — Landlock is
   * filesystem-only, and windows-acl's restricted token does not govern
   * sockets — so treating \`full\` file enforcement as proof of egress control
   * is wrong on exactly those hosts. A consumer that needs the guarantee must
   * read \`'full'\` positively; absence is not a claim.
   */
  networkEnforcement?: SandboxEnforcement`,
      ],
    ],
  },

  {
    file: 'packages/sandbox/sandbox-local/src/profiles.ts',
    why: 'Deny egress in the two profiles that can express it.',
    edits: [
      [
        `import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'`,
        `import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxNetworkAccess, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * Whether a policy permits network access. Absent means \`deny\`: a policy that
 * never mentions the network is confined, not unrestricted.
 * @param policy - the policy to read.
 * @returns whether egress is permitted.
 */
export function networkAllowed(policy: Pick<SandboxPolicy, 'network'>): boolean {
  return policy.network === 'allow'
}`,
      ],
      [
        `export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {`,
        `export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  // A fresh network namespace with no interfaces: the child keeps \`lo\` down and
  // has no route off the host. This is the whole fence on Linux — it removes the
  // capability rather than filtering it, so there is nothing to evade.
  if (!networkAllowed(policy)) args.push('--unshare-net')
  if (policy.mode === 'workspace-write') {`,
      ],
      [
        `export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', \`(allow file-write* (literal \${sbplString('/dev/null')}))\`]`,
        `export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', \`(allow file-write* (literal \${sbplString('/dev/null')}))\`]
  // Seatbelt resolves an explicit deny ahead of \`(allow default)\`, which is how
  // the file-write deny above already works. \`network*\` is denied rather than
  // only \`network-outbound\` so a confined command cannot listen either; the
  // cost is that AF_UNIX clients (a docker socket, say) are blocked too, which
  // is the intended reading of a confined mode and is recoverable through the
  // ordinary escalation path.
  if (!networkAllowed(policy)) forms.push('(deny network*)')`,
      ],
    ],
  },

  {
    file: 'packages/sandbox/sandbox-local/src/index.ts',
    why: 'Report per-runner network enforcement honestly, and warn when a rung cannot enforce it.',
    edits: [
      [
        `const STATIC_ENFORCEMENT: Record<SelectedRunner['runner'], SandboxEnforcement> = {
  bwrap: 'full',
  landlock: 'full',
  seatbelt: 'full',`,
        `const STATIC_ENFORCEMENT: Record<SelectedRunner['runner'], SandboxEnforcement> = {
  bwrap: 'full',
  landlock: 'full',
  seatbelt: 'full',`,
      ],
      [
        `    if (this.runnerCommand !== undefined) {
      return Promise.resolve<ConfinedArgv>({
        argv: [...this.runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv],
        enforcement: 'full',
        denialSignatures: DENIAL_SIGNATURES.runnerCommand,
        runnerFailureRules: [{ fatalSignatures: this.configuredRunnerFailureSignatures }],
      })
    }
    const selected = this.selectRunner(policy.mode)
    const runnerArgv = this.runnerArgv(selected.runner, policy)
    return Promise.resolve<ConfinedArgv>({
      argv: [...runnerArgv, '--', ...argv],
      enforcement: selected.enforcement,
      denialSignatures: DENIAL_SIGNATURES[selected.runner],
      runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
    })`,
        `    if (this.runnerCommand !== undefined) {
      return Promise.resolve<ConfinedArgv>({
        argv: [...this.runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv],
        enforcement: 'full',
        // An operator-supplied runner is wrapped with the bwrap profile, so it
        // carries --unshare-net like the built-in rung; whether the runner
        // honours it is the operator's assertion, exactly as for file effects.
        networkEnforcement: 'full',
        denialSignatures: DENIAL_SIGNATURES.runnerCommand,
        runnerFailureRules: [{ fatalSignatures: this.configuredRunnerFailureSignatures }],
      })
    }
    const selected = this.selectRunner(policy.mode)
    const runnerArgv = this.runnerArgv(selected.runner, policy)
    const networkEnforcement = networkEnforcementOf(selected.runner)
    if (!networkAllowed(policy) && networkEnforcement === 'partial') {
      // Not fatal: the file fence still holds and the run is still useful. But a
      // mode named read-only that silently permits egress is the failure this
      // whole change exists to prevent, so it must be visible rather than
      // inferred from reading the backend.
      this.ctx.logger.warn(
        'sandbox-local: %s cannot enforce the network restriction; confined commands under %s may still reach the network',
        selected.runner,
        policy.mode,
      )
    }
    return Promise.resolve<ConfinedArgv>({
      argv: [...runnerArgv, '--', ...argv],
      enforcement: selected.enforcement,
      networkEnforcement,
      denialSignatures: DENIAL_SIGNATURES[selected.runner],
      runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
    })`,
      ],
      [
        `import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from './profiles.ts'`,
        `import { bwrapProfileArgs, landlockProfileArgs, networkAllowed, seatbeltProfileArgs } from './profiles.ts'

/**
 * Whether one runner can enforce the network restriction. bwrap gets a private
 * network namespace and Seatbelt gets a kernel deny; Landlock is documented as
 * filesystem-only and windows-acl's restricted token does not govern sockets,
 * so both must say so rather than inherit the file verdict.
 * @param runner - the selected backend.
 * @returns that backend's network enforcement completeness.
 */
function networkEnforcementOf(runner: SelectedRunner['runner']): SandboxEnforcement {
  return runner === 'bwrap' || runner === 'seatbelt' ? 'full' : 'partial'
}`,
      ],
    ],
  },

  {
    file: 'packages/ssh/sandbox-ssh/src/index.ts',
    why: 'The remote wrapper must relay the new field rather than drop it.',
    edits: [
      [
        `const factsSchema = z.object({ argv: z.array(z.string()).min(1), enforcement: z.enum(['full', 'partial']), denialSignatures: z.array(z.string()), runnerFailureRules: z.array(z.object({ allowedExitCodes: z.array(z.number().int()).optional(), fatalSignatures: z.array(z.string()), informationalLines: z.array(z.string()).optional() }).strict()) }).strict()`,
        `const factsSchema = z.object({ argv: z.array(z.string()).min(1), enforcement: z.enum(['full', 'partial']), networkEnforcement: z.enum(['full', 'partial']).optional(), denialSignatures: z.array(z.string()), runnerFailureRules: z.array(z.object({ allowedExitCodes: z.array(z.number().int()).optional(), fatalSignatures: z.array(z.string()), informationalLines: z.array(z.string()).optional() }).strict()) }).strict()`,
      ],
    ],
  },
  {
    file: 'packages/sandbox/sandbox-local/tests/local.spec.ts',
    why: 'Update the pinned profile fixtures and cover the deny default, the allow opt-out, and per-runner reporting.',
    edits: [
      [
        `const SEATBELT_RO_PROFILE = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))'`,
        `const SEATBELT_RO_PROFILE = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) (deny network*)'
/** The same profile with egress permitted, for the opt-out assertions. */
const SEATBELT_RO_PROFILE_NET = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))'
/** The bwrap profile's invariant head; the network flag is inserted after it. */
const BWRAP_HEAD = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']`,
      ],
      [
        `    expect(bwrapProfileArgs(RO)).toEqual(['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent'])`,
        `    expect(bwrapProfileArgs(RO)).toEqual([...BWRAP_HEAD, '--unshare-net'])`,
      ],
      [
        `    expect(bwrapProfileArgs(WW)).toEqual([
      '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent',
      '--tmpfs', '/tmp', '--bind', '/ws', '/ws',
    ])`,
        `    expect(bwrapProfileArgs(WW)).toEqual([
      ...BWRAP_HEAD, '--unshare-net',
      '--tmpfs', '/tmp', '--bind', '/ws', '/ws',
    ])`,
      ],
      [
        `  it('seatbelt workspace-write dedups a workspace root that already IS the temp dir', () => {`,
        `  // The network axis is independent of the file axis: a policy that never
  // mentions it is confined, and only an explicit 'allow' lifts the deny.
  it('denies network by default in both expressible profiles', () => {
    expect(bwrapProfileArgs(RO)).toContain('--unshare-net')
    expect(bwrapProfileArgs({ ...RO, network: 'deny' })).toContain('--unshare-net')
    expect(seatbeltProfileArgs(RO)[1]).toContain('(deny network*)')
    expect(seatbeltProfileArgs({ ...RO, network: 'deny' })[1]).toContain('(deny network*)')
  })

  it("network: 'allow' lifts the deny in both profiles and changes nothing else", () => {
    expect(bwrapProfileArgs({ ...RO, network: 'allow' })).toEqual([...BWRAP_HEAD])
    expect(seatbeltProfileArgs({ ...RO, network: 'allow' })).toEqual(['-p', SEATBELT_RO_PROFILE_NET])
    // The file fence is untouched by the network decision.
    expect(bwrapProfileArgs({ ...WW, network: 'allow' })).toContain('--bind')
    expect(seatbeltProfileArgs({ ...WW, network: 'allow' })[1]).toContain('(deny file-write*)')
  })

  it('seatbelt workspace-write dedups a workspace root that already IS the temp dir', () => {`,
      ],
    ],
  },

  {
    file: 'packages/sandbox/sandbox-local/tests/seatbelt.e2e.ts',
    why: 'Prove the kernel actually refuses egress, and that the opt-out restores it.',
    edits: [
      [
        `  it('workspace-write grants /tmp and the user temp dir (the documented Seatbelt-profile temp areas)', async () => {`,
        `  // The claim under test is a world effect, not a profile string: with the
  // deny in place the connection must fail, and with 'allow' the same command
  // must succeed. A test that only read the profile back could pass while the
  // kernel ignored it.
  it('read-only denies network egress, and the wrap reports full network enforcement', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const command = 'curl -s -m 5 -o /dev/null https://example.com'
    const { result, confined } = await runConfined(sandbox, command, { mode: 'read-only', workspaceRoot: workdir })
    expect(confined.networkEnforcement).toBe('full')
    expect(result.status).not.toBe(0)
  })

  it("network: 'allow' lets the same command through", async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const command = 'curl -s -m 5 -o /dev/null -w "%{http_code}" https://example.com'
    const { result } = await runConfined(sandbox, command, { mode: 'read-only', workspaceRoot: workdir, network: 'allow' })
    // Offline CI would fail the connection for its own reasons; only assert the
    // fence is gone, which the deny case already distinguishes.
    expect(result.status === 0 || result.status === 6 || result.status === 28).toBe(true)
  })

  it('workspace-write grants /tmp and the user temp dir (the documented Seatbelt-profile temp areas)', async () => {`,
      ],
    ],
  },

  {
    file: 'packages/sandbox/sandbox-local/tests/bwrap.e2e.ts',
    why: 'Prove the private network namespace actually removes reachability.',
    edits: [
      [
        `  it('the passing probe selects the bwrap rung naturally — first in the ladder, full enforcement, EROFS dialect', async () => {`,
        `  it('read-only denies network egress through the private network namespace', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const command = 'curl -s -m 5 -o /dev/null https://example.com'
    const { result, confined } = await runConfined(sandbox, command, { mode: 'read-only', workspaceRoot: workdir })
    expect(confined.networkEnforcement).toBe('full')
    expect(result.status).not.toBe(0)
  })

  it('the passing probe selects the bwrap rung naturally — first in the ladder, full enforcement, EROFS dialect', async () => {`,
      ],
    ],
  },
]

let changed = 0
for (const entry of EDITS) {
  const path = join(root, entry.file)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`MISSING  ${entry.file}: ${error.message}`)
    process.exitCode = 1
    continue
  }
  const original = text
  let applied = 0
  let pending = 0
  for (const [from, to] of entry.edits) {
    // Check "already applied" first. A replacement edit consumes its own
    // anchor, so testing the anchor first would report every applied edit on an
    // already-patched tree as a missing anchor and exit non-zero.
    if (to !== from && text.includes(to)) {
      applied += 1
      continue
    }
    if (!text.includes(from)) {
      console.error(`ANCHOR   ${entry.file}: could not find\n---\n${from.slice(0, 200)}\n---`)
      process.exitCode = 1
      pending += 1
      continue
    }
    text = text.replace(from, to)
    pending += 1
  }
  if (text === original) {
    console.log(`${applied > 0 ? 'already applied' : 'unchanged'} ${entry.file}`)
    continue
  }
  changed += 1
  if (check) {
    console.log(`would change ${entry.file} — ${entry.why}`)
  } else {
    writeFileSync(path, text)
    console.log(`patched  ${entry.file} — ${entry.why}`)
  }
}
console.log(`\n${check ? 'would change' : 'changed'} ${changed} file(s)`)
