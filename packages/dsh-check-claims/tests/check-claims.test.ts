/**
 * Tests built from the four claims that went wrong in one session.
 *
 * Each fixture is a real failure, not a hypothetical:
 *
 *   1. "every preset-scoped tool" when 25 of 65 were removed.
 *   2. "three prompt sections" when the real number was nine.
 *   3. an absence concluded from a search that had been truncated.
 *   4. a security claim checked against a tree carrying the author's own patch.
 *
 * A tool that only counts would pass all four tests while still allowing the
 * mistakes, so the assertions below are written against the mistakes themselves.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { countMatches, judge, lineAt, type MatchSite } from '../src/match.ts'
import { assertSafeRoot, assertSafeToken, inject, name, OUTPUT_SCHEMA, TOOL_NAME, apply } from '../src/index.ts'
import { DEFAULT_LIMITS, scan, type ScanResult, type ScanSource } from '../src/scan.ts'
import { formatReport, type CheckValue, type ReportValue, type Verdict } from '../src/report.ts'
import { revisionSource, workingTreeSource } from '../src/sources.ts'

/** Build a scan result from literal files. */
function scanned(files: Record<string, string>, extra: Partial<ScanResult> = {}): ScanResult {
  return {
    files: Object.entries(files).map(([path, text]) => ({ path, text })),
    incomplete: false,
    read: Object.keys(files).length,
    skipped: 0,
    ...extra,
  }
}

/** A source backed by a literal map, for exercising the scanner itself. */
function literalSource(files: Record<string, string>): ScanSource {
  return {
    describe: 'fixture',
    list: async (path) => Object.keys(files).filter(key => key.startsWith(path)),
    size: async (path) => files[path] === undefined ? undefined : Buffer.byteLength(files[path], 'utf8'),
    read: async (path) => files[path],
  }
}

describe('counting', () => {
  it('reports the true count, which is the whole point', () => {
    // Failure 2: nine unguarded sections were reported as three.
    const text = Array.from({ length: 9 }, (_, i) => `ctx.systemPrompt.section({ // ${i}`).join('\n')
    const result = countMatches(scanned({ 'a.ts': text }), String.raw`ctx\.systemPrompt\.section\(\{`)
    assert.equal(result.count, 9)
  })

  it('counts across many files and reports how many matched', () => {
    const result = countMatches(scanned({ 'a.ts': 'hit\nhit\n', 'b.ts': 'hit\n', 'c.ts': 'miss\n' }), 'hit')
    assert.equal(result.count, 3)
    assert.equal(result.filesMatched, 2)
  })

  it('samples where matches are without bounding the count', () => {
    const text = 'x\n'.repeat(50)
    const result = countMatches(scanned({ 'a.ts': text }), 'x')
    assert.equal(result.count, 50, 'the count is exact')
    assert.ok(result.sites.length < 50, 'the site preview is bounded')
    assert.equal(result.sites[0].line, 1)
  })

  it('does not hang on a zero-length match', () => {
    const result = countMatches(scanned({ 'a.ts': 'abc' }), '')
    assert.ok(result.count >= 3, 'an empty pattern still advances through the text')
  })

  it('rejects an invalid pattern with the pattern in the message', () => {
    assert.throws(() => countMatches(scanned({ 'a.ts': '' }), '(['), /invalid pattern/)
  })

  it('numbers lines from one', () => {
    assert.equal(lineAt('a\nb\nc', 0), 1)
    assert.equal(lineAt('a\nb\nc', 2), 2)
    assert.equal(lineAt('a\nb\nc', 4), 3)
  })
})

describe('judging', () => {
  const counted = (count: number, incomplete = false, filesScanned = 1) => ({
    count, sites: [] as MatchSite[], filesMatched: 1, incomplete, filesScanned,
    ...incomplete ? { reason: 'hit the file limit' } : {},
  })

  it('passes an exact expectation that holds', () => {
    assert.equal(judge(counted(21), { expect: 21 }).verdict, 'pass')
  })

  it('fails an exact expectation that does not, naming both numbers', () => {
    // Failure 1: stated as "every", actually 41 of 66.
    const verdict = judge(counted(41), { expect: 66 })
    assert.equal(verdict.verdict, 'fail')
    assert.match(verdict.detail, /found 41, expected 66/)
  })

  it('treats absence as an expectation of zero', () => {
    assert.equal(judge(counted(0), { expect: 0 }).verdict, 'pass')
    assert.equal(judge(counted(3), { expect: 0 }).verdict, 'fail')
  })

  it('supports a minimum', () => {
    assert.equal(judge(counted(5), { atLeast: 3 }).verdict, 'pass')
    assert.equal(judge(counted(2), { atLeast: 3 }).verdict, 'fail')
  })

  // Failure 3: "nothing found" from a search that had been truncated. Absence
  // is the claim a partial read reports most confidently and supports least.
  it('never confirms absence from a partial scan', () => {
    assert.equal(judge(counted(0, true), { expect: 0 }).verdict, 'unknown')
    assert.equal(judge(counted(3, true), { expect: 3 }).verdict, 'unknown')
    assert.match(judge(counted(0, true), { expect: 0 }).detail, /partial scan/)
  })

  it('fails a partial scan that has already exceeded an exact expectation', () => {
    const verdict = judge(counted(7, true), { expect: 3 })
    assert.equal(verdict.verdict, 'fail')
    assert.match(verdict.detail, /found 7 so far/)
  })

  it('passes a minimum a partial scan has already met, since the count only grows', () => {
    assert.equal(judge(counted(5, true), { atLeast: 1 }).verdict, 'pass')
    assert.equal(judge(counted(0, true), { atLeast: 1 }).verdict, 'unknown')
  })

  it('is undecided when no expectation was given, and still reports the count', () => {
    const verdict = judge(counted(7), {})
    assert.equal(verdict.verdict, 'unknown')
    assert.match(verdict.detail, /found 7/)
  })

  // Found by running the tool on real data: a path that did not exist passed
  // "expect 0" because counting zero matches in zero files is trivially true.
  it('decides nothing when no file was examined', () => {
    assert.equal(judge(counted(0, false, 0), { expect: 0 }).verdict, 'unknown')
    assert.equal(judge(counted(0, false, 0), { atLeast: 0 }).verdict, 'unknown')
    assert.match(judge(counted(0, false, 0), { expect: 0 }).detail, /examined no files/)
  })

  it('refuses two contradictory expectations', () => {
    assert.equal(judge(counted(1), { expect: 1, atLeast: 1 }).verdict, 'unknown')
  })
})

describe('the scanner', () => {
  it('walks a directory and skips dependency trees', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claims-'))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'needle\n')
    writeFileSync(join(root, 'node_modules', 'dep', 'b.ts'), 'needle\n')

    const result = await scan(workingTreeSource(root), 'src')
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].path, 'src/a.ts')
    assert.equal(result.incomplete, false)
  })

  it('marks a scan incomplete at the file limit rather than under-reporting', async () => {
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.txt`, 'x']))
    const result = await scan(literalSource(files), 'f', undefined, { maxFiles: 3, maxFileBytes: 1000 })
    assert.equal(result.files.length, 3)
    assert.equal(result.incomplete, true)
    assert.match(result.reason ?? '', /10 files were in scope/)
  })

  it('marks a scan incomplete when it skips an oversized file', async () => {
    // The failure this guards: a big file is the only place the needle lives,
    // and a small neighbour makes the scan look complete.
    const files = { 'src/small.ts': 'nothing here\n', 'src/big.ts': `needle\n${'x'.repeat(3000)}` }
    const result = await scan(literalSource(files), 'src', undefined, { maxFiles: 100, maxFileBytes: 2000 })
    assert.equal(result.files.length, 1)
    assert.equal(result.skipped, 1)
    assert.equal(result.incomplete, true)
    assert.match(result.reason ?? '', /over the 2000-byte limit/)
  })

  // Measured on 2026-10-09: the desktop Host stopped twice while this plugin
  // scanned a workspace holding a 2.6 GB model file. `readFileSync(path, 'utf8')`
  // on that file ends the process with SIGTRAP on the runtime the desktop ships
  // (Node 24.18.1, Electron 44) instead of throwing, so the scan's own catch
  // never ran, no report was produced, and the whole Host went down with it.
  // A size asked before the read is what keeps an oversized file unopened.
  it('never reads a file it has already measured as oversized', async () => {
    let read = false
    const source: ScanSource = {
      describe: 'oversized fixture',
      list: async () => ['src/huge.bin'],
      size: async () => 2_600_000_000,
      read: async () => {
        read = true
        return 'needle'
      },
    }
    const result = await scan(source, 'src', undefined, { maxFiles: 100, maxFileBytes: 2000 })
    assert.equal(read, false, 'an oversized file must not be opened')
    assert.equal(result.files.length, 0)
    assert.equal(result.skipped, 1)
    assert.equal(result.incomplete, true)
    assert.match(result.reason ?? '', /over the 2000-byte limit/)
  })

  // The bound still has to hold for a source that cannot measure, or the
  // pre-read check would just move the hole rather than close it.
  it('bounds a source that cannot measure from the text it returns', async () => {
    const source: ScanSource = {
      describe: 'unmeasurable fixture',
      list: async () => ['src/big.ts'],
      size: async () => undefined,
      read: async () => `needle\n${'x'.repeat(3000)}`,
    }
    const result = await scan(source, 'src', undefined, { maxFiles: 100, maxFileBytes: 2000 })
    assert.equal(result.files.length, 0)
    assert.equal(result.skipped, 1)
    assert.equal(result.incomplete, true)
  })

  it('will not report an absence it could not check, so a skipped file cannot pass', async () => {
    const files = { 'src/small.ts': 'nothing here\n', 'src/big.ts': `needle\n${'x'.repeat(3000)}` }
    const counted = countMatches(
      await scan(literalSource(files), 'src', undefined, { maxFiles: 100, maxFileBytes: 2000 }),
      'needle',
    )
    // The needle is present, in the file that was skipped. "expect 0" used to
    // pass here, which is the one answer the tool must never give.
    assert.equal(judge(counted, { expect: 0 }).verdict, 'unknown')
  })

  it('skips binary files, because matches in them are noise', async () => {
    const result = await scan(literalSource({ 'dir/bin.txt': 'a\u0000b', 'dir/ok.txt': 'a' }), 'dir')
    assert.equal(result.files.length, 1)
    assert.equal(result.skipped, 1)
  })

  it('reads a single named file without walking', async () => {
    const result = await scan(literalSource({ 'one.txt': 'a', 'other.txt': 'b' }), 'one.txt')
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].path, 'one.txt')
  })
})

describe('reading outside the workspace', () => {
  // Task 54cb2d02: the tool could not answer the question it was built for,
  // because its own README example reads a checkout that is not the workspace.
  const outside = mkdtempSync(join(tmpdir(), 'claims-outside-'))
  mkdirSync(join(outside, 'packages', 'sandbox'), { recursive: true })
  writeFileSync(join(outside, 'packages', 'sandbox', 'index.ts'), 'export const guard = 1\n')

  it('scans a tree the workspace does not contain', async () => {
    const source = workingTreeSource(outside)
    const result = await scan(source, 'packages/sandbox/index.ts', outside)
    assert.equal(result.incomplete, false)
    assert.deepEqual(result.files.map(file => file.path), ['packages/sandbox/index.ts'])
  })

  it('reports a site relative to the base it actually scanned', async () => {
    const source = workingTreeSource(outside)
    const counted = countMatches(await scan(source, 'packages/sandbox/index.ts', outside), 'guard')
    assert.deepEqual(counted.sites, [{ path: 'packages/sandbox/index.ts', line: 1 }])
  })

  it('reads an absolute path as itself, not as a path inside the root', async () => {
    // The trap this guards: join(root, anAbsolutePath) returns the absolute
    // path, so an absolute read appears to work while a relative one is what
    // actually resolves. Put the same basename under the root and the two
    // answers diverge, which is when the wrong base gets caught.
    const elsewhere = mkdtempSync(join(tmpdir(), 'claims-elsewhere-'))
    const absolute = join(elsewhere, 'only.ts')
    writeFileSync(absolute, 'outside\n')
    writeFileSync(join(outside, 'only.ts'), 'inside\n')
    const source = workingTreeSource(outside)

    assert.equal(await source.read('only.ts'), 'inside\n')
    assert.equal(await source.read(absolute), 'outside\n', 'the absolute path is not read through the root')
    assert.deepEqual(await source.list(absolute), [relative(outside, absolute)])
  })

  it('measures a file without reading it', async () => {
    const source = workingTreeSource(outside)
    const text = 'export const guard = 1\n'
    assert.equal(await source.size('packages/sandbox/index.ts'), Buffer.byteLength(text, 'utf8'))
    assert.equal(await source.size('packages/sandbox/missing.ts'), undefined)
  })
})

describe('reading a revision', () => {
  // Failure 4: a claim about upstream checked against a tree carrying a patch.
  it('reads through git rather than the filesystem', async () => {
    const calls: string[][] = []
    const run = async (command: string, args: string[]): Promise<string> => {
      calls.push([command, ...args])
      if (args[0] === 'ls-tree') return '100644 blob 3f7a1c 24\tsrc/a.ts\n'
      if (args[0] === 'show') return 'content at the revision\n'
      throw new Error(`unexpected ${args[0]}`)
    }
    const source = revisionSource('origin/master', run)
    const files = await source.list('src')
    const size = await source.size('src/a.ts')
    const text = await source.read('src/a.ts')

    assert.deepEqual(files, ['src/a.ts'])
    assert.equal(size, 24, 'the long listing carries the size, so measuring needs no extra call')
    assert.equal(text, 'content at the revision\n')
    assert.deepEqual(calls[0], ['git', 'ls-tree', '-r', '-l', 'origin/master', '--', 'src'])
    assert.deepEqual(calls[1], ['git', 'show', 'origin/master:src/a.ts'])
  })

  it('caches a listing so one path is listed once', async () => {
    let listings = 0
    const run = async (): Promise<string> => { listings++; return '100644 blob 3f7a1c 1\ta\n' }
    const source = revisionSource('HEAD', run)
    await source.list('src')
    await source.list('src')
    assert.equal(listings, 1)
  })

  it('measures a named revision path through cat-file when nothing listed it', async () => {
    const calls: string[][] = []
    const run = async (command: string, args: string[]): Promise<string> => {
      calls.push([command, ...args])
      if (args[0] === 'cat-file') return '1234\n'
      throw new Error(`unexpected ${args[0]}`)
    }
    const source = revisionSource('HEAD', run)
    assert.equal(await source.size('docs/big.md'), 1234)
    assert.deepEqual(calls[0], ['git', 'cat-file', '-s', 'HEAD:docs/big.md'])
  })

  it('reports a missing revision as unreadable rather than empty', async () => {
    const run = async (): Promise<string> => { throw new Error('unknown revision') }
    const source = revisionSource('nope', run)
    assert.equal(await source.read('a.ts'), undefined)
  })

  it('names the revision in the report so the scope is visible', () => {
    const check: CheckValue = {
      pattern: 'x', path: 'p', at: 'origin/master', root: null, verdict: 'pass',
      count: 1, detail: 'found 1, expected 1 [revision origin/master]', incomplete: false, sites: [],
    }
    assert.match(formatReport({ checks: [check] }), /p @ origin\/master/)
  })

  it('names an outside base in the report, so the scope is visible', () => {
    const check: CheckValue = {
      pattern: 'x', path: 'packages/sandbox', at: null, root: '/tmp/extracted/app.asar/dsh', verdict: 'pass',
      count: 1, detail: 'found 1, expected 1 [working tree rooted at /tmp/extracted/app.asar/dsh]',
      incomplete: false, sites: [],
    }
    assert.match(formatReport({ checks: [check] }), /rooted at \/tmp\/extracted\/app\.asar\/dsh/)
  })
})

describe('token validation', () => {
  // The revision and path are embedded in a command line, so anything that
  // could alter it is refused rather than escaped.
  it('refuses shell metacharacters in either token', () => {
    for (const bad of ['a;rm -rf /', 'a$(whoami)', 'a`id`', "a'b", 'a|b', 'a b', 'a\nb', 'a&b']) {
      assert.throws(() => assertSafeToken(bad, 'revision'), /contains characters outside/, bad)
      assert.throws(() => assertSafeToken(bad, 'path'), /contains characters outside/, bad)
    }
  })

  it('refuses a path that escapes the workspace', () => {
    assert.throws(() => assertSafeToken('../../etc/passwd', 'path'), /contains "\.\."/)
  })

  // The widening must not make a relative path able to leave its base, which is
  // still what `..` is refused for. Leaving is what `root` is for, explicitly.
  it('keeps a relative path inside its base while a root may leave it', () => {
    assert.throws(() => assertSafeToken('../../etc/passwd', 'path'), /contains "\.\."/)
    assert.equal(assertSafeRoot('/etc/passwd'), '/etc/passwd')
  })

  it('refuses a root whose scan base would be ambiguous', () => {
    assert.throws(() => assertSafeRoot('/tmp/../etc'), /contains "\.\."/)
    assert.throws(() => assertSafeRoot('/tmp/a\u0000b'), /control character/)
    assert.throws(() => assertSafeRoot(''), /1-400 characters/)
  })

  it('accepts the roots a real claim uses', () => {
    for (const good of [
      '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh',
      '/tmp/extracted',
      'sibling-checkout',
    ]) {
      assert.equal(assertSafeRoot(good), good)
    }
  })

  it('accepts the revisions and paths a real claim uses', () => {
    for (const good of ['origin/master', 'HEAD~2', 'v0.2.0-rc.2', '639ed0153', 'refs/heads/main']) {
      assert.equal(assertSafeToken(good, 'revision'), good)
    }
    for (const good of ['packages', 'packages/core/tools/src/schema.ts', 'a-b_c.d/e']) {
      assert.equal(assertSafeToken(good, 'path'), good)
    }
  })

  it('refuses an empty or absurdly long token', () => {
    assert.throws(() => assertSafeToken('', 'path'), /1-400 characters/)
    assert.throws(() => assertSafeToken('a'.repeat(401), 'path'), /1-400 characters/)
  })
})

describe('plugin contract', () => {
  it('declares every service it reads', () => {
    assert.equal(name, 'check-claims')
    assert.equal(TOOL_NAME, 'check_claims')
    assert.deepEqual([...inject].sort(), ['systemPrompt', 'tools'])
  })

  // Asserting the returned shape against the declared schema is the check that
  // would have caught a declared-schema mismatch in the apply-patch tool, where
  // an undeclared property failed the call after the write had landed.
  it('declares every property a check returns', () => {
    const declared = Object.keys(
      (OUTPUT_SCHEMA.properties.checks.items as { properties: Record<string, unknown> }).properties,
    )
    const returned = ['pattern', 'path', 'at', 'root', 'verdict', 'count', 'detail', 'incomplete', 'sites']
    assert.deepEqual(returned.filter(key => !declared.includes(key)), [])
  })

  it('renders a failure with the fix-the-claim warning', () => {
    const failing: CheckValue = {
      pattern: 'x', path: 'p', at: null, root: null, verdict: 'fail' as Verdict,
      count: 3, detail: 'found 3, expected 0', incomplete: false,
      sites: [{ path: 'p', line: 12 }],
    }
    const text = formatReport({ checks: [failing] })
    assert.match(text, /\[FAIL\]/)
    assert.match(text, /p:12/)
    assert.match(text, /Fix the claim, not the pattern/)
  })

  // Task 54cb2d02, end to end through the registered tool rather than the
  // scanner: the claim being checked is about a tree the workspace does not
  // contain, which is the case the tool was built for and could not answer.
  it('answers a claim about a tree outside the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'claims-ws-'))
    const checkout = mkdtempSync(join(tmpdir(), 'claims-checkout-'))
    mkdirSync(join(checkout, 'packages', 'sandbox'), { recursive: true })
    writeFileSync(join(checkout, 'packages', 'sandbox', 'index.ts'), 'export const guard = 1\n')
    writeFileSync(join(workspace, 'local.ts'), 'export const guard = 1\n')

    const registered: { execute: (args: unknown, exec: unknown) => Promise<ReportValue> }[] = []
    apply({
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      tools: { register: (tool: unknown) => { registered.push(tool as typeof registered[0]); return () => {} }, get: () => ({}) },
      get: () => undefined,
    } as never)

    const exec = { agent: { session: { header: { cwd: workspace } } } }
    const { checks } = await registered[0].execute({
      checks: [
        { pattern: 'guard', path: 'packages/sandbox/index.ts', root: checkout, atLeast: 1 },
        // The control: the same claim without a root cannot see the checkout at
        // all, so the root is what answered it rather than a coincidence.
        { pattern: 'guard', path: 'packages/sandbox/index.ts', atLeast: 1 },
      ],
    }, exec)

    assert.equal(checks[0].verdict, 'pass')
    assert.equal(checks[0].root, checkout)
    assert.match(checks[0].detail, /rooted at /)
    assert.deepEqual(checks[0].sites, [{ path: 'packages/sandbox/index.ts', line: 1 }])
    assert.equal(checks[1].verdict, 'unknown')
    assert.match(checks[1].detail, /examined no files/)
  })

  it('registers a scope-guarded section, so an agent without the tool is not told to use it', () => {
    const sections: { name: string, text: (input: { scope?: unknown }) => string }[] = []
    const registered: unknown[] = []
    const ctx = {
      systemPrompt: {
        section: (section: unknown) => { sections.push(section as typeof sections[0]); return () => {} },
        getSectionOrder: () => 0,
      },
      tools: {
        register: (tool: unknown) => { registered.push(tool); return () => {} },
        get: (_name: string, scope?: unknown) => (scope === 'restricted' ? undefined : {}),
      },
      get: () => undefined,
    }
    apply(ctx as never)

    assert.equal(registered.length, 1)
    assert.equal(sections.length, 1)
    assert.match(sections[0].text({ scope: 'visible' }), /check_claims/)
    assert.equal(sections[0].text({ scope: 'restricted' }), '', 'must vanish when the tool is absent')
  })
})
