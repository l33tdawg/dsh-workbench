/** Tests for check-plan detection from a project's own declarations. */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { DETECTION_PATHS, detectCheck } from '../src/detect.ts'
import type { Detection, ListDir, ReadFile } from '../src/detect.ts'

/** Build a reader over a plain object of relative path to content. */
function reader(files: Record<string, string>): ReadFile {
  return path => files[path]
}

/** Build a reader over a real directory, as the plugin reads a workspace. */
function readerAt(root: string): ReadFile {
  return relative => {
    const path = join(root, relative)
    try {
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined
    } catch {
      return undefined
    }
  }
}

/** Build a directory lister over a real directory, as the plugin lists one. */
function listerAt(root: string): ListDir {
  return relative => {
    try {
      return readdirSync(join(root, relative))
    } catch {
      return undefined
    }
  }
}

/**
 * Materialize a project on disk so interpreter probing is exercised for real.
 *
 * @param files - relative paths to create, with empty content.
 * @param name - a suffix for the temporary directory.
 * @returns the project root.
 */
function project(files: Record<string, string>, name = 'voe-detect-'): string {
  const root = mkdtempSync(join(tmpdir(), name))
  dirs.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

/** A detection record to hand to `detectCheck` and inspect afterwards. */
function outcome(): Detection & { read: ReadFile } {
  return { searched: [], read: () => undefined }
}

const dirs: string[] = []
after(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('detectCheck', () => {
  it('prefers a declared typecheck script over every fallback', () => {
    const plan = detectCheck(reader({
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc -b', test: 'vitest' } }),
      'tsconfig.json': '{}',
      'Cargo.toml': '[package]',
    }))
    assert.equal(plan?.command, 'npm run --silent typecheck')
    assert.equal(plan?.cost, 'fast')
  })

  it('accepts a check:types alias', () => {
    const plan = detectCheck(reader({ 'package.json': JSON.stringify({ scripts: { 'check:types': 'vue-tsc' } }) }))
    assert.equal(plan?.command, 'npm run --silent check:types')
  })

  it('falls back to lint when no type check is declared', () => {
    const plan = detectCheck(reader({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }) }))
    assert.equal(plan?.label, 'lint')
  })

  // `test` is the slowest check and the one most likely to be red for unrelated
  // reasons, so it is opt-in rather than the default the agent has to live with.
  it('skips the test script unless slow checks are enabled', () => {
    const files = { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) }
    assert.equal(detectCheck(reader(files)), undefined)
    assert.equal(detectCheck(reader(files), true)?.command, 'npm run --silent test')
  })

  it('uses tsc when only a tsconfig proves TypeScript is in use', () => {
    const plan = detectCheck(reader({ 'tsconfig.json': '{"compilerOptions":{}}' }))
    assert.equal(plan?.command, 'npx --no-install tsc --noEmit --pretty false')
  })

  it('detects cargo', () => {
    assert.equal(detectCheck(reader({ 'Cargo.toml': '[package]' }))?.label, 'cargo check')
  })

  it('detects go', () => {
    assert.equal(detectCheck(reader({ 'go.mod': 'module x' }))?.label, 'go build')
  })

  it('detects ruff', () => {
    assert.equal(detectCheck(reader({ 'pyproject.toml': '[tool.ruff]' }))?.label, 'ruff')
  })

  it('detects a ruff config in a standalone file', () => {
    assert.equal(detectCheck(reader({ 'ruff.toml': 'line-length = 100' }))?.label, 'ruff')
  })

  // A bare pyproject.toml proves only that something in the tree is Python, and
  // running ruff against it would apply ruff's whole default rule set to code
  // that never opted into it. 2,293 such diagnostics were measured on one real
  // tree, which is noise the agent has no reason to act on.
  it('does not treat a bare pyproject.toml as a ruff project', () => {
    assert.equal(detectCheck(reader({ 'pyproject.toml': '[project]\nname = "x"' })), undefined)
  })

  it('runs ruff with a selector that does not impose undeclared style rules', () => {
    const root = project({
      'pyproject.toml': ['[tool.ruff]', 'line-length = 100', ''].join('\n'),
    })
    const detection = outcome()
    const plan = detectCheck(readerAt(root), true, detection)!
    const command = detection.render!(plan.command, root)
    assert.match(command, /--select E9,F/)
    assert.match(command, /--no-cache/)
    // `-o concise` is rejected by ruff; only the long flag produces the
    // `path:line:col:` shape the diagnostic parser reads.
    assert.match(command, /--output-format concise/)
  })

  // Reported from a repository that enforces ruff in CI over changed files
  // without ever writing a `[tool.ruff]` section. Requiring one would answer
  // "no check available" for a gate that fails its pull requests.
  describe('a linter declared by a dependency pin rather than a config file', () => {
    const pinned = {
      'requirements-test.txt': [
        '# test & lint dependencies',
        'pytest==9.0.3',
        'ruff==0.15.2               # the high-signal E9,F lint gate CI enforces on changed files',
        '',
      ].join('\n'),
      'tests/conftest.py': '',
    }

    it('is detected as a fast ruff check', () => {
      const root = project(pinned)
      assert.equal(detectCheck(readerAt(root))?.label, 'ruff')
    })

    it('is scoped to the edited Python files, not the project', () => {
      const root = project(pinned)
      const detection = outcome()
      const plan = detectCheck(readerAt(root), false, detection)!
      const command = detection.render!(plan.command, root, [`${root}/pkg/app.py`])
      assert.match(command, /'pkg\/app\.py'/)
      assert.doesNotMatch(command, /concise \./)
    })

    it('passes only the edited Python files, ignoring other extensions', () => {
      const root = project(pinned)
      const detection = outcome()
      const plan = detectCheck(readerAt(root), false, detection)!
      const command = detection.render!(plan.command, root, [`${root}/a.py`, `${root}/b.ts`, `${root}/c.py`])
      assert.match(command, /'a\.py' 'c\.py'/)
      assert.doesNotMatch(command, /b\.ts/)
    })

    // Ruff is run from the workspace root, so it cannot address a file outside
    // it, and a path escaping the root would lint an unrelated tree.
    it('ignores an edited file outside the workspace', () => {
      const root = project(pinned)
      const detection = outcome()
      const plan = detectCheck(readerAt(root), false, detection)!
      const command = detection.render!(plan.command, root, ['/elsewhere/other.py', '../outside.py'])
      assert.doesNotMatch(command, /other\.py|outside\.py/)
    })

    // With nothing edited there is nothing for a scoped linter to read. Linting
    // the whole project instead would answer a question nobody asked, and a
    // placeholder filename is worse: ruff reports E902 for a file that does not
    // exist, which reaches the agent as a failure that never happened.
    it('runs nothing, and reports no failure, when no Python file was edited', () => {
      const root = project(pinned)
      const detection = outcome()
      const plan = detectCheck(readerAt(root), false, detection)!
      const command = detection.render!(plan.command, root, [`${root}/lib/util.ts`])
      assert.equal(command, `printf '%s\\n' 'no changed Python file to lint'`)
    })

    it('passes several edited files as separate arguments', () => {
      const root = project(pinned)
      const detection = outcome()
      const plan = detectCheck(readerAt(root), false, detection)!
      const command = detection.render!(plan.command, root, [`${root}/a.py`, `${root}/dir with space/b.py`])
      assert.match(command, /'a\.py' 'dir with space\/b\.py'$/)
    })

    it('does not mistake an unrelated requirement for a ruff pin', () => {
      const root = project({ 'requirements.txt': 'ruff-lsp==1.0\npytest==9.0.3\n', 'tests/conftest.py': '' })
      assert.equal(detectCheck(readerAt(root), true)?.label, 'pytest')
    })

    // A config file states the project's own scope, so that run stays as it was.
    it('keeps a project-wide scope when a config file declares one', () => {
      const root = project({ ...pinned, 'ruff.toml': 'line-length = 100' })
      const detection = outcome()
      const plan = detectCheck(readerAt(root), false, detection)!
      assert.match(detection.render!(plan.command, root, [`${root}/pkg/app.py`]), /concise \./)
    })
  })

  // Python detection is exercised against real directories rather than a
  // synthetic reader, because the interpreter path it proves is later joined to
  // the workspace root. A fixture that answered for paths the filesystem does
  // not have would let those two halves drift apart without a failing test.
  describe('a Python tree that declares itself through its tests', () => {
    // The reported defect: a worktree holding 704 passing tests, no project
    // file, and a virtual environment one directory up was reported as having
    // no check at all.
    it('offers the suite as a withheld slow check', () => {
      const root = project({ 'tests/conftest.py': 'import sys' })
      const detection = outcome()
      assert.equal(detectCheck(readerAt(root), false, detection), undefined)
      assert.deepEqual(detection.skipped, { label: 'pytest' })
    })

    it('selects the suite when slow checks are enabled', () => {
      const root = project({ 'tests/conftest.py': 'import sys' })
      const plan = detectCheck(readerAt(root), true)
      assert.equal(plan?.label, 'pytest')
      assert.equal(plan?.cost, 'slow')
      assert.match(plan!.command, /--tb=line/)
    })

    it('prefers pytest when a pyproject.toml declares pytest but not ruff', () => {
      const root = project({
        'tests/conftest.py': '',
        'pyproject.toml': ['[tool.pytest.ini_options]', 'testpaths = ["tests"]', ''].join('\n'),
      })
      assert.equal(detectCheck(readerAt(root), true, outcome())?.label, 'pytest')
    })

    it('runs ruff when the tree declares ruff and pytest', () => {
      const root = project({
        'tests/conftest.py': '',
        'pyproject.toml': ['[tool.ruff]', '[tool.pytest.ini_options]', ''].join('\n'),
      })
      assert.equal(detectCheck(readerAt(root))?.label, 'ruff')
    })

    // A `tests/` directory is a JavaScript convention too, so only pytest's own
    // conftest.py is evidence of a Python suite.
    it('does not read a bare tests directory as a Python suite', () => {
      const root = project({ 'tests/index.ts': 'export {}' })
      assert.equal(detectCheck(readerAt(root), true), undefined)
    })
  })

  describe('an undeclared environment is not asked to lint', () => {
    it('probes ruff, then the suite, when only a virtual environment exists', () => {
      const root = project({ '.venv/bin/python': '', 'src/app.py': 'x = 1' })
      assert.equal(detectCheck(readerAt(root))?.label, 'ruff')
      assert.equal(detectCheck(readerAt(root), true)?.label, 'ruff')
    })
  })

  describe('rendering a runtime command', () => {
    it('uses the environment found beside the project', () => {
      const root = project({ '.venv/bin/python': '', 'tests/conftest.py': '' })
      const detection = outcome()
      const plan = detectCheck(readerAt(root), true, detection, listerAt(root))!
      const command = detection.render!(plan.command, root)
      assert.match(command, new RegExp(`'${root}/\\.venv/bin/python' -m pytest`))
    })

    /**
     * The reported layout: a linked worktree inside `.dsh-worktrees/<name>`,
     * whose checkout two levels up owns the environment. The worktree is `..`,
     * its container is `../..`, and only the grandparent is the project.
     */
    function linkedWorktree(): { root: string, checkout: string } {
      const checkout = project({
        'Makefile': 'test:\n\tpython3 -m pytest\n',
        'pyproject.toml': ['[project]', 'name = "checkout"', ''].join('\n'),
        '.venv/bin/python': '',
      })
      const root = join(checkout, '.dsh-worktrees', 'feat-branch')
      mkdirSync(join(root, 'tests'), { recursive: true })
      writeFileSync(join(root, 'tests', 'conftest.py'), '')
      writeFileSync(join(root, 'Makefile'), 'test:\n\tpython3 -m pytest\n')
      writeFileSync(join(root, '.git'), 'gitdir: ../.git/worktrees/feat-branch\n')
      return { root, checkout }
    }

    it('borrows the environment of a linked worktree checkout two levels up', () => {
      const { root, checkout } = linkedWorktree()
      const detection = outcome()
      const plan = detectCheck(readerAt(root), true, detection, listerAt(root))!
      const command = detection.render!(plan.command, root)
      assert.match(command, new RegExp(`'${join(checkout, '.venv/bin/python')}' -m pytest`))
    })

    // An ancestor that is only a container can hold an unrelated environment.
    // Adopting it would fail the suite for reasons this project never agreed to.
    it('refuses an ancestor environment when the ancestor shares no project files', () => {
      const container = project({ '.venv/bin/python': '' })
      const root = join(container, 'unrelated')
      mkdirSync(join(root, 'tests'), { recursive: true })
      writeFileSync(join(root, 'tests', 'conftest.py'), '')
      writeFileSync(join(root, 'AGENTS.md'), '')
      const detection = outcome()
      const plan = detectCheck(readerAt(root), true, detection, listerAt(root))!
      assert.match(detection.render!(plan.command, root), /python3/)
    })

    it('prefers a local environment over a borrowed one', () => {
      const checkout = project({ 'Makefile': '', '.venv/bin/python': '' })
      const root = join(checkout, 'worktree')
      for (const relative of ['.venv/bin/python', 'tests/conftest.py']) {
        mkdirSync(dirname(join(root, relative)), { recursive: true })
        writeFileSync(join(root, relative), '')
      }
      writeFileSync(join(root, 'Makefile'), '')
      const detection = outcome()
      const plan = detectCheck(readerAt(root), true, detection, listerAt(root))!
      assert.match(detection.render!(plan.command, root), new RegExp(`'${join(root, '.venv/bin/python')}'`))
    })

    // The bound is load-bearing: without it this walk would reach the user's
    // home directory and could adopt an unrelated environment several levels up.
    it('stops at the ancestor depth bound', () => {
      const checkout = project({ '.venv/bin/python': '', 'Makefile': '' })
      // Four levels below the checkout, so the environment is one level past
      // `PYTHON_ANCESTOR_DEPTH` and must not be borrowed.
      const root = join(checkout, 'l1', 'l2', 'l3', 'l4')
      mkdirSync(join(root, 'tests'), { recursive: true })
      writeFileSync(join(root, 'tests', 'conftest.py'), '')
      writeFileSync(join(root, 'Makefile'), '')
      const detection = outcome()
      const plan = detectCheck(readerAt(root), true, detection, listerAt(root))!
      assert.match(detection.render!(plan.command, root), /python3/)
    })

    it('falls back to a bare interpreter when no environment exists', () => {
      const root = project({ 'tests/conftest.py': '' })
      const detection = outcome()
      const plan = detectCheck(readerAt(root), true, detection, listerAt(root))!
      const command = detection.render!(plan.command, root)
      // The fallback resolves `python3` through the shell, because a bare name
      // is all that is known to exist when no environment was found.
      assert.match(command, /command -v python3/)
      assert.doesNotMatch(command, /\.venv/)
    })

    // A quote in the environment path would end the single-quoted word and let
    // the rest of the path run as a command, so it fails instead of running one.
    it('refuses an environment path containing a quote', () => {
      const root = project({ '.venv/bin/python': '', 'tests/conftest.py': '' }, "quote-'")
      const detection = outcome()
      const plan = detectCheck(readerAt(root), true, detection, listerAt(root))!
      assert.throws(() => detection.render!(plan.command, root), /refusing a path containing a quote/)
    })
  })

  it('records every declaration file it examined', () => {
    const detection = outcome()
    detectCheck(reader({ 'README.md': '# hi' }), false, detection)
    assert.deepEqual(detection.searched, [...DETECTION_PATHS])
  })

  // A repository that declares nothing gets nothing. Inventing a command would
  // produce failures the project never agreed to, and the agent would learn to
  // ignore the signal.
  it('returns nothing for a project that declares no check', () => {
    assert.equal(detectCheck(reader({ 'README.md': '# hi' })), undefined)
  })

  it('survives malformed package.json', () => {
    assert.equal(detectCheck(reader({ 'package.json': '{ not json' })), undefined)
  })

  it('survives a package.json with no scripts', () => {
    assert.equal(detectCheck(reader({ 'package.json': '{"name":"x"}' })), undefined)
  })

  it('ignores an empty-string script only if it is a known name', () => {
    const plan = detectCheck(reader({ 'package.json': JSON.stringify({ scripts: { typecheck: '' } }) }))
    assert.equal(plan?.command, 'npm run --silent typecheck')
  })
})
