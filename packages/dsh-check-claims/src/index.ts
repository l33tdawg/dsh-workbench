/**
 * `check_claims`: turn a claim into a command whose answer you cannot misread.
 *
 * Written after four unmeasured assertions reached a public bug report: a count
 * stated as "every" when it was 25 of 65, a count stated as three when it was
 * nine, a path cited from the wrong repository, and an absence verified against
 * a working tree carrying the author's own patch.
 *
 * Each of those was one command away from being caught. The failures were not
 * in knowing how to check but in checking by hand: a `grep | head` that
 * truncates, a pattern that cannot match wrapped text, and a search of whatever
 * tree happened to be checked out. So this tool does the three things a hand
 * search does not:
 *
 *   It reports the true count, never a truncated one.
 *   It fails rather than passes when the scan did not cover everything.
 *   It reads a named revision when the claim is about one.
 *
 * @module @l33tdawg/dsh-check-claims
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import { countMatches, judge, type CountResult } from './match.ts'
import { formatReport, type CheckValue, type ReportValue, type Verdict } from './report.ts'
import { scan, type ScanSource } from './scan.ts'
import { revisionSource, workingTreeSource } from './sources.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'check-claims'

/** Services this plugin reads; every `ctx.<name>` below must appear here. */
export const inject = ['tools', 'systemPrompt'] as const

/** Tool name as the model sees it. */
export const TOOL_NAME = 'check_claims'

/** Longest a validated revision or path may be. */
const MAX_TOKEN = 400

/**
 * A git revision, restricted to characters git itself accepts. Rejecting the
 * rest is what keeps a caller-supplied revision out of the shell string built
 * below.
 */
const REVISION = /^[A-Za-z0-9._/@^~-]+$/

/**
 * A path to scan, restricted to characters that cannot alter a command, and
 * holding no whitespace at all. `..` is rejected separately, which is what
 * keeps a relative path inside its base. A real directory name with a space in
 * it goes in `root` instead, which reaches no command line and so can be
 * checked by a different rule.
 */
const RELATIVE_PATH = /^[A-Za-z0-9._/@+-]+$/

/**
 * Characters a scan root may not contain. Deliberately not the allowlist above:
 * a real directory name can hold a space or a comma, and a root never reaches a
 * command line, so only what would break a report is refused.
 */
const UNSAFE_ROOT = /[\u0000-\u001f\u007f]/

/** One check as supplied by the model. */
interface CheckArgs {
  pattern: string
  path: string
  root?: string
  expect?: number
  atLeast?: number
  at?: string
  flags?: string
}

/** Arguments for the tool. */
interface CheckClaimsArgs {
  checks: CheckArgs[]
}

/** Shell surface this plugin uses, read through `ctx.get` so it stays optional. */
interface ShellLike {
  resolve: (request: { command: string, workdir: string, timeoutMs: number }) => unknown
  execute: (spec: unknown) => Promise<{
    result: () => Promise<{
      exitCode: number | null
      stdout?: { text?: string } | undefined
      stderr?: { text?: string } | undefined
    }>
  }>
}

/** Time a single git read may take. */
const GIT_TIMEOUT_MS = 20_000

/**
 * Validate a token before it reaches a command string.
 *
 * @param value - the caller-supplied revision or path.
 * @param kind - which pattern to apply.
 * @returns the value, when it is safe to embed.
 * @throws {Error} when the value contains anything that could alter a command.
 */
export function assertSafeToken(value: string, kind: 'revision' | 'path'): string {
  if (value.length === 0 || value.length > MAX_TOKEN) {
    throw new Error(`${kind} must be 1-${MAX_TOKEN} characters`)
  }
  const pattern = kind === 'revision' ? REVISION : RELATIVE_PATH
  if (!pattern.test(value)) {
    throw new Error(
      `${kind} "${value}" contains characters outside ${String(pattern)}; `
      + 'this tool builds a command from it, so the value is refused rather than escaped',
    )
  }
  if (kind === 'path' && value.split('/').includes('..')) {
    throw new Error(`path "${value}" contains ".."; a claim is checked inside the workspace`)
  }
  return value
}

/**
 * Validate a scan root, which unlike a path may leave the workspace.
 *
 * A root is read from the filesystem and never embedded in a command, so the
 * character allowlist a path needs would only refuse legitimate directory
 * names. What is refused instead is everything that would make the scan base
 * ambiguous in the report: a `..` segment, or a control character.
 *
 * @param value - the caller-supplied root.
 * @returns the root, unchanged.
 * @throws {Error} when the value is empty, too long, or ambiguous.
 */
export function assertSafeRoot(value: string): string {
  if (value.length === 0 || value.length > MAX_TOKEN) {
    throw new Error(`root must be 1-${MAX_TOKEN} characters`)
  }
  if (UNSAFE_ROOT.test(value)) {
    throw new Error(`root "${value}" contains a control character`)
  }
  if (value.split('/').includes('..')) {
    throw new Error(
      `root "${value}" contains ".."; pass the resolved path instead, `
      + 'so the report names the directory that was actually scanned',
    )
  }
  return value
}

/**
 * The git runner, built from the shell service when the composition has one.
 *
 * Every token passed here has already cleared {@link assertSafeToken}, so the
 * quoting below is defence in depth rather than the only barrier between a
 * caller-supplied revision and the command line.
 *
 * @param shell - the shell service, or undefined.
 * @param root - working directory for git.
 * @returns an async runner, or undefined when no shell is mounted.
 */
function gitRunner(shell: ShellLike | undefined, root: string):
((command: string, args: string[]) => Promise<string>) | undefined {
  if (shell === undefined) return undefined
  return async (command: string, args: string[]): Promise<string> => {
    const line = [command, ...args].map(token => `'${token}'`).join(' ')
    const spec = shell.resolve({ command: line, workdir: root, timeoutMs: GIT_TIMEOUT_MS })
    const execution = await shell.execute(spec)
    const result = await execution.result()
    if (result.exitCode !== 0) {
      throw new Error(`git exited ${String(result.exitCode)}: ${result.stderr?.text ?? ''}`.trim())
    }
    return result.stdout?.text ?? ''
  }
}

/**
 * The tool's declared output schema.
 *
 * Exported so a test can compare it against what `execute` returns. The registry
 * validates the result against this schema, so a property the tool returns but
 * does not declare fails the call after the work is done.
 */
export const OUTPUT_SCHEMA = {
        type: 'object',
        additionalProperties: false,
        properties: {
          checks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                pattern: { type: 'string', required: true },
                path: { type: 'string', required: true },
                at: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                root: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                verdict: { type: 'string', required: true, enum: ['pass', 'fail', 'unknown'] },
                count: { type: 'integer', required: true },
                detail: { type: 'string', required: true },
                incomplete: { type: 'boolean', required: true },
                sites: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      path: { type: 'string', required: true },
                      line: { type: 'integer', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      } as const

/**
 * Register the `check_claims` tool and its prompt guidance.
 *
 * @param ctx - Cordis context carrying the tool registry and prompt sections.
 */
export function apply(ctx: {
  systemPrompt: { section: (section: unknown) => () => void, getSectionOrder: (name: string) => number }
  tools: { register: (tool: unknown) => () => void, get: (name: string, scope?: unknown) => unknown }
  get?: (name: string) => unknown
  logger?: { warn: (message: string, ...rest: unknown[]) => void }
}): void {
  // Scope-guarded, like the seven shipped tool sections that do this. A section
  // that renders for an agent without the tool instructs it to call something
  // it does not have.
  ctx.systemPrompt.section({
    name: 'tool:check_claims',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT') + 1,
    text: ({ scope }: { scope?: unknown }) => ctx.tools.get(TOOL_NAME, scope) === undefined
      ? ''
      : 'Before writing "every", "all", "none", or a number into a message, a commit, or a report, '
        + 'check it with check_claims rather than by eye. It reports the true count, reads a named '
        + 'revision with at, and refuses to pass when the scan did not cover everything.',
  })

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description:
      'Check countable claims against the source rather than by inspection. Each check counts '
      + 'matches of a regular expression under a path and compares the count with what you expect. '
      + 'The count is exact and never truncated, and a check whose scan stopped early is reported '
      + 'as undecided rather than passing. Set `at` to read a git revision instead of the working '
      + 'tree, which is the difference between a claim about upstream and a claim about your own '
      + 'checkout. Set `root` when the claim is about a tree outside the session workspace: a '
      + 'relative root is resolved against the workspace, an absolute one is used as given, and '
      + 'the report names the base it actually scanned. Every path names files on disk, so this '
      + 'tool cannot check a count that exists only in tool output, such as the number of inbox '
      + 'items or open tasks a response reports; re-read that response rather than treating a '
      + 'count here as covering it.',
    parameters: {
      checks: {
        type: 'array',
        required: true,
        description: 'One entry per claim. All are checked; none short-circuit.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pattern: { type: 'string', required: true, description: 'Regular expression source.' },
            path: { type: 'string', required: true, description: 'File or directory, relative to the session workspace, or relative to `root` when one is given.' },
            root: { type: 'string', description: 'Directory to scan from, when the claim is about a tree outside the session workspace. Absolute, or relative to the workspace. Mutually exclusive with `at`.' },
            expect: { type: 'integer', description: 'Exact number of matches required. Use 0 to claim absence.' },
            atLeast: { type: 'integer', description: 'Minimum number of matches required.' },
            at: { type: 'string', description: 'Git revision to read, such as origin/master. Defaults to the working tree.' },
            flags: { type: 'string', description: 'Regex flags such as "i" or "s"; "g" is added automatically.' },
          },
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: CheckClaimsArgs, value: ReportValue) => [{ type: 'text', text: formatReport(value) }],
    },
    async execute(args: CheckClaimsArgs, exec: unknown): Promise<ReportValue> {
      const root = (exec as { agent?: { session: { header: { cwd?: string } } } })
        .agent?.session.header.cwd ?? process.cwd()
      const shell = ctx.get?.('shell') as ShellLike | undefined

      const checks: CheckValue[] = []
      for (const request of args.checks) {
        checks.push(await runOne(request, root, shell))
      }
      return { checks }
    },
  }))
}

/**
 * Run one check end to end.
 *
 * @param request - the caller's check.
 * @param root - session workspace root.
 * @param shell - shell service, when mounted.
 * @returns the check's result.
 */
async function runOne(request: CheckArgs, root: string, shell: ShellLike | undefined): Promise<CheckValue> {
  const workspace = resolve(root)
  const base: CheckValue = {
    pattern: request.pattern,
    path: request.path,
    at: request.at ?? null,
    root: request.root === undefined
      ? null
      : (isAbsolute(request.root) ? resolve(request.root) : resolve(workspace, request.root)),
    verdict: 'unknown',
    count: 0,
    detail: '',
    incomplete: false,
    sites: [],
  }

  let source: ScanSource
  try {
    assertSafeToken(request.path, 'path')
    if (request.root !== undefined) {
      if (request.at !== undefined) {
        return { ...base, detail: 'root and at are mutually exclusive: a revision is read in one repository' }
      }
      assertSafeRoot(request.root)
    }
    const scanRoot = base.root ?? workspace
    if (request.at === undefined) {
      source = workingTreeSource(scanRoot)
    } else {
      assertSafeToken(request.at, 'revision')
      const run = gitRunner(shell, scanRoot)
      if (run === undefined) {
        return { ...base, detail: 'no shell service is mounted, so a revision cannot be read' }
      }
      source = revisionSource(request.at, run)
    }
  } catch (error: unknown) {
    return { ...base, detail: (error as Error).message }
  }

  let counted: CountResult
  try {
    counted = countMatches(await scan(source, request.path, base.root), request.pattern, request.flags)
  } catch (error: unknown) {
    return { ...base, detail: (error as Error).message }
  }

  const judgement = judge(counted, { expect: request.expect, atLeast: request.atLeast })
  // A scan rooted elsewhere names its own base, because its relative paths
  // would otherwise read as workspace paths that do not exist.
  const scope = base.root === null ? source.describe : `${source.describe} rooted at ${base.root}`
  return {
    ...base,
    verdict: judgement.verdict as Verdict,
    count: counted.count,
    detail: `${judgement.detail} [${scope}]`,
    incomplete: counted.incomplete,
    sites: counted.sites,
  }
}
