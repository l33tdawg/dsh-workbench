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
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { countMatches, judge, lineAt, type MatchSite } from '../src/match.ts'
import { assertSafeToken, inject, name, OUTPUT_SCHEMA, TOOL_NAME, apply } from '../src/index.ts'
import { DEFAULT_LIMITS, scan, type ScanResult, type ScanSource } from '../src/scan.ts'
import { formatReport, type CheckValue, type Verdict } from '../src/report.ts'
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
    const result = await scan(literalSource(files), 'f', { maxFiles: 3, maxFileBytes: 1000 })
    assert.equal(result.files.length, 3)
    assert.equal(result.incomplete, true)
    assert.match(result.reason ?? '', /10 files were in scope/)
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

describe('reading a revision', () => {
  // Failure 4: a claim about upstream checked against a tree carrying a patch.
  it('reads through git rather than the filesystem', async () => {
    const calls: string[][] = []
    const run = async (command: string, args: string[]): Promise<string> => {
      calls.push([command, ...args])
      if (args[0] === 'ls-tree') return 'src/a.ts\n'
      if (args[0] === 'show') return 'content at the revision\n'
      throw new Error(`unexpected ${args[0]}`)
    }
    const source = revisionSource('origin/master', run)
    const files = await source.list('src')
    const text = await source.read('src/a.ts')

    assert.deepEqual(files, ['src/a.ts'])
    assert.equal(text, 'content at the revision\n')
    assert.deepEqual(calls[0], ['git', 'ls-tree', '-r', '--name-only', 'origin/master', '--', 'src'])
    assert.deepEqual(calls[1], ['git', 'show', 'origin/master:src/a.ts'])
  })

  it('caches a listing so one path is listed once', async () => {
    let listings = 0
    const run = async (): Promise<string> => { listings++; return 'a\n' }
    const source = revisionSource('HEAD', run)
    await source.list('src')
    await source.list('src')
    assert.equal(listings, 1)
  })

  it('reports a missing revision as unreadable rather than empty', async () => {
    const run = async (): Promise<string> => { throw new Error('unknown revision') }
    const source = revisionSource('nope', run)
    assert.equal(await source.read('a.ts'), undefined)
  })

  it('names the revision in the report so the scope is visible', () => {
    const check: CheckValue = {
      pattern: 'x', path: 'p', at: 'origin/master', verdict: 'pass',
      count: 1, detail: 'found 1, expected 1 [revision origin/master]', incomplete: false, sites: [],
    }
    assert.match(formatReport({ checks: [check] }), /p @ origin\/master/)
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
    const returned = ['pattern', 'path', 'at', 'verdict', 'count', 'detail', 'incomplete', 'sites']
    assert.deepEqual(returned.filter(key => !declared.includes(key)), [])
  })

  it('renders a failure with the fix-the-claim warning', () => {
    const failing: CheckValue = {
      pattern: 'x', path: 'p', at: null, verdict: 'fail' as Verdict,
      count: 3, detail: 'found 3, expected 0', incomplete: false,
      sites: [{ path: 'p', line: 12 }],
    }
    const text = formatReport({ checks: [failing] })
    assert.match(text, /\[FAIL\]/)
    assert.match(text, /p:12/)
    assert.match(text, /Fix the claim, not the pattern/)
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
