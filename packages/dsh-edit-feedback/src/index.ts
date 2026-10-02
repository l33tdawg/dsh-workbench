/**
 * Show the agent where its edit landed.
 *
 * A DSH `edit` returns one sentence: "The file X has been updated successfully."
 * The diff is computed inside the tool and handed to the presentation layer, so
 * the human sees where the change went and the model does not. The model's
 * rational response is to re-read the file, which is why `read-after-edit` is
 * the largest single category in this repository's own undo-class measurement.
 *
 * Prompt text asking the model not to re-read has been tried. This is the
 * mechanical version: the tool result carries the diff, computed from the
 * before/after pair the tool already returned, so there is nothing left to check.
 *
 * Three properties keep it honest:
 *
 * - **It reports, it does not judge.** The edit already succeeded, so the result
 *   stays a success and only its text changes. Nothing here can fail a tool call.
 * - **It only replaces content.** The decision leaves `value` and `meta` alone,
 *   so the version guard, the session transcript, and the UI's diff card are
 *   exactly as they were.
 * - **It is bounded.** A rewrite is summarized rather than pasted, and the
 *   truncation footer never tells the model to go read the file, because that is
 *   the behaviour this plugin exists to remove.
 *
 * @module @l33tdawg/dsh-edit-feedback
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'

import { changesFrom, formatFeedback, resolveConfig } from './report.ts'
import type { Config } from './report.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'edit-feedback'

/**
 * Services required before activation.
 *
 * The hook is a `tools/*` listener, so the tool registry must be present for the
 * event to exist at all. Cordis resolves `ctx.<name>` only for injected services
 * and throws on an undeclared read, so this is declared rather than assumed.
 */
export const inject = ['tools']

/**
 * Merge the diff into the content the model reads.
 *
 * The diff joins the last text block when there is one, so a result stays a
 * single block and no adapter has to decide what several mean together.
 *
 * @param content - the blocks already destined for the model.
 * @param text - the diff text to attach.
 * @returns the blocks, with the diff appended.
 */
function withDiff(content: readonly ContentBlock[], text: string): ContentBlock[] {
  const last = content[content.length - 1]
  if (last !== undefined && last.type === 'text') {
    return [...content.slice(0, -1), { type: 'text', text: `${last.text}\n\n${text}` }]
  }
  return [...content, { type: 'text', text }]
}

/**
 * Register the result-enrichment hook.
 * @param ctx - Cordis context carrying the tool registry.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream: PostToolDecision = await next()
    // A policy that blocked the call owns its outcome, and a downstream policy
    // may already have replaced the text. Neither is this plugin's to override.
    if (downstream.kind !== 'accept') return downstream
    try {
      if (result.isError) return downstream
      const changes = changesFrom(exec.name, result.value, resolved.tools)
      if (changes.length === 0) return downstream

      const text = formatFeedback(changes, resolved)
      if (text === undefined) return downstream

      const base = downstream.content ?? result.content
      return {
        kind: 'accept',
        content: withDiff(base, text),
        ...downstream.additionalContexts !== undefined
          ? { additionalContexts: downstream.additionalContexts }
          : {},
      }
    } catch (error: unknown) {
      // Reporting where an edit landed must never be why a tool call fails.
      ctx.logger.warn('edit-feedback: hook error: %o', error)
      return downstream
    }
  })
}
