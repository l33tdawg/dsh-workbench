#!/usr/bin/env node
/**
 * Repair the `cordis` preset's own `skill-filesystem` row, so the preset stops
 * losing the model-facing skill catalog.
 *
 * WHY. The shipped `cordis` preset declares its `skill-filesystem` row with
 * `customSkillDirs` pointing inside `app.asar`:
 *
 *   !!js ...createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')
 *
 * The harness file service cannot stat any path inside the archive. Under
 * Electron, `fs.stat(archivePath, { bigint: true })` returns Number stats
 * instead of BigInt ones, and `dsh-fs-local`'s `probe()` then evaluates
 * `info.mode & 511n` on them, which throws `Cannot mix BigInt and other types`
 * (measured 2026-10-02 against 0.2.0-rc.2, reproduced in isolation under
 * `ELECTRON_RUN_AS_NODE=1`). The provider's read loop has no per-root guard, so
 * that one root ends its whole `list()`, the registry marks the observation
 * incomplete, and `dsh-tool-skill` refuses to publish a catalog while any
 * provider is incomplete. The cost is the entire catalog: the model is never
 * told which skills exist, while `skill("<name>")` still loads them by name.
 *
 * WHAT IT WRITES.
 *
 *   1. One `- id: preset-cordis` override: the shipped declaration restated,
 *      with the `skill-filesystem` row's `customSkillDirs` replaced by this
 *      repository's vendored copy. Overriding a shipped preset is what the
 *      preset's own skill `editing-cordis-compositions` prescribes; an override
 *      by Loader row id replaces the complete `config`, so every field the
 *      shipped file carries is restated, generated from the installed archive
 *      rather than copied by hand. `--check` regenerates and compares, so a
 *      harness update that moves the preset is reported instead of silently
 *      diverging.
 *   2. Removal of the `skill-filesystem-pack` block that
 *      `enable-cordis-skills.mjs` wrote. That row served the same four skills
 *      from the same directory only because the preset's own row could not, so
 *      with the row repaired it is a second provider for one job. It cannot be
 *      disabled from this layer: a patch entry reaches only rows that existed
 *      before the layer was applied, so an override or a re-insert of the same
 *      id leaves the row enabled, or duplicates its id and aborts the boot
 *      (both measured 2026-10-02 with `dsh --dump-config`). That script's own
 *      `--revert` now refuses, because its markers have drifted apart around
 *      three unrelated overrides and its block is no longer byte-identical to
 *      what it writes.
 *   3. The preset note in the same file, rewritten to say what repaired the row.
 *      It is restored byte-for-byte by the same sibling run.
 *
 * RUN THIS WITH DSH QUIT. Editing the profile's patch layer while DSH is running
 * triggers the profile-reload defect that rebuilds the plugin tree under live
 * sessions and strands their tools (#8635). Without `--force` this refuses while
 * DSH looks like it is running. A preset is fixed at session start, so validate
 * in a NEW session afterwards.
 *
 * Usage:
 *   node enable-cordis-skill-root.mjs [--check] [--revert] [--force] [--print]
 *                                     [--asar <path>] [profile]
 *
 *   (no flags)  repair the row, retire the pack row, rewrite the note
 *   --check     report the current state and exit 1 when a change is pending
 *   --revert    undo all three, by way of enable-cordis-skills.mjs; the restored
 *               block lands at the end of the layer rather than in the drifted
 *               position it occupied, which `dsh --dump-config` renders
 *               byte-identical to the original composition
 *   --print     write the generated override to stdout and change nothing
 *
 * The default profile patch layer is $HOME/.dsh/profiles/desktop/cordis.patch.yml.
 *
 * @module dsh-enable-cordis-skill-root
 */

import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const valueOf = name => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--asar')

/** The installed Desktop bundle the shipped preset is read from. */
const ASAR = resolve(valueOf('--asar') ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')

/** Archive-relative path of the declaration this script restates. */
const PRESET_PATH = '/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml'

/** The profile patch layer this edits. */
const PROFILE = positional[0] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

/** The vendored copy the repaired row points at. */
const SKILLS_DIR = join(HERE, 'cordis-skills')

/** The sibling script that owns the pack row and the note. */
const SIBLING = join(HERE, 'enable-cordis-skills.mjs')

/** Row and marker identity, all unique in the tree. */
const MARK = 'cordis-skill-root'
const MARK_BEGIN = `# BEGIN ${MARK}`
const MARK_END = `# END ${MARK}`
const PRESET_ROW = 'preset-cordis'
const PRESET_NAME = '@deepseek-ai/dsh-agent-preset'
const SKILL_ROW = 'skill-filesystem'
const SKILL_NAME = '@deepseek-ai/dsh-skill-filesystem'
const PACK_ROW = 'skill-filesystem-pack'
const PACK_BEGIN = `# BEGIN ${PACK_ROW}`
const PACK_END = `# END ${PACK_ROW}`

/** The four skills the repaired row must be able to serve. */
const SKILL_NAMES = ['agent-experience', 'cordis-composition-reference', 'cordis-plugin-development', 'editing-cordis-compositions']

/**
 * The paragraph `enable-cordis-skills.mjs` leaves behind, byte for byte, and
 * what replaces it. The last sentence points at a row this script removes, so
 * leaving it would make the profile describe a provider that is no longer there.
 */
const NOTE_OLD = `# That session also showed the preset's \`skill-filesystem\` row failing: it points
# \`customSkillDirs\` inside app.asar, which this harness's file service cannot
# read, and one unreadable root drops every filesystem skill root. The
# \`skill-filesystem-pack\` row below restores them from patches/cordis-skills.`

const NOTE_NEW = `# That session also showed the preset's \`skill-filesystem\` row failing: it pointed
# \`customSkillDirs\` inside app.asar, which this harness's file service cannot
# read, and one unreadable root dropped every filesystem skill root. Repaired at
# the row itself by patches/enable-cordis-skill-root.mjs, which also retired the
# separate \`skill-filesystem-pack\` row this note used to point at.`

/**
 * Read one file out of an asar archive.
 *
 * The body of every entry starts at `8 + headerSize`, where `headerSize` is the
 * second UInt32 of the pickle header - not at `16 + jsonLength`, which is two
 * bytes early and yields a file of the right size that starts mid-JSON.
 *
 * @param path - archive-relative entry path, leading slash included.
 * @returns the entry's bytes as UTF-8 text.
 */
function readArchiveFile(path) {
  const fd = openSync(ASAR, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const dataStart = 8 + head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonLength)
    readSync(fd, json, 0, jsonLength, 16)
    const tree = JSON.parse(json.toString('utf8'))
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const full = `${prefix}/${name}`
        if (child.files) {
          const hit = walk(child, full)
          if (hit !== undefined) return hit
        } else if (full === path) {
          return child
        }
      }
      return undefined
    }
    const entry = walk(tree, '')
    if (entry === undefined) throw new Error(`the archive holds no ${path}`)
    const buf = Buffer.alloc(entry.size)
    readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset))
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Occurrences of a literal in a text. */
const countOf = (text, needle) => text.split(needle).length - 1

/** Shift one block of YAML left by `spaces`, refusing a line that would go negative. */
function shiftLeft(block, spaces) {
  return block
    .split('\n')
    .map(line => {
      if (line.trim().length === 0) return ''
      const cut = line.slice(0, spaces)
      if (cut.trim().length !== 0) throw new Error(`cannot dedent line by ${spaces}: ${JSON.stringify(line)}`)
      return line.slice(spaces)
    })
    .join('\n')
}

/**
 * Build the override block from the installed preset.
 *
 * The shipped declaration is restated verbatim except for the one row whose
 * `customSkillDirs` points inside the archive, so the generated text is a
 * function of the archive rather than a hand-copy that can drift from it.
 *
 * @param presetText - the shipped `cordis.patch.yml`.
 * @returns the override text, without markers, comments, or a trailing newline.
 */
function buildBlock(presetText) {
  const lines = presetText.split('\n')
  const rowStart = lines.findIndex(line => line === `    - id: ${PRESET_ROW}`)
  if (rowStart === -1) throw new Error(`the shipped preset has no "    - id: ${PRESET_ROW}" row`)
  if (lines.filter(line => line === `    - id: ${PRESET_ROW}`).length !== 1) throw new Error(`the shipped preset declares ${PRESET_ROW} more than once`)

  const configAt = lines.findIndex((line, at) => at > rowStart && line === '      config:')
  const pluginsAt = lines.findIndex((line, at) => at > configAt && line === '        plugins:')
  if (configAt === -1 || pluginsAt === -1) throw new Error(`the shipped ${PRESET_ROW} row has no config.plugins block`)

  const head = shiftLeft(lines.slice(rowStart, pluginsAt + 1).join('\n'), 4)
  if (!head.includes(`  name: '${PRESET_NAME}'`)) throw new Error(`the shipped ${PRESET_ROW} row does not name ${PRESET_NAME}`)
  const body = shiftLeft(lines.slice(pluginsAt + 1).join('\n'), 4)

  const bodyLines = body.split('\n')
  const skillAt = bodyLines.findIndex(line => line === `      - id: ${SKILL_ROW}`)
  if (skillAt === -1) throw new Error(`the shipped plugins list has no "      - id: ${SKILL_ROW}" row`)
  if (bodyLines.filter(line => line === `      - id: ${SKILL_ROW}`).length !== 1) throw new Error(`the shipped plugins list declares ${SKILL_ROW} more than once`)

  let skillEnd = bodyLines.findIndex((line, at) => at > skillAt && /^ {6}- /.test(line))
  if (skillEnd === -1) skillEnd = bodyLines.length

  const shippedRow = bodyLines.slice(skillAt, skillEnd).join('\n')
  const dirsAt = bodyLines.findIndex((line, at) => at >= skillAt && at < skillEnd && line === '          customSkillDirs:')
  if (dirsAt === -1) throw new Error(`the shipped ${SKILL_ROW} row has no customSkillDirs`)
  if (!/dsh-agent-preset/.test(shippedRow)) throw new Error(`the shipped ${SKILL_ROW} row does not point at @deepseek-ai/dsh-agent-preset; refusing to guess`)

  const repaired = [
    `      - id: ${SKILL_ROW}`,
    `        name: '${SKILL_NAME}'`,
    '        config:',
    '          # Repaired: the shipped row points this root inside app.asar, which',
    '          # the file service cannot stat. This is a real directory, kept in',
    '          # step with the archive by cordis-skills-sync.mjs.',
    '          customSkillDirs:',
    `            - ${SKILLS_DIR}`,
  ]
  const repairedBody = [...bodyLines.slice(0, skillAt), ...repaired, ...bodyLines.slice(skillEnd)].join('\n')

  return `${head}\n${repairedBody}`.replace(/\n+$/, '')
}

/** The comment written above the markers. */
function note(packPresent) {
  const lines = [
    '# The `cordis` preset\'s own skill-filesystem row pointed its customSkillDirs',
    '# inside app.asar, where the file service cannot stat it, so the whole',
    '# provider was skipped and dsh-tool-skill refused to publish the skill',
    '# catalog. This block restates the shipped declaration with that one root',
    '# replaced by this repository\'s vendored copy, so the preset\'s own row is',
    '# what serves the four bundled skills.',
  ]
  if (packPresent) {
    lines.push(
      '#',
      `# The ${PACK_ROW} row, which served the same four skills from the same`,
      '# directory only because the preset row could not, was removed with it.',
    )
  }
  lines.push('#', '# Managed by patches/enable-cordis-skill-root.mjs - remove with --revert.')
  return lines.join('\n')
}

/**
 * Locate what `enable-cordis-skills.mjs` wrote: its comment header, its BEGIN
 * marker, the row it inserts, and its END marker.
 *
 * The two markers are not treated as one region. They have already drifted
 * apart in the live profile - three unrelated `disabled:` overrides sit
 * between the inserted row and the END marker - and removing the region would
 * delete them. Only the header, the insert entry and the two markers go, so
 * both markers disappear together and the sibling script's own marker balance
 * stays consistent for a later re-run.
 *
 * @param text - the profile patch.
 * @returns `{ ranges }` as ascending `{ start, end }` byte offsets, or undefined
 *   when neither marker is present.
 */
function locatePackBlock(text) {
  const lines = text.split('\n')
  const begin = lines.findIndex(line => line === PACK_BEGIN)
  const end = lines.findIndex(line => line === PACK_END)
  if (begin === -1 && end === -1) return undefined
  if (begin === -1 || end === -1 || end < begin) throw new Error(`${PACK_BEGIN} and ${PACK_END} are not a matched pair`)

  const insertAt = lines.findIndex((line, at) => at > begin && line === '- insert:')
  if (insertAt === -1) throw new Error(`the ${PACK_ROW} block has no "- insert:" entry`)
  let insertEnd = insertAt + 1
  while (insertEnd < lines.length && lines[insertEnd].length > 0 && /^\s/.test(lines[insertEnd])) insertEnd += 1

  const entry = lines.slice(insertAt, insertEnd).join('\n')
  for (const required of [`- id: ${PACK_ROW}`, `name: '${SKILL_NAME}'`]) {
    if (!entry.includes(required)) throw new Error(`the ${PACK_ROW} insert does not contain ${JSON.stringify(required)}`)
  }

  let headerStart = begin
  while (headerStart > 0 && lines[headerStart - 1].startsWith('#')) headerStart -= 1

  /** Byte offset of the first character of line `index`. */
  const offsetOf = index => lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0)
  return {
    ranges: [
      { start: offsetOf(headerStart), end: offsetOf(insertEnd) },
      { start: offsetOf(end), end: offsetOf(end + 1) },
    ],
    entry,
  }
}

/**
 * Whether DSH looks like it is running, so the #8635 hazard can be refused.
 * @returns true when a process named for the Desktop app is alive.
 */
function dshRunning() {
  try {
    const out = execFileSync('pgrep', ['-fil', 'DeepSeek Harness'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Re-parse the text about to land with a YAML parser, and assert the override
 * restates the shipped plugins list exactly except for the repaired row.
 *
 * @param next - the profile patch text that will be written.
 * @param shippedPlugins - the shipped declaration's plugins list, parsed.
 * @returns a one-line verdict.
 */
async function yamlCheck(next, shippedPlugins) {
  let parseDocument
  try {
    ({ parseDocument } = await import('yaml'))
  } catch {
    return 'skipped (no `yaml` module installed)'
  }
  const doc = parseDocument(next, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (text) => text }] })
  if (doc.errors.length > 0) return `FAILED: ${doc.errors[0].message}`
  const rows = doc.toJS()
  if (!Array.isArray(rows)) return 'FAILED: the patch layer is not a top-level array'

  const override = rows.find(entry => entry?.id === PRESET_ROW)
  if (override === undefined) return 'FAILED: the override row does not parse'
  const plugins = override?.config?.plugins
  if (!Array.isArray(plugins)) return 'FAILED: the override carries no config.plugins list'
  if (plugins.length !== shippedPlugins.length) return `FAILED: ${plugins.length} plugin row(s), the shipped list has ${shippedPlugins.length}`

  const repaired = plugins.find(row => row?.id === SKILL_ROW)
  if (repaired === undefined) return `FAILED: the override has no ${SKILL_ROW} row`
  const dirs = repaired?.config?.customSkillDirs
  if (!Array.isArray(dirs) || dirs[0] !== SKILLS_DIR) return `FAILED: customSkillDirs did not parse as ${SKILLS_DIR}`

  let changed = 0
  for (const shipped of shippedPlugins) {
    const mine = plugins.find(row => row?.id === shipped?.id)
    if (mine === undefined) return `FAILED: the override drops the shipped row ${shipped?.id}`
    if (shipped?.id === SKILL_ROW) continue
    if (JSON.stringify(mine) !== JSON.stringify(shipped)) changed += 1
  }
  if (changed > 0) return `FAILED: ${changed} unrelated row(s) differ from the shipped declaration`

  const ids = rows.map(entry => entry?.id).filter(id => typeof id === 'string')
  const duplicate = ids.find((id, at) => ids.indexOf(id) !== at)
  if (duplicate !== undefined) return `FAILED: duplicate top-level id ${duplicate}`
  for (const entry of rows) {
    if (Array.isArray(entry?.insert) && entry.insert.some(row => row?.id === PACK_ROW)) return `FAILED: the ${PACK_ROW} insert is still present`
  }
  return `ok (array, override present, one row repaired, ${shippedPlugins.length - 1} others identical, no duplicate ids)`
}

/**
 * Compare the top-level entry list before and after the rewrite.
 *
 * This is the guard against the expensive mistake: a text splice that removes
 * one row too many. The only difference allowed is the pack row leaving and the
 * preset override arriving, so an unrelated entry cannot be lost silently - the
 * live profile already holds three overrides inside a drifted marker pair.
 *
 * @param before - the profile patch as it stands.
 * @param after - the profile patch that would be written.
 * @returns a one-line verdict.
 */
async function structureCheck(before, after) {
  let parseDocument
  try {
    ({ parseDocument } = await import('yaml'))
  } catch {
    return 'skipped (no `yaml` module installed)'
  }
  const tags = [{ tag: 'tag:yaml.org,2002:js', resolve: text => text }]
  const ids = text => {
    const doc = parseDocument(text, { customTags: tags })
    if (doc.errors.length > 0) return undefined
    const rows = doc.toJS()
    if (!Array.isArray(rows)) return undefined
    return rows.map(entry => entry?.id ?? `insert:${Array.isArray(entry?.insert) ? entry.insert.map(row => row?.id).join('+') : '?'}`)
  }
  const was = ids(before)
  const now = ids(after)
  if (was === undefined || now === undefined) return 'FAILED: a side of the comparison does not parse'
  const dropped = was.filter(id => !now.includes(id))
  const added = now.filter(id => !was.includes(id))
  const acceptable = [`insert:${PACK_ROW}`]
  const lost = dropped.filter(id => !acceptable.includes(id))
  if (lost.length > 0) return `FAILED: the rewrite drops top-level ${lost.length} entr${lost.length === 1 ? 'y' : 'ies'} ${lost.join(', ')}`
  if (added.length !== 1 || added[0] !== PRESET_ROW) return `FAILED: the rewrite adds ${added.join(', ') || 'nothing'}, expected only ${PRESET_ROW}`
  if (now.length !== was.length + 1 - dropped.length) return `FAILED: the rewrite changed the entry count by ${now.length - was.length}, expected ${1 - dropped.length}`
  return `ok (entries ${was.length} -> ${now.length}, ${dropped.length} retired, nothing else touched)`
}

const presetText = existsSync(ASAR) ? readArchiveFile(PRESET_PATH) : undefined
if (presetText === undefined) {
  console.error(`no archive at ${ASAR}`)
  console.error('This script reads the installed Desktop bundle; pass --asar <path> for another install.')
  process.exit(1)
}
if (!existsSync(PROFILE)) {
  console.error(`no such profile patch layer: ${PROFILE}`)
  process.exit(1)
}

const missing = SKILL_NAMES.filter(name => !existsSync(join(SKILLS_DIR, name, 'SKILL.md')))
if (missing.length > 0) {
  console.error(`the vendored copy is incomplete: ${SKILLS_DIR}`)
  for (const name of missing) console.error(`  missing ${name}/SKILL.md`)
  console.error('')
  console.error('Run `node patches/cordis-skills-sync.mjs` first; a row pointing at an')
  console.error('incomplete directory would only move the silent failure.')
  process.exit(1)
}

const shippedPlugins = (await (async () => {
  let parseDocument
  try {
    ({ parseDocument } = await import('yaml'))
  } catch {
    return undefined
  }
  const doc = parseDocument(presetText, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (text) => text }] })
  if (doc.errors.length > 0) return undefined
  const entries = doc.toJS()
  const declaration = entries?.[0]?.insert?.find(entry => entry?.id === PRESET_ROW)
  return declaration?.config?.plugins
})()) ?? []

const generated = buildBlock(presetText)
const original = readFileSync(PROFILE, 'utf8')
const beginCount = countOf(original, MARK_BEGIN)
const endCount = countOf(original, MARK_END)
if (beginCount !== endCount) {
  console.error(`${MARK_BEGIN} appears ${beginCount} time(s) but ${MARK_END} appears ${endCount}; refusing to guess`)
  process.exit(1)
}
if (beginCount > 1) {
  console.error(`${MARK_BEGIN} appears ${beginCount} times; refusing to guess which block to touch`)
  process.exit(1)
}

const noteOld = countOf(original, NOTE_OLD)
const noteNew = countOf(original, NOTE_NEW)
if (noteOld > 1 || noteNew > 1 || (noteOld === 1 && noteNew === 1)) {
  console.error('the preset note matches both the original and the repaired text; refusing to guess')
  process.exit(1)
}

let pack
try {
  pack = locatePackBlock(original)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const blocks = [true, false].map(withPack => `${note(withPack)}\n${MARK_BEGIN}\n${generated}\n${MARK_END}\n`)
const present = blocks.filter(candidate => original.includes(candidate))
const applied = present.length === 1 && pack === undefined && noteNew === 1

if (flag('--print')) {
  process.stdout.write(present[0] ?? blocks[1])
  process.exit(0)
}

if (flag('--check')) {
  console.log(`profile : ${PROFILE}`)
  console.log(`archive : ${ASAR}`)
  console.log(`row     : ${MARK} ${beginCount === 1 ? 'present' : 'absent'}`)
  console.log(`block   : ${beginCount === 1 ? (applied ? 'byte-identical to a fresh generation' : 'DIFFERS from a fresh generation (stale, or the archive moved)') : 'not written'}`)
  console.log(`pack row: ${pack === undefined ? 'removed' : 'present'}`)
  console.log(`note    : ${noteNew === 1 ? 'repaired' : noteOld === 1 ? 'original' : 'neither (left alone)'}`)
  const pending = flag('--revert') ? beginCount === 1 : !applied
  console.log(pending ? 'RESULT: would change' : 'RESULT: already in the requested state')
  process.exit(pending ? 1 : 0)
}

const reverting = flag('--revert')
if (reverting ? beginCount === 0 : applied) {
  console.log(reverting ? 'already reverted; nothing to do' : 'already applied; nothing to do')
  console.log(`profile : ${PROFILE}`)
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

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = `${PROFILE}.bak-cordisskillroot-${stamp}`

if (reverting) {
  if (present.length !== 1) {
    console.error(`the ${MARK} block is not byte-identical to what this script writes`)
    console.error('remove it by hand between the BEGIN and END markers, then re-run')
    process.exit(1)
  }
  if (noteNew !== 1) {
    console.error('the repaired note was not found; refusing to half-revert')
    process.exit(1)
  }
  // The note goes back first. The sibling script refuses to write unless its own
  // note text is present, so restoring it is what lets that script put the row back.
  const next = original.replace(present[0], '').replace(NOTE_NEW, NOTE_OLD)
  copyFileSync(PROFILE, backup)
  writeFileSync(PROFILE, next)
  console.log(`row     : ${MARK} present -> absent`)
  if (pack === undefined) {
    if (!existsSync(SIBLING)) {
      console.log(`pack    : not restored; ${SIBLING} is missing`)
      console.log('          restore it by hand, or the four bundled skills stay unserved')
    } else {
      console.log('pack    : restoring the block and the note through enable-cordis-skills.mjs')
      try {
        const out = execFileSync(process.execPath, [SIBLING, '--force', PROFILE], { encoding: 'utf8' })
        for (const line of out.trimEnd().split('\n')) console.log(`          ${line}`)
      } catch (error) {
        console.log(`          FAILED: ${error.message.split('\n')[0]}`)
        if (typeof error.stderr === 'string') for (const line of error.stderr.trimEnd().split('\n')) console.log(`          ${line}`)
        console.log(`          the row is still absent; the layer before this step is at ${backup}`)
        process.exit(1)
      }
    }
  } else {
    console.log('pack    : left in place (present, which is not the state this script creates)')
  }
  console.log(`profile : ${PROFILE}`)
  console.log(`backup  : ${backup}`)
  process.exit(0)
}

if (noteOld === 0) {
  console.error('the preset note this script rewrites was not found; refusing to half-apply')
  console.error(`expected:\n${NOTE_OLD}`)
  process.exit(1)
}

let next = original
if (pack !== undefined) {
  for (const range of [...pack.ranges].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, range.start) + next.slice(range.end)
  }
}
next = next.replace(NOTE_OLD, NOTE_NEW)
next = (next.endsWith('\n') ? next : `${next}\n`) + blocks[1]

const nextBegin = countOf(next, MARK_BEGIN)
if (nextBegin !== 1) {
  console.error(`rewrite did not produce exactly one ${MARK_BEGIN} (found ${nextBegin}); refusing to write`)
  process.exit(1)
}
if (countOf(next, PACK_BEGIN) !== 0 || countOf(next, PACK_END) !== 0) {
  console.error(`the ${PACK_ROW} markers survived the rewrite; refusing to write`)
  process.exit(1)
}
if (countOf(next, NOTE_NEW) !== 1) {
  console.error('the note rewrite did not land; refusing to write')
  process.exit(1)
}
const yaml = await yamlCheck(next, shippedPlugins)
if (yaml.startsWith('FAILED')) {
  console.error(yaml)
  console.error('refusing to write')
  process.exit(1)
}
const structure = await structureCheck(original, next)
if (structure.startsWith('FAILED')) {
  console.error(structure)
  console.error('refusing to write')
  process.exit(1)
}

copyFileSync(PROFILE, backup)
writeFileSync(PROFILE, next)
console.log(`row     : ${MARK} absent -> present`)
console.log(`preset  : ${shippedPlugins.length || '?'} plugin row(s) restated, 1 repaired`)
console.log(`pack    : ${pack === undefined ? 'absent already' : `${PACK_ROW} block removed`}`)
console.log(`note    : ${noteOld === 1 ? 'original -> repaired' : 'already repaired'}`)
console.log(`yaml    : ${yaml}`)
console.log(`struct  : ${structure}`)
console.log(`profile : ${PROFILE}`)
console.log(`backup  : ${backup}`)
console.log(`skills  : ${SKILLS_DIR}`)
console.log('')
console.log('restart DSH for this to take effect, then start a NEW session (a preset is')
console.log('fixed at session start). The four bundled skills must still load by name, and')
console.log('the session must now carry a skill catalog:')
console.log('  node tools/skill-catalog-census.mjs --preset cordis --verbose')
