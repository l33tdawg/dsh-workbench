#!/usr/bin/env node
/**
 * Assert that named Loader entries are enabled and active.
 *
 * `plugin_manager list_plugins` is a tool call, not a shell command, so this
 * takes its JSON output over stdin and checks the rows in it. That keeps the
 * verification on the same surface a user sees, rather than reading the profile
 * files and inferring what the Loader did with them — an entry can be present in
 * `package.json` and still be inactive, which is exactly the failure a check like
 * this should catch.
 *
 * Paste the tool result, or pipe several pages concatenated:
 *
 *   node tools/check-plugin-rows.mjs include:compaction-basic include:command-compact < rows.json
 *
 * Exit 0 when every named row is enabled and active; exit 1 with the row's
 * actual state otherwise.
 *
 * @module tools/check-plugin-rows
 */

import { readFileSync } from 'node:fs'

const wanted = process.argv.slice(2)
if (wanted.length === 0) {
  console.error('usage: node tools/check-plugin-rows.mjs <entryId> [entryId...] < rows.json')
  process.exit(2)
}

const stdin = readFileSync(0, 'utf8')

/**
 * Every complete JSON object in a text, in order.
 *
 * Pages may be pretty-printed or compact, and pasting two of them concatenates
 * them with nothing between the closing and opening braces, so splitting on line
 * boundaries misses the compact case. Braces inside strings are ignored, which a
 * tool description containing `{}` would otherwise break.
 *
 * @param text - the pasted output.
 * @returns each parsed object that stands alone.
 */
function parseObjects(text) {
  const found = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (char === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        try {
          found.push(JSON.parse(text.slice(start, index + 1)))
        } catch {
          // A page that does not stand alone is reported as missing rows.
        }
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return found
}

/** Every entry across every pasted page, keyed by entry id. */
const entries = new Map()
for (const page of parseObjects(stdin)) {
  for (const entry of page.entries ?? []) entries.set(entry.entryId, entry)
}

let failed = 0
for (const id of wanted) {
  const entry = entries.get(id)
  if (entry === undefined) {
    console.log(`MISSING  ${id}  (not in the supplied pages)`)
    failed++
    continue
  }
  const ok = entry.enabled === true && entry.fiberPhase === 'active'
  console.log(`${ok ? 'ok      ' : 'FAIL    '} ${id}  enabled=${String(entry.enabled)} fiberPhase=${String(entry.fiberPhase)} patchId=${String(entry.patchId)}`)
  if (!ok) failed++
}

console.log(`\n${wanted.length - failed} of ${wanted.length} row(s) enabled and active`)
process.exit(failed === 0 ? 0 : 1)
