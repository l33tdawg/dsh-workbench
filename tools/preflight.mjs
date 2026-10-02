#!/usr/bin/env node
/**
 * Pre-flight: can every plugin load from where it will be installed?
 *
 * A plugin whose import fails does not degrade, it throws, and a bundle that
 * throws during load can abort the harness boot. So every bare specifier each
 * plugin imports is resolved here exactly as Node would resolve it from that
 * plugin's directory, before anything touches a live profile.
 *
 * Reports, per plugin: every import, whether it resolves, and the file it lands
 * on. Exits non-zero if any plugin would fail to load.
 *
 * Usage: node preflight.mjs <packages-dir> [...plugin-dir-names]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const [packagesDir, ...only] = process.argv.slice(2)
if (packagesDir === undefined) {
  console.error('usage: node preflight.mjs <packages-dir> [plugin-dir ...]')
  process.exit(2)
}

/** Every relative or bare specifier a module statically imports. */
function importsOf(file) {
  const text = readFileSync(file, 'utf8')
  const found = new Set()
  // Matches `import x from '...'`, `import '...'`, `export ... from '...'`,
  // and dynamic `import('...')` with a literal.
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}

/** Every .ts/.mjs/.js source file under a plugin's src, excluding tests. */
function sources(dir) {
  const found = []
  const walk = current => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'tests') continue
        walk(path)
      } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
        found.push(path)
      }
    }
  }
  walk(join(dir, 'src'))
  return found
}

/** Try to resolve a specifier as Node would from `fromDir`. */
function resolveFrom(specifier, fromDir) {
  if (isBuiltin(specifier)) return { ok: true, where: '(node builtin)' }
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const base = resolve(fromDir, specifier)
    for (const candidate of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')]) {
      try {
        if (statSync(candidate).isFile()) return { ok: true, where: candidate }
      } catch {
        // Keep trying.
      }
    }
    return { ok: false, where: `${base} (no such file)` }
  }
  const require = createRequire(resolve(fromDir, 'noop.js'))
  try {
    return { ok: true, where: require.resolve(specifier) }
  } catch (error) {
    // An ESM-only package with an `exports` map can defeat require.resolve;
    // fall back to reading it as a directory.
    const segments = specifier.startsWith('@') ? specifier.split('/').slice(0, 2) : [specifier.split('/')[0]]
    let dir = fromDir
    for (;;) {
      const candidate = join(dir, 'node_modules', ...segments)
      try {
        if (statSync(candidate).isDirectory()) return { ok: true, where: candidate }
      } catch {
        // Keep walking up.
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return { ok: false, where: error.code ?? error.message }
  }
}

const names = only.length > 0 ? only : readdirSync(packagesDir).filter(name => name.startsWith('dsh-'))
let failures = 0

for (const name of names) {
  const dir = join(packagesDir, name)
  let files
  try {
    files = sources(dir)
  } catch {
    console.log(`\n${name}: NO src/ DIRECTORY`)
    continue
  }
  console.log(`\n${name}`)
  if (files.length === 0) console.log('  (no sources)')

  for (const file of files) {
    for (const specifier of importsOf(file)) {
      const result = resolveFrom(specifier, dirname(file))
      const label = file.slice(dir.length + 1)
      if (result.ok) {
        console.log(`  ok    ${label}  ->  ${specifier}`)
      } else {
        console.log(`  FAIL  ${label}  ->  ${specifier}   (${result.where})`)
        failures++
      }
    }
  }
}

console.log('')
if (failures === 0) {
  console.log('all imports resolve; every plugin can load from this location')
} else {
  console.log(`${failures} unresolved import(s); installing these plugins risks aborting the boot`)
  process.exit(1)
}
