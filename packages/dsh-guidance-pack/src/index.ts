/**
 * Behavioural prompt guidance for DeepSeek Harness.
 *
 * The harness assembles its system prompt from the harness identity, a
 * deployment persona, and one short section per mounted tool. That leaves the
 * cross-cutting engineering discipline — when to plan, how far to push a task,
 * what to verify, how to edit and report — unstated. This plugin contributes one
 * prompt section covering exactly that gap, and nothing that DSH already says.
 *
 * The section is registered as an ordinary `systemPrompt.section`, so it
 * participates in the same scoped assembly, caching, and ordering as every
 * first-party section. The plugin changes no tool, no policy, and no harness
 * package.
 *
 * @module @l33tdawg/dsh-guidance-pack
 */

import { BLOCKS, BLOCK_NAMES } from './blocks.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'guidance-pack'

/** Services required before activation: the prompt registry owns the section list. */
export const inject = ['systemPrompt']

/** Section name. Stable, so a profile or preset can shadow it by name. */
export const SECTION_NAME = 'guidance:pack'

/** Default prompt order: after the deployment persona (0), before plan policy (500). */
export const DEFAULT_ORDER = 100

/** Fields the configuration accepts, and the shape each must have. */
const FIELD_TYPES = {
  blocks: 'strings',
  order: 'number',
  extra: 'string',
}

/** Whether a value is a list of strings. */
function isStringList(value) {
  return Array.isArray(value) && value.every(member => typeof member === 'string')
}

/** Whether a value matches one declared field shape. */
function matchesFieldType(value, kind) {
  if (kind === 'strings') return isStringList(value)
  if (kind === 'string') return typeof value === 'string'
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value)
  return false
}

/**
 * Reject configurations that cannot be honoured instead of silently falling
 * back: an unknown block name, a duplicated name, or a non-finite order is a
 * mistake in the deployment, and a quiet default would hide it.
 *
 * @param raw - Configuration exactly as written in the loader config.
 * @returns The normalized configuration, or the issues that reject it.
 */
export function validateConfig(raw) {
  const input = raw ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { issues: [{ message: 'config must be an object' }] }
  }
  const issues = []
  for (const [key, kind] of Object.entries(FIELD_TYPES)) {
    if (input[key] !== undefined && !matchesFieldType(input[key], kind)) {
      issues.push({ message: `${key} must be ${kind}`, path: [key] })
    }
  }
  const blocks = input.blocks ?? []
  if (Array.isArray(blocks)) {
    const seen = new Set()
    for (const block of blocks) {
      if (typeof block !== 'string') continue
      if (!BLOCK_NAMES.includes(block)) {
        issues.push({ message: `unknown block "${block}" (known: ${BLOCK_NAMES.join(', ')})`, path: ['blocks'] })
      } else if (seen.has(block)) {
        issues.push({ message: `duplicate block "${block}"`, path: ['blocks'] })
      }
      seen.add(block)
    }
  }
  if (issues.length > 0) return { issues }
  return {
    value: {
      blocks: [...blocks],
      order: input.order ?? DEFAULT_ORDER,
      extra: input.extra ?? '',
    },
  }
}

/** Standard Schema validator the Cordis loader reads. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-guidance-pack',
    validate: validateConfig,
  },
}

/**
 * Select the blocks a configuration enables, preserving declaration order.
 * @param requested - Configured block names; empty means every block.
 * @returns The enabled blocks in declaration order.
 */
export function selectBlocks(requested) {
  if (requested === undefined || requested.length === 0) return [...BLOCKS]
  return BLOCKS.filter(block => requested.includes(block.name))
}

/**
 * Render the section text for a configuration.
 *
 * Blocks are joined by a blank line and an optional deployment `extra` block is
 * appended last, so a deployment can extend the pack without forking it.
 *
 * @param config - A validated configuration.
 * @returns The section text, or an empty string when nothing is enabled.
 */
export function renderGuidance(config) {
  const parts = selectBlocks(config.blocks).map(block => block.text)
  const extra = config.extra.trim()
  if (extra.length > 0) parts.push(extra)
  return parts.join('\n\n')
}

/**
 * Register the guidance section.
 *
 * The section is marked `interpolate: false`: the text is literal Markdown, and
 * a future edit containing `{{...}}` must not be silently rewritten as a prompt
 * variable.
 *
 * @param ctx - Cordis context carrying the prompt registry.
 * @param config - Resolved plugin configuration.
 */
export function apply(ctx, config) {
  const text = renderGuidance(config)
  if (text.length === 0) {
    ctx.logger.warn('[guidance-pack] every block is disabled; no prompt section registered')
    return
  }
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: config.order,
    text,
    interpolate: false,
  })
}

export { BLOCKS, BLOCK_NAMES }
