#!/usr/bin/env node
/**
 * Keep `patches/cordis-skills/` identical to the four skills that ship with the
 * DSH installation's `@deepseek-ai/dsh-agent-preset`.
 *
 * WHY A COPY EXISTS AT ALL. In DSH Desktop those skills live only inside
 * `app.asar`, and the harness's own file service throws on any path inside the
 * archive (`Cannot mix BigInt and other types`, measured 2026-10-02 against
 * 0.2.0-rc.2). The `cordis` preset's `skill-filesystem` row points
 * `customSkillDirs` there, so discovery fails for that provider and every
 * filesystem skill root goes down with it. `patches/enable-cordis-skills.mjs`
 * mounts this copy instead. The vendored copy is therefore the live content for
 * those four skill names, which is why it is checked rather than trusted.
 *
 * READING THE ARCHIVE. `app.asar` is a pickle header, a JSON directory, then the
 * file bodies. The body section starts at `8 + headerSize`, where `headerSize`
 * is the second UInt32 of the pickle - not at `16 + jsonLength`, which is two
 * bytes early and shifts every extracted file. This script derives the offset
 * from the header it just read, and `--check` re-reads the archive, so a refresh
 * cannot quietly write a shifted copy.
 *
 * Usage:
 *   node cordis-skills-sync.mjs [--check] [--asar <path>] [outDir]
 *
 *   (no flags)  rewrite outDir from the archive, then verify it
 *   --check     compare outDir with the archive and change nothing
 *
 * The default output directory is `./cordis-skills` beside this script; the
 * default archive is the installed Desktop bundle.
 *
 * @module dsh-cordis-skills-sync
 */

import { existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const valueOf = name => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--asar')

/** Archive-relative prefix of the skills this repository vendors. */
const PREFIX = '/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills'

const ASAR = resolve(valueOf('--asar') ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
const OUT = resolve(positional[0] ?? join(HERE, 'cordis-skills'))

if (!existsSync(ASAR)) {
  console.error(`no archive at ${ASAR}`)
  console.error('This script reads the installed Desktop bundle; pass --asar <path> for another install.')
  process.exit(1)
}

/** Read the asar directory and return every entry under `prefix`, plus the body offset. */
function readArchive(prefix) {
  const fd = openSync(ASAR, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    const dataStart = 8 + headerSize
    const json = Buffer.alloc(jsonLength)
    readSync(fd, json, 0, jsonLength, 16)
    const tree = JSON.parse(json.toString('utf8'))
    const entries = []
    const walk = (node, prefixPath) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const path = `${prefixPath}/${name}`
        if (child.files) walk(child, path)
        else entries.push({ path, size: child.size, offset: Number(child.offset) })
      }
    }
    walk(tree, '')
    const hits = entries.filter(entry => entry.path.startsWith(prefix))
    if (hits.length === 0) throw new Error(`the archive holds nothing under ${prefix}`)
    const files = hits.map(entry => {
      const buf = Buffer.alloc(entry.size)
      readSync(fd, buf, 0, entry.size, dataStart + entry.offset)
      return { path: entry.path.slice(prefix.length + 1), bytes: buf }
    })
    let version
    try {
      const pkg = entries.find(entry => entry.path === '/dsh/node_modules/@deepseek-ai/dsh-agent-preset/package.json')
      const buf = Buffer.alloc(pkg.size)
      readSync(fd, buf, 0, pkg.size, dataStart + pkg.offset)
      version = JSON.parse(buf.toString('utf8')).version
    } catch {
      version = undefined
    }
    return { files, version }
  } finally {
    closeSync(fd)
  }
}

/** Every file below `dir`, relative, sorted. */
function listFiles(dir) {
  const out = []
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(relative(dir, path))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

const { files, version } = readArchive(PREFIX)
console.log(`archive : ${ASAR}`)
console.log(`source  : @deepseek-ai/dsh-agent-preset${version === undefined ? '' : ` ${version}`}`)
console.log(`skills  : ${files.length} files, ${files.reduce((sum, f) => sum + f.bytes.length, 0)} bytes`)
console.log(`output  : ${OUT}`)

if (flag('--check')) {
  const onDisk = new Set(listFiles(OUT))
  const problems = []
  for (const file of files) {
    const path = join(OUT, file.path)
    if (!existsSync(path)) {
      problems.push(`missing: ${file.path}`)
      continue
    }
    const bytes = readFileSync(path)
    if (!bytes.equals(file.bytes)) {
      problems.push(`differs: ${file.path} (archive ${file.bytes.length} bytes, on disk ${bytes.length})`)
    }
  }
  for (const path of onDisk) {
    if (!files.some(file => file.path === path)) problems.push(`not in the archive: ${path}`)
  }
  for (const file of files) onDisk.delete(file.path)
  if (problems.length > 0) {
    console.error('')
    for (const problem of problems) console.error(problem)
    console.error(`\nRESULT: ${problems.length} difference(s); run without --check to refresh the copy`)
    process.exit(1)
  }
  console.log('\nRESULT: the vendored copy is byte-identical to the archive')
  process.exit(0)
}

for (const file of files) {
  const path = join(OUT, file.path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, file.bytes)
  console.log(`  wrote ${file.path}`)
}

const onDisk = new Set(listFiles(OUT))
const leftovers = [...onDisk].filter(path => !files.some(file => file.path === path))
const mismatch = files.filter(file => !readFileSync(join(OUT, file.path)).equals(file.bytes))
for (const path of leftovers) console.log(`  kept  ${path} (not in the archive; delete it by hand if it is stale)`)

if (mismatch.length > 0) {
  console.error(`\nRESULT: ${mismatch.length} file(s) did not match after writing; refusing to report success`)
  process.exit(1)
}
console.log(`\nRESULT: wrote ${files.length} files, re-read byte-identical`)
