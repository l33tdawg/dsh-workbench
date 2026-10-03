/**
 * Rule matching for approval memory.
 *
 * A rule is a command prefix a session may run without being asked again. The
 * matching is deliberately narrow, because the failure that matters is not
 * "the rule did not fire and I was asked" - it is "the rule fired on a command
 * that does more than it says".
 *
 * So a rule matches only when the whole command is the prefix plus an argument
 * boundary, and only when the command carries no shell operator at all. A
 * prefix is a statement about the first words of a command; `;`, `&&`, `|`,
 * redirection, substitution and globbing are statements about the rest of it,
 * and a rule that ignored them would turn `npm test` into a grant on
 * `npm test; curl … | sh`. Anything refused here falls back to asking, which
 * is the safe direction: the cost is one prompt, not one wrong command.
 *
 * @module @l33tdawg/dsh-approval-memory/rules
 */

/** One command prefix a session may run without being asked. */
export interface Rule {
  /** Tool name the rule applies to, exactly as the approval request names it. */
  tool: string
  /** The command prefix, trimmed. */
  prefix: string
  /** Argument field to read from the call, `command` by default. */
  field?: string
}

/** What a rules file parsed to: usable rules, plus why others were dropped. */
export interface RuleSet {
  rules: Rule[]
  problems: string[]
}

/**
 * Characters that make a command mean more than its first words.
 *
 * `*` and `?` are included because the shell expands them: a rule for
 * `rm -rf /tmp/scratch/*` would otherwise also cover whatever the glob matches.
 */
const SHELL_OPERATORS = [';', '&', '|', '<', '>', '`', '$', '(', ')', '{', '}', '\\', '*', '?', '\n', '\r']

/**
 * The first shell operator in a command, or `undefined` when it has none.
 * @param command - the command string.
 * @returns the operator that makes the command unsafe to match, if any.
 */
export function operatorIn(command: string): string | undefined {
  for (const operator of SHELL_OPERATORS) {
    if (command.includes(operator)) return operator
  }
  return undefined
}

/**
 * Separators that split one command into several.
 *
 * These are not refusals: `cd <workspace> && npm test` is two decisions, and a
 * rule can cover each of them. Every other shell character stays a refusal,
 * because `$`, a backtick, a redirection or a glob can hide a command that no
 * rule names.
 */
const SEGMENT_SEPARATORS = /&&|\|\||[;|\n]/

/**
 * Characters that may not appear inside a segment, whatever the rules say.
 *
 * `(` and `{` are here for the same reason as `$`: a subshell or brace group
 * runs whatever is inside it, so a segment carrying one is not the command its
 * first words claim.
 */
const SEGMENT_FORBIDDEN = ['<', '>', '`', '$', '*', '?', '\\', '(', ')', '{', '}']

/**
 * Whether a segment is simple enough to be decided by its first words.
 * @param segment - one shell segment.
 * @returns `false` when the segment can hide a command.
 */
export function segmentUsable(segment: string): boolean {
  return !SEGMENT_FORBIDDEN.some(character => segment.includes(character))
}

/** A command that passed, and the rule that decided it. */
export interface CommandMatch {
  /** The rule that answered. */
  rule: Rule
  /** `whole` when the whole command was the prefix, `segment` when every part was covered. */
  via: 'whole' | 'segment'
  /** The segments, when the match was segment-wise. */
  segments?: string[]
}

/**
 * Split a command into the parts a shell would run in sequence.
 * @param command - the command string.
 * @returns the trimmed, non-empty segments.
 */
export function segmentsOf(command: string): string[] {
  return command.split(SEGMENT_SEPARATORS).map(segment => segment.trim()).filter(segment => segment !== '')
}

/**
 * The first rule that covers a command, either whole or segment by segment.
 *
 * A whole-command match is the strict case the rules file documents. The
 * segment path exists because that strict case is not what a session actually
 * runs: of 148 approval asks recorded in this repository's session logs, 147
 * were composite commands and exactly one had no shell operator at all. A
 * prefix rule that only understood the second kind would answer no prompts.
 *
 * Safety is preserved by an all-or-nothing rule: if any segment has no rule, or
 * if any segment contains a character that can hide a command, the whole
 * command is refused and the user is asked. The set of things that can run
 * without asking is therefore exactly the set of segments the user wrote rules
 * for - never a superset.
 *
 * @param rules - parsed rules, in file order.
 * @param tool - the tool the approval request names.
 * @param command - the command the pending call carries.
 * @returns the deciding rule, or `undefined` when the command must be asked about.
 */
export function matchCommand(rules: readonly Rule[], tool: string, command: string): CommandMatch | undefined {
  const whole = matchRule(rules, tool, command)
  if (whole !== undefined) return { rule: whole, via: 'whole' }

  const segments = segmentsOf(command)
  if (segments.length < 2) return undefined
  const matched: Rule[] = []
  for (const segment of segments) {
    if (!segmentUsable(segment)) return undefined
    const rule = matchRule(rules, tool, segment)
    if (rule === undefined) return undefined
    matched.push(rule)
  }
  return { rule: matched[0], via: 'segment', segments }
}

/**
 * Parse a rules file.
 *
 * Accepts either `{ "rules": [ … ] }` or a bare array. An unreadable file is
 * the caller's problem, but a parseable file with unusable entries returns
 * them as problems rather than throwing: one typo must not disable the rules
 * that are fine.
 *
 * @param text - the file's contents.
 * @returns the usable rules and a description of each rejected entry.
 */
export function parseRules(text: string): RuleSet {
  const problems: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { rules: [], problems: [`not JSON: ${(error as Error).message}`] }
  }

  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { rules?: unknown }).rules)
      ? (parsed as { rules: unknown[] }).rules
      : undefined
  if (list === undefined) {
    return { rules: [], problems: ['expected an array, or an object with a "rules" array'] }
  }

  const rules: Rule[] = []
  for (const [index, entry] of list.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`rule ${index}: not an object`)
      continue
    }
    const { tool, prefix, field } = entry as { tool?: unknown, prefix?: unknown, field?: unknown }
    if (typeof tool !== 'string' || tool.trim() === '') {
      problems.push(`rule ${index}: "tool" must be a non-empty string`)
      continue
    }
    if (typeof prefix !== 'string' || prefix.trim() === '') {
      problems.push(`rule ${index}: "prefix" must be a non-empty string`)
      continue
    }
    if (field !== undefined && (typeof field !== 'string' || field.trim() === '')) {
      problems.push(`rule ${index}: "field" must be a non-empty string when present`)
      continue
    }
    const trimmed = prefix.trim()
    const operator = operatorIn(trimmed)
    if (operator !== undefined) {
      // A prefix containing an operator can never match, because a matching
      // command may not contain one. Say so instead of leaving a dead rule.
      problems.push(`rule ${index}: prefix contains ${JSON.stringify(operator)}, so it can never match`)
      continue
    }
    rules.push({ tool, prefix: trimmed, ...(field === undefined ? {} : { field }) })
  }
  return { rules, problems }
}

/**
 * The first rule that covers a command, or `undefined` when none does.
 * @param rules - parsed rules, in file order.
 * @param tool - the tool the approval request names.
 * @param command - the command the pending call carries.
 * @returns the matching rule.
 */
export function matchRule(rules: readonly Rule[], tool: string, command: string): Rule | undefined {
  if (operatorIn(command) !== undefined) return undefined
  for (const rule of rules) {
    if (rule.tool !== tool) continue
    if (command === rule.prefix) return rule
    if (command.startsWith(`${rule.prefix} `)) return rule
  }
  return undefined
}

/**
 * The command a pending call carries, from its serialized arguments.
 * @param argumentsJson - the `tool/call` event's `arguments` string.
 * @param field - the argument to read.
 * @returns the string value, or `undefined` when it is absent or not a string.
 */
export function commandFrom(argumentsJson: string, field: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = (parsed as Record<string, unknown>)[field]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
