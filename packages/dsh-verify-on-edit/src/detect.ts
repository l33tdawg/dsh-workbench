/**
 * Decide what command checks a project, without running anything.
 *
 * Detection reads only what a repository already declares about itself. A
 * project that ships a `typecheck` script has told us how it wants to be
 * checked, and guessing past that would run the wrong tool slowly. When nothing
 * is declared, this returns nothing: a harness that invents a check command is
 * worse than one that stays quiet, because a false failure teaches the agent to
 * distrust the signal.
 *
 * Not finding a check and being unable to look for one are different answers,
 * and a caller that reports only the first one is lying about the second. Pass
 * `outcome` to receive which declaration files were examined and which check was
 * found but withheld, so the notice can say what it searched.
 *
 * @module @l33tdawg/dsh-verify-on-edit/detect
 */

import { join } from 'node:path'

/** How to check one project. */
export interface CheckPlan {
  /**
   * Shell command to run, from the project root, or a template whose `{python}`
   * placeholder is filled in by {@link Detection.render}.
   */
  readonly command: string
  /** What the command checks, for the message the agent reads. */
  readonly label: string
  /** Rough cost class. `slow` plans are skipped unless the deployment opts in. */
  readonly cost: 'fast' | 'slow'
}

/** Reads a file's text, or returns `undefined` when it does not exist. */
export type ReadFile = (relativePath: string) => string | undefined

/**
 * Lists one directory's entry names, or returns `undefined` when it cannot.
 *
 * Separate from {@link ReadFile} because identifying a Python ancestor requires
 * knowing what a directory holds, which no single read can answer.
 */
export type ListDir = (relativePath: string) => readonly string[] | undefined

/** Executables probed inside a Python environment, in preference order. */
export const PYTHON_INTERPRETERS: readonly string[] = ['.venv/bin/python', 'venv/bin/python']

/**
 * How many ancestor directories an environment may be borrowed from.
 *
 * A `git worktree` is created inside a container directory, so the checkout that
 * owns the environment is normally the grandparent rather than the parent. The
 * bound is what keeps this from becoming a search of the whole filesystem.
 */
export const PYTHON_ANCESTOR_DEPTH = 3

/**
 * Cap on how many project files are read to identify an ancestor.
 *
 * Bounds the probes a detection pass can make, so a directory with thousands of
 * entries cannot turn a check into a directory walk.
 */
export const ANNOTATION_LIMIT = 40

/**
 * Files that no project is identified by, so they are never compared when
 * looking for a shared declaration.
 *
 * `.git` leads the list because a linked worktree stores it as a file pointing
 * at the main repository. Every worktree has one, so treating it as a shared
 * declaration would make any ancestor holding a worktree look like the project.
 * Lockfiles follow for the same reason at smaller scale: two checkouts of
 * unrelated repositories can share a lockfile name without sharing a project.
 */
const NOISE_FILES = new Set([
  '.git', '.DS_Store', '.gitignore', '.gitattributes', '.dockerignore',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock',
])

/** Requirement files read for a pinned linter, in the order they are read. */
export const REQUIREMENT_PATHS: readonly string[] = [
  'requirements.txt', 'requirements-test.txt', 'requirements-dev.txt',
]

/**
 * Every declaration file detection examines, in the order it examines them.
 *
 * Exported so tests and the "found nothing" notice can refer to the same list
 * the code walks, rather than a second copy that silently drifts from it. A
 * path listed here that no branch examines is a bug in this list.
 */
export const DETECTION_PATHS: readonly string[] = [
  'package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod',
  'pyproject.toml', 'ruff.toml', 'pytest.ini', 'tests/conftest.py',
  ...REQUIREMENT_PATHS,
]

/** What one detection pass looked at, and why it stopped. */
export interface Detection {
  /** Every declaration file that was examined, whether or not it existed. */
  readonly searched: string[]
  /**
   * The check that was found but withheld because it is cost `slow` and the
   * deployment did not opt in. A caller must not report this as "no check".
   */
  readonly skipped?: { readonly label: string }
  /**
   * Fills runtime values into {@link CheckPlan.command} after detection: the
   * workspace root, and the paths this session has edited. The edited paths are
   * needed because a linter that no configuration file scopes has to be scoped
   * by what actually changed.
   */
  readonly render?: (command: string, root: string, edited?: readonly string[]) => string
}

/** Where a detected plan came from, so the caller can place it in the order. */
type Kind = 'declared' | 'marker' | 'runtime'

interface Candidate {
  readonly kind: Kind
  readonly plan: CheckPlan
}

const PYTEST_CONFIG = /^\s*\[tool\.pytest\.ini_options\]/m
const RUFF_SECTION = /^\s*\[tool\.ruff(?:\.|\])/m
/**
 * A ruff pin in a requirements file, as in `ruff==0.15.2  # the E9,F lint gate
 * CI enforces`. Matched on the requirement name rather than a config file,
 * because a repository can enforce ruff in CI without ever writing one.
 */
const RUFF_PIN = /^\s*ruff\s*(?:[<>=!~[]|$)/m

/**
 * Quote one placeholder value for a single-quoted shell word.
 *
 * The values are paths resolved from the workspace root, so a quote in one is
 * pathological rather than expected; refusing it is cheaper than carrying a
 * shell-quoting routine that would only ever be exercised by that pathology.
 *
 * @param value - the absolute path to substitute.
 * @returns the value, safe inside single quotes.
 */
function shellQuote(value: string): string {
  if (value.includes("'")) throw new Error(`verify-on-edit: refusing a path containing a quote: ${value}`)
  return `'${value}'`
}

/**
 * Choose the one command a detected Python project runs.
 *
 * A declared lint tool wins over a test runner because it is fast, and the plan
 * carries that cost class so `allowSlow` can withhold the test run.
 *
 * Ruff's scope depends on what scoped it. With a `[tool.ruff]` config the
 * project has said which files it covers, so the check runs over the project —
 * exactly as before. With only a requirements pin, the project has declared the
 * *tool* and its rules but not a scope, which is the shape a repository takes
 * when its CI lints changed files because the existing tree was never fully
 * linted. Running that repo-wide reports every pre-existing violation on every
 * edit, so a pinned plan carries a scope suffix that runs ruff over the files
 * this session touched, mirroring the CI job. Nothing is lost by narrowing
 * here: both selected rule families are per-file (syntax errors and undefined
 * names), so a whole-project run adds no cross-file finding, only files the
 * edit cannot have affected.
 *
 * When the suffix finds no edited Python file it exits zero without invoking
 * ruff. It must not run ruff over the project instead, and it must not pass a
 * placeholder argument: ruff reports `E902` for a file that does not exist, so a
 * stand-in name would turn "nothing to lint" into a lint failure.
 *
 * `ruff` always runs with `--select E9,F` and `--no-cache`. Without an explicit
 * selector ruff applies its entire default rule set, which turns a clean edit
 * into thousands of style diagnostics the project never agreed to; without
 * `--no-cache` ruff aborts when its cache directory falls outside the session
 * sandbox. `pytest` runs with `--tb=line`, whose `path:line: message` shape the
 * diagnostic parser recognizes.
 *
 * @param ruff - whether a ruff declaration was found.
 * @param slow - whether this plan is the withheld test run.
 * @param scoped - whether ruff's scope must come from the edited files.
 * @returns the plan, with placeholders for the interpreter and edited files.
 */
function pythonPlan(ruff: boolean, slow: boolean, scoped = false): CheckPlan {
  if (!ruff || slow) {
    return { command: '{python} -m pytest --tb=line -q', label: 'pytest', cost: slow ? 'slow' : 'fast' }
  }
  return {
    command: `{python} -m ruff check --no-cache --select E9,F --output-format concise ${scoped ? '{files}' : '.'}`,
    label: 'ruff',
    cost: 'fast',
  }
}

/**
 * The command for a scoped run that has no edited Python file to lint.
 *
 * A pinned-but-unconfigured project states no scope of its own, so ruff is run
 * over the edited files instead of the tree. When no Python file was edited
 * there is nothing to lint, and the check must say so without starting ruff:
 * passing a placeholder filename makes ruff report `E902` for a file that does
 * not exist, and exiting non-zero is reported to the agent as a failure that
 * never happened. This prints a line and exits zero.
 *
 * @returns the skip command.
 */
export function noFilesToLint(): string {
  return `printf '%s\\n' 'no changed Python file to lint'`
}

/**
 * Build the renderer that fills runtime values into a detected command.
 *
 * Detection already decided which interpreter exists, by reading the path the
 * caller exposes; rendering only joins it to the workspace root. Probing the
 * filesystem here as well would give the two answers a way to disagree.
 *
 * The fallback keeps a bootstrap command working on a machine where the project
 * has not created its environment yet, which is the state a fresh clone is in.
 *
 * @param root - the session workspace root.
 * @param relative - the interpreter path detection proved, when one exists.
 * @param scoped - whether the plan needs its scope from the edited files.
 * @returns a function that renders the final command.
 */
export function renderPython(
  root: string, relative: string | undefined, scoped = false,
): (command: string, edited?: readonly string[]) => string {
  const fallback = `command -v python3 >/dev/null 2>&1 && command python3 || command -v python >/dev/null 2>&1 && command python`
  return (command, edited = []) => {
    const base = command.replaceAll(
      '{python}', relative === undefined ? `(${fallback})` : shellQuote(join(root, relative)),
    )
    if (!scoped) return base
    const files = pythonFiles(root, edited)
    if (files.length === 0) return noFilesToLint()
    // `ruff` takes files as arguments, so no shell expansion is involved and a
    // name containing a space or a glob character stays one argument.
    return base.replace('{files}', files.map(shellQuote).join(' '))
  }
}

/**
 * The edited Python files, as paths relative to the workspace root.
 *
 * Only files inside the root are returned: a linter run from the root cannot
 * address anything outside it, and ruff would report its own "file not found"
 * rather than a finding about the edit. A path that is already relative is kept
 * as given, since it is relative to the same root.
 *
 * @param root - the session workspace root.
 * @param edited - the paths this session edited, absolute or relative.
 * @returns the relative paths of the edited Python files.
 */
function pythonFiles(root: string, edited: readonly string[]): string[] {
  const prefix = root.endsWith('/') ? root : `${root}/`
  const relative = edited.map(path => path.startsWith(prefix) ? path.slice(prefix.length) : path)
  return relative.filter(path => path.endsWith('.py') && !path.startsWith('/') && !path.split('/').includes('..'))
}

/** Parse a package.json's scripts without throwing on malformed input. */
function scripts(packageJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> }
    return parsed.scripts ?? {}
  } catch {
    return {}
  }
}

/**
 * Choose a check plan for a project.
 *
 * Order matters. A declared script wins over a raw tool invocation, because the
 * project's own script carries the flags its authors need. Among declared
 * scripts, `typecheck` wins over `test`: it is the check that most often catches
 * a bad edit, and the one fast enough to run while the agent is still working.
 *
 * A tree with no project file at all is not necessarily unchecked. Worktrees and
 * service checkouts routinely carry only a test tree, and for those the project
 * is proved by its tests rather than by a configuration file, so the test runner
 * is the check. It keeps cost `slow` and is withheld unless `allowSlow` is set,
 * which means a caller that reports only "no check" would hide a runnable suite
 * behind a message that reads like an excuse. That is why the withheld check is
 * reported through `outcome` instead of being dropped.
 *
 * @param read - reads a project file by workspace-relative path.
 * @param allowSlow - whether `test`-class scripts may be selected.
 * @param outcome - optional record of what was examined and what was withheld.
 * @param list - lists a directory's entries, needed only to find a Python
 *   environment borrowed from an ancestor directory.
 * @returns the plan, or `undefined` when the project declares no check.
 */
export function detectCheck(
  read: ReadFile, allowSlow = false, outcome?: Detection, list?: ListDir,
): CheckPlan | undefined {
  const seen = new Set<string>()
  const examine = (relative: string): string | undefined => {
    seen.add(relative)
    return read(relative)
  }

  const found: Candidate[] = []
  const packageJson = examine('package.json')
  if (packageJson !== undefined) {
    const declared = scripts(packageJson)
    if (declared.typecheck !== undefined) {
      found.push({ kind: 'declared', plan: { command: 'npm run --silent typecheck', label: 'typecheck', cost: 'fast' } })
    }
    if (declared['check:types'] !== undefined) {
      found.push({ kind: 'declared', plan: { command: 'npm run --silent check:types', label: 'type check', cost: 'fast' } })
    }
    if (declared.lint !== undefined) {
      found.push({ kind: 'declared', plan: { command: 'npm run --silent lint', label: 'lint', cost: 'fast' } })
    }
    if (declared.test !== undefined) {
      found.push({ kind: 'declared', plan: { command: 'npm run --silent test', label: 'test suite', cost: 'slow' } })
    }
  }

  // No declared script: fall back to a checker the project's own config proves
  // is in use. `--noEmit` keeps tsc from writing output beside the sources.
  if (examine('tsconfig.json') !== undefined) {
    found.push({ kind: 'marker', plan: { command: 'npx --no-install tsc --noEmit --pretty false', label: 'TypeScript', cost: 'fast' } })
  }
  if (examine('Cargo.toml') !== undefined) {
    found.push({ kind: 'marker', plan: { command: 'cargo check --message-format short --quiet', label: 'cargo check', cost: 'fast' } })
  }
  if (examine('go.mod') !== undefined) {
    found.push({ kind: 'marker', plan: { command: 'go build ./...', label: 'go build', cost: 'fast' } })
  }

  // Ruff counts as declared when the project configures it, or when it pins it
  // as a dependency. A repository can enforce ruff in CI against changed files
  // without ever writing a `[tool.ruff]` section, and requiring one would report
  // "no check available" for a gate that fails its pull requests. A cache
  // directory left by a hand-run `ruff check --select ...` is still not a
  // declaration.
  const pyproject = examine('pyproject.toml')
  const ruffConfig = examine('ruff.toml')
  const configured = ruffConfig !== undefined || (pyproject !== undefined && RUFF_SECTION.test(pyproject))
  const pinned = !configured && REQUIREMENT_PATHS.some(path => {
    const text = examine(path)
    return text !== undefined && RUFF_PIN.test(text)
  })
  const linted = configured || pinned
  // A `tests/conftest.py` is pytest's own layout. Reading the directory first
  // would call any tree that happens to have a `tests` directory a Python suite.
  const suite = pyproject !== undefined && PYTEST_CONFIG.test(pyproject)
    || examine('pytest.ini') !== undefined
    || examine('tests/conftest.py') !== undefined
  const environment = resolvePython(read, list)
  if (linted || suite || environment) {
    // Ruff is the fast check even when the tree also has tests, so a failing
    // lint run is reported on its own rather than inside a whole-suite run.
    // A pin states the tool and the rules but not a scope, so it is scoped to
    // the edited files; a config file states the scope and is left alone.
    found.push({ kind: 'runtime', plan: pythonPlan(linted, !linted, pinned) })
    // Tests outrank a linter this project has not declared: an undeclared ruff
    // runs someone else's rule set over code that has never been held to it.
    if (linted && suite) found.push({ kind: 'runtime', plan: pythonPlan(false, true) })
    if (!linted && !suite && environment) {
      // Only an environment was found. `ruff` is probed in it because a console
      // script does not have to be importable as a module in the same way.
      found.push({ kind: 'runtime', plan: pythonPlan(true, false) })
      found.push({ kind: 'runtime', plan: pythonPlan(false, true) })
    }
  }

  const fast = found.find(candidate => candidate.plan.cost === 'fast')
  const slow = found.find(candidate => candidate.plan.cost === 'slow')
  if (outcome !== undefined) {
    // Only declared paths are reported, so the notice never claims to have
    // examined an ancestor directory it merely probed an interpreter under. The
    // order follows the declaration list rather than the walk, because the walk
    // visits requirement files last and the notice reads as a description of
    // what detection looks for.
    const declared = new Set([...seen].filter(path => DETECTION_PATHS.includes(path)))
    outcome.searched.push(...DETECTION_PATHS.filter(path => declared.has(path)))
    if (slow !== undefined) outcome.skipped = { label: slow.plan.label }
    if (fast?.kind === 'runtime' || (!fast && slow?.kind === 'runtime')) {
      outcome.render = (command, root, edited) => renderPython(root, environment, pinned)(command, edited)
    }
  }
  if (fast !== undefined) return fast.plan
  return allowSlow ? slow?.plan : undefined
}

/**
 * Find the Python interpreter a project's environment provides.
 *
 * The project's own environment is taken as offered. An ancestor's is a borrow,
 * and borrowing wrongly is worse than not borrowing: a tree whose Python is not
 * the one its tests were written for fails wholesale, which teaches the agent
 * to distrust the signal. So an ancestor qualifies only when it *shares
 * declaration files* with the workspace — a `Makefile`, an `AGENTS.md`, a
 * source file the worktree also holds — which is what distinguishes the checkout
 * that owns a worktree from a container directory that merely holds it.
 *
 * The qualifying set is derived from the workspace's own entries rather than
 * from a fixed list of names, because a fixed list cannot recognize a checkout
 * whose project files are named something else.
 *
 * @param read - reads a file relative to the project root.
 * @param list - lists one directory's entries, or returns `undefined`.
 * @returns the interpreter path relative to the root, or `undefined`.
 */
function resolvePython(read: ReadFile, list: ListDir | undefined): string | undefined {
  const local = PYTHON_INTERPRETERS.find(interpreter => read(interpreter) !== undefined)
  if (local !== undefined) return local
  if (list === undefined) return undefined

  const annotations = new Set(
    (list('.') ?? []).filter(entry => !NOISE_FILES.has(entry)).slice(0, ANNOTATION_LIMIT),
  )
  if (annotations.size === 0) return undefined

  // Load-bearing for the same reason the noise list is: an ancestor that holds
  // the `.git` file of a linked worktree would otherwise match on that alone.
  annotations.delete('.git')

  for (let depth = 1; depth <= PYTHON_ANCESTOR_DEPTH; depth++) {
    const ancestor = Array.from({ length: depth }, () => '..').join('/')
    const entries = list(`${ancestor}/.`) ?? []
    const shared = entries.some(entry => annotations.has(entry))
    if (!shared) continue
    for (const interpreter of PYTHON_INTERPRETERS) {
      const candidate = `${ancestor}/${interpreter}`
      if (read(candidate) !== undefined) return candidate
    }
  }
  return undefined
}
