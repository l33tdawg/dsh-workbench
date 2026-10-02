#!/usr/bin/env node
/**
 * Measure the share of a DSH request occupied by tool definitions.
 *
 * Codex loads tool definitions on demand; DSH sends all of them on every
 * request. Whether that is worth fixing is a byte question, not a taste
 * question, so this reads the answer off the durable session log instead of
 * estimating it.
 *
 * The log records the tool surface verbatim: `request/header` carries
 * `data.header.tools`, the exact serialised tool array the adapter was given,
 * and it is written whenever that surface is set or changed. Every model call
 * is anchored by an `assistant/message` carrying provider usage. Walking the
 * records in order therefore reconstructs, for each call, the tools in force,
 * the system prompt, and the conversation that preceded it. Three shares
 * follow:
 *
 *   preamble  tools / (tools + system). Conversation-independent, so the same
 *             on the first call of a session as on the last: this is the floor
 *             that no amount of conversation dilutes.
 *   request   tools / (tools + system + conversation so far). What the model
 *             actually saw, which decays as a conversation grows because the
 *             tool block is a constant and the conversation is not.
 *   window    the tool block against the model's context window, taken from
 *             the recorded `request/context`. Token figures are scaled from
 *             the provider's own prompt count, so they are estimates of a
 *             measured total rather than a characters-over-four guess.
 *
 * A count is not a cost, and a share of the wrong denominator is not either,
 * so all three are printed.
 *
 * Usage:
 *   node tool-budget.mjs [--root <sessions dir>] [--json] [--verbose]
 *
 * @module dsh-tool-budget
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSession, parseSession } from './session-audit.mjs'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

const ROOT = value('--root') ?? join(process.env.HOME ?? '', '.dsh', 'sessions')
const AS_JSON = flag('--json')
const VERBOSE = flag('--verbose')

const bytes = value => (value === undefined ? 0 : JSON.stringify(value).length)

/**
 * Every model call in one session, with the tool surface in force at that call.
 *
 * @param records - the session's parsed records.
 * @returns per-call rows, the widest surface seen, and the recorded context window.
 */
export function budget(records) {
  const calls = []
  let surface
  let systemChars = 0
  let messagesChars = 0
  let contextWindow = 0

  for (const record of records) {
    switch (record?.type) {
      case 'request/context':
        contextWindow = record.data?.contextWindow ?? contextWindow
        break
      case 'request/header':
        surface = record.data?.header?.tools ?? []
        break
      case 'system/message':
        systemChars = bytes(record.data?.message)
        break
      case 'user/message':
        // A user turn records its blocks under `content`; there is no
        // `message` field to read, and counting it as absent understates every
        // request by the size of the turn.
        messagesChars += bytes(record.data?.content)
        break
      case 'tool/result':
        messagesChars += bytes(record.data?.message)
        break
      case 'assistant/message': {
        // The call is answered by this record, so it is measured against the
        // conversation as it stood before the record's own bytes are added.
        const usage = record.data?.usage
        const promptTokens = usage === undefined
          ? undefined
          : (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        if (surface !== undefined && promptTokens !== undefined && promptTokens > 0) {
          const tools = surface
          const toolsChars = bytes(tools)
          const mcpChars = bytes(tools.filter(tool => String(tool?.name ?? '').startsWith('mcp__')))
          const requestChars = toolsChars + systemChars + messagesChars
          calls.push({
            seq: record.seq,
            toolCount: tools.length,
            toolsChars,
            mcpChars,
            systemChars,
            messagesChars,
            requestChars,
            promptTokens,
            toolsShare: requestChars === 0 ? 0 : toolsChars / requestChars,
            preambleShare: toolsChars + systemChars === 0 ? 0 : toolsChars / (toolsChars + systemChars),
            // The provider counted the prompt; the chars are this tool's own
            // reconstruction of the same content, so their ratio scales the
            // tool block into the measured total.
            toolsTokens: requestChars === 0 ? 0 : (promptTokens * toolsChars) / requestChars,
          })
        }
        messagesChars += bytes(record.data?.message)
        break
      }
      default:
        break
    }
  }

  const widest = calls.reduce((best, call) => (best === undefined || call.toolsChars > best.toolsChars ? call : best), undefined)
  return { calls, widest, contextWindow }
}

/** Every session file under a root. */
function sessions(root) {
  const found = []
  const walk = dir => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.v4.jsonl.zstd') {
        try {
          found.push({ path, size: statSync(path).size })
        } catch {
          // Removed between listing and stat.
        }
      }
    }
  }
  walk(root)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

/** The middle value of a sample. */
const median = values => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The value a fraction of the way through a sorted sample. */
const at = (values, fraction) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]
}

const pct = n => `${(100 * n).toFixed(1)}%`
const num = n => Math.round(n).toLocaleString('en-US')

function main() {
  const files = sessions(ROOT)
  if (files.length === 0) {
    console.error(`no sessions under ${ROOT}`)
    process.exit(2)
  }

  const perSession = []
  const allCalls = []
  for (const file of files) {
    let measured
    try {
      measured = budget(parseSession(readSession(file.path)))
    } catch (error) {
      if (VERBOSE) console.error(`skip ${file.path}: ${error.message}`)
      continue
    }
    if (measured.widest === undefined) continue
    allCalls.push(...measured.calls)
    perSession.push({ id: file.path.split('/').slice(-2)[0], ...measured })
  }

  if (perSession.length === 0) {
    console.error(`no measured model calls under ${ROOT}`)
    process.exit(2)
  }

  const widest = perSession.map(session => session.widest)
  const share = perSession.map(session => median(session.calls.map(call => call.toolsShare)))
  const window = median(perSession.map(session => session.contextWindow))

  if (AS_JSON) {
    console.log(JSON.stringify({
      root: ROOT,
      sessions: perSession.length,
      calls: allCalls.length,
      contextWindow: window,
      rows: perSession.map(session => ({
        id: session.id,
        calls: session.calls.length,
        toolCount: session.widest.toolCount,
        toolsChars: session.widest.toolsChars,
        mcpChars: session.widest.mcpChars,
        systemChars: session.widest.systemChars,
        preambleToolsShare: session.widest.preambleShare,
        medianToolsShare: median(session.calls.map(call => call.toolsShare)),
        medianToolsTokens: median(session.calls.map(call => call.toolsTokens)),
        lastPromptTokens: session.calls[session.calls.length - 1]?.promptTokens,
      })),
    }, null, 2))
    return
  }

  console.log(`sessions analysed: ${perSession.length}`)
  console.log(`model calls:       ${num(allCalls.length)}`)
  console.log(`context window:    ${num(window)} tokens (recorded per session)`)
  console.log()
  console.log('the tool block, as sent in the request header')
  console.log(`  median   ${num(median(widest.map(call => call.toolsChars))).padStart(9)} chars  over ${median(widest.map(call => call.toolCount))} tools  (${num(median(widest.map(call => call.toolsTokens)))}) est. tokens`)
  console.log(`  largest  ${num(Math.max(...widest.map(call => call.toolsChars))).padStart(9)} chars  over ${Math.max(...widest.map(call => call.toolCount))} tools`)
  console.log(`  mcp__* share of the tool block:     ${pct(median(widest.map(call => call.mcpChars / call.toolsChars))).padStart(6)} median session`)
  console.log(`  tools vs system prompt (preamble):  ${pct(median(widest.map(call => call.preambleShare))).padStart(6)} median session`)
  console.log(`  share of the context window:        ${pct(median(widest.map(call => call.toolsTokens)) / window).padStart(6)}`)
  console.log()
  console.log(`share of a real request (tools + system + conversation), over ${num(allCalls.length)} calls`)
  console.log(`  p10      ${pct(at(allCalls.map(call => call.toolsShare), 0.1)).padStart(6)}`)
  console.log(`  median   ${pct(median(allCalls.map(call => call.toolsShare))).padStart(6)}`)
  console.log(`  p90      ${pct(at(allCalls.map(call => call.toolsShare), 0.9)).padStart(6)}`)
  console.log(`  median of per-session medians:      ${pct(median(share)).padStart(6)}`)
  console.log()
  console.log('per session (largest tool block first)')
  const shown = [...perSession].sort((a, b) => b.widest.toolsChars - a.widest.toolsChars)
  for (const session of shown.slice(0, VERBOSE ? shown.length : 10)) {
    console.log(`  ${num(session.widest.toolsChars).padStart(9)} chars  ${String(session.widest.toolCount).padStart(3)} tools  ${pct(median(session.calls.map(call => call.toolsShare))).padStart(6)} of request  ${String(session.calls.length).padStart(5)} calls  ${session.id}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
