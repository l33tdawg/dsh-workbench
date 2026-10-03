#!/usr/bin/env node
/**
 * Apply, check, or revert the MCP tool-catalog reuse change against a DSH
 * checkout.
 *
 *   node patches/mcp-catalog-reuse.mjs <checkout> [--check | --revert]
 *
 * The change ships as a portable git patch, so git verifies every hunk's
 * context and line counts rather than this script asserting hand-written
 * anchors. Applying to a tree that already carries the change is a clean
 * no-op; `--revert` restores the pre-change tree.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PATCH = join(dirname(fileURLToPath(import.meta.url)), 'mcp-catalog-reuse.patch')

/** Revision this patch was cut against. A moved checkout only warns. */
const BASE_REVISION = '3e6ed5f11faefb3553ba3f6dfb5741346454c9f3'

/** Run git in the checkout and return stdout; non-zero exits throw. */
function git(checkout, args) {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' })
}

/** Whether `git apply` accepts `args` against the checkout. A rejected probe is
 * the answer, not a failure, so its stderr is discarded. */
function applies(checkout, args) {
  try {
    execFileSync('git', ['-C', checkout, 'apply', '--check', ...args, PATCH], { stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

const [checkoutArg, mode, ...rest] = process.argv.slice(2)
if (checkoutArg === undefined || rest.length > 0 || (mode !== undefined && !['--check', '--revert'].includes(mode))) {
  console.error('usage: node patches/mcp-catalog-reuse.mjs <checkout> [--check | --revert]')
  process.exit(2)
}

const checkout = checkoutArg
const head = git(checkout, ['rev-parse', 'HEAD']).trim()
if (head !== BASE_REVISION) {
  console.warn(`note: checkout is at ${head.slice(0, 10)}, patch was cut against ${BASE_REVISION.slice(0, 10)}`)
}

const alreadyApplied = applies(checkout, ['--reverse'])
const appliesCleanly = applies(checkout, [])

if (mode === '--check') {
  console.log(alreadyApplied ? 'applied' : appliesCleanly ? 'applies cleanly' : 'does not apply')
  process.exit(alreadyApplied || appliesCleanly ? 0 : 1)
}

if (mode === '--revert') {
  if (!alreadyApplied) {
    console.log('not applied — nothing to revert')
    process.exit(0)
  }
  git(checkout, ['apply', '--reverse', PATCH])
  console.log('reverted')
  process.exit(0)
}

if (alreadyApplied) {
  console.log('already applied — no change')
  process.exit(0)
}
if (!appliesCleanly) {
  console.error('the patch does not apply to this checkout; nothing was written')
  process.exit(1)
}
git(checkout, ['apply', PATCH])
console.log(`applied against ${head.slice(0, 10)}`)
