#!/usr/bin/env node
/**
 * Mount the four `cordis` preset skills from a real directory, and close the
 * stale preset note in the desktop profile.
 *
 * WHY. The `cordis` agent preset inserts `@deepseek-ai/dsh-skill-filesystem` with
 * `customSkillDirs` pointing at `@deepseek-ai/dsh-agent-preset/skills` *inside*
 * `app.asar`. The harness's own file service throws on any path inside the
 * archive (`Cannot mix BigInt and other types`, measured 2026-10-02 against
 * 0.2.0-rc.2, both in this session's `read` tool and through the provider's
 * `fs.resolve`). `discoverRoot` has no per-root guard and `list()` rejects as a
 * whole, so that one unreadable root costs every filesystem skill: the four
 * bundled skills, the project's `.dsh/skills`, and `~/.agents/skills`. Only
 * `@deepseek-ai/dsh-skill-office`, a different provider, still answers.
 *
 * WHAT IT WRITES. A second, independent provider row - `skill-filesystem-pack` -
 * whose `customSkillDirs` is `patches/cordis-skills`, a real directory kept in
 * step with the archive by `patches/cordis-skills-sync.mjs`. A separate row
 * rather than an override of the preset's row: a row inserted by the agent
 * preset sits in that preset's scope, and whether a profile-layer override
 * reaches it is not known here, while providers are independent and the skills
 * service skips a failing provider without dropping the others. Default roots
 * stay on, so the project and `~/.agents` skills come back too. The preset's
 * own row is left alone: it still logs one warning per catalog read.
 *
 * It also replaces the profile note that says to restore the commented
 * `agent-preset-registry` block once a real session has checked the preset. That
 * check has now happened (session-9292c643 mounted `cordis` and gained exactly
 * the three tool rows), and restoring the block would be actively harmful: the
 * settings row already selects the preset, and a second live
 * `agent-preset-registry` row makes `patches/enable-cordis-preset.mjs` refuse its
 * own anchor assertion ("expected exactly one live agent-preset-registry row").
 * The note is rewritten with what was measured instead of being deleted, so the
 * next reader does not re-add it.
 *
 * RUN THIS WITH DSH QUIT. Editing the profile's patch layer while DSH is running
 * is the confirmed trigger for the upstream defect that rebuilds the plugin tree
 * under live sessions and strands their tools (discussion #8635). Without
 * `--force` this refuses while DSH looks like it is running.
 *
 * SUPERSEDED by `enable-cordis-skill-root.mjs`, which repairs the preset's own
 * row instead of adding a second provider for it, and retires the row this
 * script writes. This script stays the owner of that row's text: the successor
 * runs it in apply mode to put the row back on `--revert`. Its own `--revert`
 * refuses today, because the BEGIN/END markers now enclose three unrelated
 * overrides and the block is no longer byte-identical to what this script writes
 * (verified 2026-10-02); remove the extra lines by hand first if it must run.
 *
 * Usage:
 *   node enable-cordis-skills.mjs [--check] [--revert] [--force] [profile]
 *
 *   (no flags)  insert the row and rewrite the note
 *   --revert    remove the row and restore the original note
 *   --check     report both, change nothing (exit 1 when a change is pending)
 *
 * The default profile patch layer is $HOME/.dsh/profiles/desktop/cordis.patch.yml.
 *
 * @module dsh-enable-cordis-skills
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const positional = args.filter(a => !a.startsWith('--'))

/** The profile patch layer this edits. */
const PROFILE = positional[0] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

/** The vendored copy the new row points at. */
const SKILLS_DIR = join(HERE, 'cordis-skills')

/** The four skills the row must be able to serve. */
const SKILL_NAMES = ['agent-experience', 'cordis-composition-reference', 'cordis-plugin-development', 'editing-cordis-compositions']

/** Row id, unique in the tree; the preset's own row is `skill-filesystem`. */
const ROW_ID = 'skill-filesystem-pack'
const MARK_BEGIN = `# BEGIN ${ROW_ID}`
const MARK_END = `# END ${ROW_ID}`

/**
 * The note as it stands today, byte for byte, from the desktop profile. The
 * script asserts this before replacing it, so a profile that has moved on fails
 * loudly instead of being half-rewritten.
 */
const NOTE_STALE = `# The default agent preset was switched to \`cordis\` here, and then removed again.
# \`cordis\` is \`standard\` plus the cordis_inspect tools and the bundled
# plugin-development skills, which is what an agent modifying DSH needs. It also
# enables the profile plugin manager, which is more authority than \`standard\`
# grants.
#
# It is commented out rather than deleted because the switch was never verified
# with a real session: its composition boots cleanly, but no session was created
# under it. Restore the block below once that is checked, rather than assuming a
# clean boot means a clean session.
#
# - id: agent-preset-registry
#   name: '@deepseek-ai/dsh-agent-preset-registry'
#   config:
#     default: cordis`

/** What replaces it: the measurement, and why the commented block stays out. */
const NOTE_VERIFIED = `# The default agent preset is \`cordis\`, chosen from General settings -> agent
# preset -> cordis, which writes \`selectedDefault: cordis\` on the live row below.
# Verified with a real session on 2026-10-02 (session-9292c643): the preset
# mounted, and its tool surface carried exactly three rows more than \`standard\` -
# \`cordis_inspect_list\`, \`cordis_inspect_query\` and \`plugin_manager\`.
#
# The commented \`default: cordis\` block that used to sit here is deliberately not
# restored. The settings row already selects the preset, and a second live
# \`agent-preset-registry\` row makes patches/enable-cordis-preset.mjs refuse its own
# anchor assertion ("expected exactly one live agent-preset-registry row").
#
# That session also showed the preset's \`skill-filesystem\` row failing: it points
# \`customSkillDirs\` inside app.asar, which this harness's file service cannot
# read, and one unreadable root drops every filesystem skill root. The
# \`${ROW_ID}\` row below restores them from patches/cordis-skills.`

/** Whether DSH looks like it is running, so the #8635 hazard can be refused. */
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

/** Occurrences of a literal in a text. */
const countOf = (text, needle) => text.split(needle).length - 1

/** The row block, as appended at the end of the patch layer. */
function rowBlock() {
  return [
    "# The `cordis` preset's own `skill-filesystem` row points its `customSkillDirs`",
    '# inside app.asar, which this harness cannot read; that failure drops every',
    '# filesystem skill root. This independent row serves the four bundled skills',
    '# from a real directory and rescans the default roots. Managed by',
    '# patches/enable-cordis-skills.mjs - remove with --revert.',
    MARK_BEGIN,
    '- insert:',
    `    - id: ${ROW_ID}`,
    "      name: '@deepseek-ai/dsh-skill-filesystem'",
    '      config:',
    '        providerName: filesystem-pack',
    '        includeDefaultRoots: true',
    '        customSkillDirs:',
    `          - ${SKILLS_DIR}`,
    MARK_END,
  ].join('\n')
}

if (!existsSync(PROFILE)) {
  console.error(`no such profile patch layer: ${PROFILE}`)
  process.exit(1)
}

const missingSkills = SKILL_NAMES.filter(name => !existsSync(join(SKILLS_DIR, name, 'SKILL.md')))
if (missingSkills.length > 0) {
  console.error(`the vendored copy is incomplete: ${SKILLS_DIR}`)
  for (const name of missingSkills) console.error(`  missing ${name}/SKILL.md`)
  console.error('')
  console.error('Run `node patches/cordis-skills-sync.mjs` first; a row pointing at an')
  console.error('incomplete directory would only move the silent failure.')
  process.exit(1)
}

const original = readFileSync(PROFILE, 'utf8')
/**
 * The exact text appended at the end of the layer. Appending the block alone -
 * newline included, no separator of its own - is what makes revert exact: the
 * text on either side belongs to the original file and is not consumed. A layer
 * that does not end in a newline gains one, the single byte this pair does not
 * restore.
 */
const block = `${rowBlock()}\n`

const rowCount = countOf(original, MARK_BEGIN)
const endCount = countOf(original, MARK_END)
const noteStaleCount = countOf(original, NOTE_STALE)
const noteVerifiedCount = countOf(original, NOTE_VERIFIED)

if (rowCount !== endCount) {
  console.error(`${MARK_BEGIN} appears ${rowCount} time(s) but ${MARK_END} appears ${endCount}; refusing to guess`)
  process.exit(1)
}
if (rowCount > 1) {
  console.error(`${MARK_BEGIN} appears ${rowCount} times; refusing to guess which block to touch`)
  process.exit(1)
}
if (noteStaleCount > 1 || noteVerifiedCount > 1 || (noteStaleCount === 1 && noteVerifiedCount === 1)) {
  console.error('the preset note matches both the stale and the verified text; refusing to guess')
  process.exit(1)
}

const rowState = rowCount === 1 ? 'present' : 'absent'
const noteState = noteVerifiedCount === 1 ? 'verified' : noteStaleCount === 1 ? 'stale' : 'neither (left alone)'

if (flag('--check')) {
  console.log(`profile : ${PROFILE}`)
  console.log(`row     : ${ROW_ID} ${rowState}`)
  console.log(`note    : ${noteState}`)
  const pending = flag('--revert') ? rowState === 'present' || noteState === 'verified' : rowState === 'absent' || noteState === 'stale'
  console.log(pending ? 'RESULT: would change' : 'RESULT: already in the requested state')
  process.exit(pending ? 1 : 0)
}

const reverting = flag('--revert')
const rowPending = reverting ? rowState === 'present' : rowState === 'absent'
const notePending = reverting ? noteState === 'verified' : noteState === 'stale'

if (!rowPending && !notePending) {
  console.log(reverting ? 'already reverted; nothing to do' : 'already applied; nothing to do')
  process.exit(0)
}

if (!flag('--force') && dshRunning()) {
  console.error('DSH appears to be running.')
  console.error('')
  console.error('Editing this file while DSH runs triggers the profile-reload defect (#8635):')
  console.error('the plugin tree is rebuilt under live sessions and their preset-scoped')
  console.error('tools stop resolving until a restart.')
  console.error('')
  console.error('Quit DSH and re-run, or pass --force if you accept that.')
  process.exit(1)
}

let next = original
if (rowPending) {
  if (reverting) {
    // Refuse anything but the exact text this script writes, rather than guess
    // at boundaries in a file someone may have edited since.
    if (!next.includes(block)) {
      console.error(`the ${ROW_ID} block is not byte-identical to what this script writes`)
      console.error('remove it by hand between the BEGIN and END markers, then re-run')
      process.exit(1)
    }
    next = next.replace(block, '')
  } else {
    next = (next.endsWith('\n') ? next : `${next}\n`) + block
  }
}
if (notePending) next = next.replace(reverting ? NOTE_VERIFIED : NOTE_STALE, reverting ? NOTE_STALE : NOTE_VERIFIED)

// Post-write assertions on the text that is about to land.
const nextRowCount = countOf(next, MARK_BEGIN)
const nextNoteCount = countOf(next, reverting ? NOTE_STALE : NOTE_VERIFIED)
if (nextRowCount !== (reverting ? 0 : 1)) {
  console.error(`rewrite did not produce the expected row state (found ${nextRowCount}); refusing to write`)
  process.exit(1)
}
if (nextNoteCount !== 1) {
  console.error(`rewrite did not produce the expected note state (found ${nextNoteCount}); refusing to write`)
  process.exit(1)
}
if (!next.includes('- id: agent-preset-registry') || !next.includes('- id: session-log-deepseek')) {
  console.error('the rewrite lost a row this script does not manage; refusing to write')
  process.exit(1)
}

/** Re-parse with a YAML parser when one is installed, so a syntax slip cannot reach boot. */
async function yamlCheck(text) {
  let parse
  try {
    ({ parse } = await import('yaml'))
  } catch {
    return 'skipped (no `yaml` module installed)'
  }
  const doc = parse(text)
  if (!Array.isArray(doc)) return 'FAILED: the patch layer is not a top-level array'
  const rows = doc.filter(entry => Array.isArray(entry?.insert)).flatMap(entry => entry.insert)
  const mine = rows.filter(entry => entry?.id === ROW_ID)
  if (reverting) return mine.length === 0 ? 'ok (row absent)' : `FAILED: ${mine.length} row(s) still parse`
  if (mine.length !== 1) return `FAILED: ${mine.length} row(s) parse`
  const dirs = mine[0]?.config?.customSkillDirs
  if (!Array.isArray(dirs) || dirs[0] !== SKILLS_DIR) return `FAILED: customSkillDirs did not parse as ${SKILLS_DIR}`
  return 'ok (array, row present, path intact)'
}

const yaml = await yamlCheck(next)
if (yaml.startsWith('FAILED')) {
  console.error(yaml)
  console.error('refusing to write')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = `${PROFILE}.bak-cordisskills-${stamp}`
copyFileSync(PROFILE, backup)
writeFileSync(PROFILE, next)

console.log(`row     : ${ROW_ID} ${rowState} -> ${reverting ? 'absent' : 'present'}${rowPending ? '' : ' (unchanged)'}`)
console.log(`note    : ${noteState} -> ${reverting ? 'stale' : 'verified'}${notePending ? '' : ' (unchanged)'}`)
console.log(`yaml    : ${yaml}`)
console.log(`profile : ${PROFILE}`)
console.log(`backup  : ${backup}`)
console.log(`skills  : ${SKILLS_DIR}`)
console.log('')
console.log('restart DSH for this to take effect, then start a NEW session (a preset is')
console.log('fixed at session start) and ask an agent to load one of the four skills.')
