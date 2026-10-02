/**
 * A multi-file atomic patch tool for DeepSeek Harness.
 *
 * The harness `edit` tool replaces one literal string in one file per call, so a
 * coherent change spanning several files costs several calls and several
 * confirmations. This tool applies a whole patch — many hunks across many files,
 * plus renames — in one call.
 *
 * It deliberately takes Codex's expressiveness without Codex's failure modes.
 * Codex's `apply_patch` takes the first match for a hunk even when several sites
 * are identical, silently overwrites on `*** Add File`, and applies hunks as it
 * goes so a failure on the fourth file leaves the first three changed. Here a
 * hunk that matches more than one place is refused, a create that would clobber
 * an existing file is refused, and the whole patch is resolved before any byte
 * is written.
 *
 * Writes go through `ctx.fs`, so the sandbox fence, the read-before-edit policy,
 * the version check, and the atomic temp-and-rename write are exactly the ones
 * `write` and `edit` already use.
 *
 * @module @l33tdawg/dsh-apply-patch
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { PatchApplyError, planPatch } from './apply.ts'
import type { PlannedChange } from './apply.ts'
import { PatchParseError, parsePatch } from './parser.ts'
import { changeDiffs, formatApplyOutput, patchTitle } from './report.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'apply-patch'

/**
 * Services required before activation.
 *
 * Cordis resolves `ctx.<name>` only for injected services and throws on an
 * undeclared read, so every service this plugin touches must be listed. The
 * prompt-registry read below is why `systemPrompt` is here; leaving it out does
 * not degrade the plugin, it stops it activating with
 * `cannot get property "systemPrompt" without inject`.
 */
export const inject = ['tools', 'fs', 'systemPrompt']

/** The registered tool name. */
export const TOOL_NAME = 'apply_patch'

/** Prompt placement, immediately after the harness's own `edit` guidance. */
const SECTION_ORDER_OFFSET = 1

/** Tool arguments. */
interface ApplyPatchArgs {
  patch: string
}

/** The tool's validated return value. */
interface ApplyPatchResult {
  files: readonly PlannedChange[]
}

/**
 * The stable error code on a thrown harness error, if it has one.
 *
 * Read structurally rather than with `instanceof`, which would require importing
 * `@deepseek-ai/dsh-fs` and would then depend on this plugin and the harness
 * holding the *same* class object. Two copies of that package in one process
 * would make every `instanceof` false and silently skip the handling below.
 *
 * @param error - the caught value.
 * @returns the code, or `undefined` when the value is not a coded harness error.
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Resolution options shared by the filesystem tools: the workspace root the
 * mutation is allowed under, plus cancellation.
 *
 * The root comes from the session's resolved sandbox policy when one exists,
 * and falls back to the session cwd. Passing only the cwd is not enough: the
 * provider applies its *own* default root when no policy is stamped, which is
 * the process working directory rather than the session workspace, so an
 * absolute path inside the workspace is refused while one outside it is
 * allowed. That inversion is the reason this function exists.
 *
 * @param exec - the tool-execution context.
 * @param policy - the resolved sandbox policy, when the composition has one.
 * @returns provider resolution options for this call.
 */
export function resolveOptions(
  exec: { agent?: { session: { header: { cwd?: string } } }, signal?: AbortSignal },
  policy?: { workspaceRoot?: string },
): { cwd?: string, signal?: AbortSignal } {
  const cwd = policy?.workspaceRoot ?? exec.agent?.session.header.cwd
  return {
    ...cwd === undefined ? {} : { cwd },
    ...exec.signal === undefined ? {} : { signal: exec.signal },
  }
}

/**
 * Turn a guarded-mutation failure into the message the model needs to recover.
 *
 * `FS_NOT_OBSERVED` and `FS_STALE_VERSION` both mean "your view of the file is
 * stale", and both are recoverable by reading it again. Saying so at the point
 * of failure is what stops the agent retrying the same edit hopefully.
 *
 * @param error - the caught value from a write or edit.
 * @param displayPath - the resolved path shown to the model.
 * @returns a remediated error for those two codes, else the original value.
 */
export function remediate(error: unknown, displayPath: string): unknown {
  const code = errorCode(error)
  if (code !== 'FS_NOT_OBSERVED' && code !== 'FS_STALE_VERSION') return error
  if (!(error instanceof Error)) return error
  const reason = code === 'FS_NOT_OBSERVED'
    ? `cannot modify "${displayPath}": file has not been read`
    : error.message
  // Keep the class and the code so machine routing still works; rebuild through
  // the original constructor when it accepts a message.
  const rebuilt = new (error.constructor as new (message: string) => Error)(`${reason} — read the file, then retry`)
  if (errorCode(rebuilt) === undefined) {
    Object.defineProperty(rebuilt, 'code', { value: code, enumerable: true })
  }
  return rebuilt
}

/**
 * The sandbox policy this call runs under, or `undefined` when the composition
 * mounts no policy service.
 *
 * Read through `ctx.get` rather than declaring `sandboxPolicy` in `inject`,
 * because a composition may legitimately confine through `ctx.fs` without
 * mounting the policy service, and an injected-but-absent service would stop
 * this plugin activating.
 *
 * @param ctx - the plugin context.
 * @param exec - the tool-execution context, for its session.
 * @returns the standing policy, when one resolves.
 */
export function resolveSessionPolicy(
  ctx: { get?: (name: string) => unknown },
  exec: unknown,
): { workspaceRoot?: string } | undefined {
  const service = ctx.get?.('sandboxPolicy') as
    { resolve?: (input: { session?: unknown }) => unknown } | undefined
  if (service?.resolve === undefined) return undefined
  const session = (exec as { agent?: { session?: unknown } } | undefined)?.agent?.session
  try {
    const policy = service.resolve({ ...session === undefined ? {} : { session } })
    return typeof policy === 'object' && policy !== null ? policy as { workspaceRoot?: string } : undefined
  } catch {
    // A policy that refuses to resolve is the policy layer's business to
    // report; the tool falls back to the session cwd rather than failing here.
    return undefined
  }
}

/**
 * The tool's declared output schema.
 *
 * Exported so a test can compare it against what `execute` actually returns.
 * The registry validates the result against this schema, so a property the tool
 * returns but does not declare fails the call *after* the write has already
 * landed: the model is told the edit failed when it succeeded, and retries it.
 * That is exactly what happened, which is why the two are now checked together.
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    files: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          target: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['create', 'update', 'move'] },
          before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          after: { type: 'string', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number', required: true },
                match: { type: 'string', required: true, enum: ['exact', 'rstrip', 'trim', 'punctuation'] },
                removed: { type: 'number', required: true },
                added: { type: 'number', required: true },
              },
            },
          },
        },
      },
    },
  },
} as const

/**
 * Register the `apply_patch` tool and its prompt guidance.
 * @param ctx - Cordis context carrying the tool registry and filesystem service.
 */
export function apply(ctx: {
  systemPrompt: { section: (section: unknown) => () => void, getSectionOrder: (name: string) => number }
  tools: { register: (tool: unknown) => () => void, get: (name: string, scope?: unknown) => unknown }
  get?: (name: string) => unknown
  fs: {
    resolve: (path: string, options?: { cwd?: string, signal?: AbortSignal }) => Promise<unknown>
    readText: (target: unknown, signal?: AbortSignal) => Promise<string>
    writeText: (target: unknown, content: string, intent: unknown, signal?: AbortSignal, policy?: unknown) => Promise<unknown>
  }
  waterfall: (event: string, target: unknown, exec: unknown, fallback: () => undefined) => Promise<unknown>
  emit: (event: string, target: unknown, payload: unknown, exec: unknown) => void
}): void {
  ctx.systemPrompt.section({
    name: 'tool:apply_patch',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT') + SECTION_ORDER_OFFSET,
    text: ({ scope }: { scope?: unknown }) => ctx.tools.get(TOOL_NAME, scope) === undefined
      ? ''
      : 'Use apply_patch to make a coherent change across several files, or several hunks in one '
        + 'file, in a single call. A hunk that matches more than one place is refused, so quote '
        + 'enough surrounding context to identify one location.',
  })

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description:
      'Apply one patch across one or more UTF-8 text files. The whole patch is checked before '
      + 'anything is written, so it either applies completely or not at all. Supports creating and '
      + 'updating files; a hunk that matches more than one location is rejected.',
    parameters: {
      patch: {
        type: 'string',
        required: true,
        description: 'The patch text: "*** Begin Patch", one section per file, "*** End Patch". '
          + 'Sections are "*** Add File: <path>" (each following line starts with "+") and '
          + '"*** Update File: <path>", then one or more hunks introduced by "@@" and made of '
          + '" " context, "-" removed and "+" added lines. End a hunk with "*** End of File" to '
          + 'anchor it at the end of the file.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: ApplyPatchArgs, value: ApplyPatchResult) =>
        [{ type: 'text', text: formatApplyOutput(value.files) }],
      presentationMeta: (_args: ApplyPatchArgs, value: ApplyPatchResult) => ({
        files: value.files,
        diffs: value.files.flatMap(changeDiffs),
      }),
    },
    async execute(args: ApplyPatchArgs, exec: never) {
      const preconditions = parsePatch(args.patch)

      // The session's standing policy, read through `ctx.get` rather than an
      // injected property so a composition without a policy service still
      // loads. `resolvePolicy` is the service's only method this needs.
      const policy = resolveSessionPolicy(ctx, exec)

      // Resolve every path first so the plan reads a stable view, then read each
      // target once. A missing file is a legitimate state for a create and a
      // failure for anything else, so only that code is swallowed.
      const targets = new Map<string, { target: never, content: string | undefined }>()
      for (const op of preconditions.ops) {
        if (targets.has(op.path)) continue
        const resolved = await ctx.fs.resolve(op.path, resolveOptions(exec, policy)) as never
        let content: string | undefined
        try {
          content = await ctx.fs.readText(resolved, (exec as { signal?: AbortSignal }).signal)
        } catch (error: unknown) {
          if (errorCode(error) !== 'FS_NOT_FOUND') throw error
        }
        targets.set(op.path, { target: resolved, content })
      }

      const plan = planPatch(preconditions, path => targets.get(path)?.content)

      // Every hunk resolved and every body computed. From here the only failures
      // left are environmental, and each is reported with what already landed.
      const written: string[] = []
      for (const change of plan.changes) {
        const entry = targets.get(change.path)
        if (entry === undefined) throw new PatchApplyError(`internal: ${change.path} was not resolved`, change.path)
        const intent = await ctx.waterfall('fs/write-intent', entry.target, exec, () => undefined)
        // Declared outside the try: the observation after it needs the version
        // this write produced, and a `const` inside the block would not survive
        // the catch.
        let outcome: { version?: unknown } | undefined
        try {
          // The policy is stamped on the mutation, as `write` and `edit` do.
          // Omitting it lets the provider apply its own default root instead of
          // the session's, which puts the write in the wrong place.
          //
          // The outcome is kept because the observation below needs the version
          // this write produced. `FsObservation` requires one on `present`, and
          // the next write computes `replaceIfVersion` from it: emit without it
          // and the following edit of the same file fails the compare-and-swap
          // with a misleading "file changed since it was read".
          outcome = await ctx.fs.writeText(
            entry.target,
            change.after,
            intent,
            (exec as { signal?: AbortSignal }).signal,
            policy,
          ) as { version?: unknown }
        } catch (error: unknown) {
          const remedied = remediate(error, change.target)
          // A denial is far easier to act on when it names the root the fence
          // actually applied, which is otherwise invisible.
          const detail = errorCode(error) === 'FS_SANDBOX_DENIED'
            ? `\n[sandbox] resolved policy: ${policy === undefined ? 'none' : JSON.stringify(policy)}`
            : ''
          const message = `${(remedied as Error).message}${detail}`
          throw written.length === 0
            ? new Error(message)
            : new Error(`${message}\n\nAlready written by this patch: ${written.join(', ')}`)
        }
        ctx.emit('fs/observed', entry.target, { kind: 'present', version: outcome.version }, exec)
        written.push(change.target)
      }

      return { files: plan.changes }
    },
    presentResult(_args: ApplyPatchArgs, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const files = (result.meta as { files?: readonly PlannedChange[] } | undefined)?.files
      if (files === undefined || files.length === 0) return undefined
      return {
        card: 'diff',
        title: patchTitle(files),
        diffs: files.flatMap(changeDiffs),
      }
    },
  }))
}

export { PatchApplyError, PatchParseError, parsePatch, planPatch }
export { changeDiffs, formatApplyOutput, patchTitle }
