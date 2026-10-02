#!/usr/bin/env node
/**
 * Syntax-check every plain-JavaScript file in this repo.
 *
 * The packages here are TypeScript-flavoured but written as plain JS with JSDoc,
 * and most of the tooling that makes mistakes in them is `tools/*.mjs` and
 * `patches/*.mjs`. Those files have no build step, so a syntax error only shows
 * up when something tries to run them.
 *
 * Output is deliberately in tsc's `path(line,col): error CODE: message` form so
 * a harness check parser can attribute a failure to a file, which is what makes
 * this useful to `dsh-verify-on-edit` as well as to a human.
 *
 * @module tools/syntax-check
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Directories to walk for `.mjs` files, relative to the repo root. */
const DIRECTORIES = ['tools', 'patches']

/**
 * Every `.mjs` file under a directory, recursively.
 * @param dir - absolute directory to walk.
 * @returns absolute file paths.
 */
function filesUnder(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'verify') continue
      found.push(...filesUnder(path))
    } else if (entry.name.endsWith('.mjs')) {
      found.push(path)
    }
  }
  return found
}

let checked = 0
let failed = 0

for (const directory of DIRECTORIES) {
  const absolute = join(ROOT, directory)
  try {
    if (!statSync(absolute).isDirectory()) continue
  } catch {
    continue
  }

  for (const file of filesUnder(absolute)) {
    checked++
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } catch (error) {
      failed++
      const output = `${error.stderr ?? ''}${error.stdout ?? ''}`
      // `node --check` prints `path:line`, then the message a few lines down.
      const located = /^(.*?):(\d+)\s*$/m.exec(output)
      const message = /^(\w*Error):\s*(.+)$/m.exec(output)
      const path = relative(ROOT, located?.[1] ?? file)
      const line = located?.[2] ?? '1'
      const text = message === null ? 'syntax error' : `${message[1]}: ${message[2]}`
      // tsc shape, so a harness check parser can attribute this to a file.
      console.log(`${path}(${line},1): error SYNTAX: ${text}`)
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${checked} file(s) failed to parse`)
  process.exit(1)
}
console.log(`${checked} file(s) parse cleanly`)
