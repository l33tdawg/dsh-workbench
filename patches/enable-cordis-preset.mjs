#!/usr/bin/env node
/**
 * Switch the desktop profile's default agent preset between `standard` and
 * `cordis`.
 *
 * `cordis` is `standard` plus three rows, verified by diffing the shipped preset
 * declarations rather than trusting a summary:
 *
 *   tool-cordis          added    cordis_inspect_list / cordis_inspect_query
 *   skill-filesystem     changed  customSkillDirs -> the four bundled skills
 *   tool-plugin-manager  changed  disabled: true -> !ctx.get('profileContext')
 *
 * The persona and every other row are identical.
 *
 * RUN THIS WITH DSH QUIT. Editing the profile's patch layer while DSH is running
 * is the confirmed trigger for an upstream defect that rebuilds the plugin tree
 * under a live session and strands its tools: `bash`, `read`, `edit`, `write`,
 * `glob`, and `grep` all start returning unknown-tool errors until a restart.
 * This script warns if it thinks DSH is running and refuses without --force.
 *
 * Usage:
 *   node enable-cordis-preset.mjs [--check] [--revert] [--force] [profile]
 *
 *   (no flags)  switch the default to `cordis`
 *   --revert    switch it back to `standard`
 *   --check     report which one is set and change nothing
 *
 * The default profile is $HOME/.dsh/profiles/desktop/cordis.patch.yml.
 *
 * @module dsh-enable-cordis-preset
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const positional = args.filter(a => !a.startsWith('--'))

/** The profile patch layer this edits. */
const PROFILE = positional[0] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

/** The live registry row, uncommented. Used to prove the anchor exists exactly once. */
const LIVE_ROW = /^- id: agent-preset-registry$/m

/**
 * The stale comment block left behind when the switch was reverted. The note
 * says to restore it once a real session has checked it, so this script is the
 * thing that carries that out.
 */
const STALE_NOTE = /# The default agent preset was switched to `cordis` here[\s\S]*?#     default: cordis\n/

/** The note written when `cordis` is the default. */
const CORDIS_NOTE = `# The default agent preset is \`cordis\`: \`standard\` plus the
# \`cordis_inspect_list\` / \`cordis_inspect_query\` tools and the four skills
# bundled with \`@deepseek-ai/dsh-agent-preset\`.
#
# It also enables \`tool-plugin-manager\` whenever a profile context exists, which
# is the ability to install or remove bundles from this profile from inside a
# session. That is more authority than \`standard\` grants and was accepted
# deliberately, not inherited by accident.
#
# To go back to \`standard\`:
#   node patches/enable-cordis-preset.mjs --revert
`

/** The note written when `standard` is the default. */
const STANDARD_NOTE = `# The default agent preset is \`standard\`. \`cordis\` is \`standard\`
# plus the harness's own introspection tools and its four bundled skills, which
# is what an agent modifying DSH itself needs.
#
# To switch it on:
#   node patches/enable-cordis-preset.mjs
`

/** Which preset the file currently selects, or undefined when neither is set. */
function currentPreset(text) {
  const live = text.slice(text.search(LIVE_ROW))
  if (/^\s*default: cordis$/m.test(live)) return 'cordis'
  if (/^\s*default: standard$/m.test(live)) return 'standard'
  return undefined
}

/** Whether DSH looks like it is running, so the 8635 hazard can be refused. */
function dshRunning() {
  try {
    const out = execFileSync('pgrep', ['-fil', 'DeepSeek Harness'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().length > 0
  } catch {
    // pgrep exits non-zero when nothing matches, which is the ordinary case.
    // Any other failure leaves this unknown rather than claiming DSH is up.
    return false
  }
}

if (!existsSync(PROFILE)) {
  console.error(`no such profile patch layer: ${PROFILE}`)
  process.exit(1)
}

const original = readFileSync(PROFILE, 'utf8')
const found = currentPreset(original)
const want = flag('--revert') ? 'standard' : 'cordis'

if (found === undefined) {
  console.error('this file has no live `- id: agent-preset-registry` row with a `default:` value')
  console.error('refusing to guess. Inspect it and re-run.')
  process.exit(1)
}

if (flag('--check')) {
  console.log(`profile : ${PROFILE}`)
  console.log(`current : ${found}`)
  console.log(`desired : ${want}`)
  console.log(found === want ? 'RESULT: already set' : 'RESULT: would change')
  process.exit(found === want ? 0 : 1)
}

if (found === want) {
  console.log(`already ${want}; nothing to do`)
  process.exit(0)
}

if (!flag('--force') && dshRunning()) {
  console.error('DSH appears to be running.')
  console.error('')
  console.error('Editing this file while DSH runs triggers the profile-reload defect:')
  console.error('the plugin tree is rebuilt under live sessions and their preset-scoped')
  console.error('tools (bash, read, edit, write, glob, grep) stop resolving until a restart.')
  console.error('')
  console.error('Quit DSH and re-run, or pass --force if you accept that.')
  process.exit(1)
}

// Anchor assertions. A patch layer that has moved on must fail loudly rather
// than be half-rewritten.
const liveCount = original.match(/^- id: agent-preset-registry$/gm)?.length ?? 0
if (liveCount !== 1) {
  console.error(`expected exactly one live agent-preset-registry row, found ${liveCount}`)
  process.exit(1)
}
const staleCount = original.match(new RegExp(STALE_NOTE.source, 'g'))?.length ?? 0
if (staleCount > 1) {
  console.error(`expected at most one stale preset note, found ${staleCount}`)
  process.exit(1)
}

const next = want === 'cordis'
  ? original
    .replace(STALE_NOTE, '')
    .replace(/(^- id: agent-preset-registry$[\s\S]*?^\s*default: )standard$/m, `$1cordis`)
    .replace(/(^- id: agent-preset-registry$)/m, `${CORDIS_NOTE}$1`)
  : original
    .replace(/(^- id: agent-preset-registry$[\s\S]*?^\s*default: )cordis$/m, `$1standard`)
    .replace(/(^- id: agent-preset-registry$)/m, `${STANDARD_NOTE}$1`)

if (currentPreset(next) !== want) {
  console.error(`rewrite did not produce ${want}; refusing to write`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = `${PROFILE}.bak-preset-${stamp}`
copyFileSync(PROFILE, backup)
writeFileSync(PROFILE, next)

console.log(`preset  : ${found} -> ${want}`)
console.log(`profile : ${PROFILE}`)
console.log(`backup  : ${backup}`)
console.log('')
console.log('restart DSH for this to take effect.')
