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
 * @module @l33tdawg/dsh-verify-on-edit/detect
 */

/** How to check one project. */
export interface CheckPlan {
  /** Shell command to run, from the project root. */
  readonly command: string
  /** What the command checks, for the message the agent reads. */
  readonly label: string
  /** Rough cost class. `slow` plans are skipped unless the deployment opts in. */
  readonly cost: 'fast' | 'slow'
}

/** Reads a file's text, or returns `undefined` when it does not exist. */
export type ReadFile = (relativePath: string) => string | undefined

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
 * @param read - reads a project file by workspace-relative path.
 * @param allowSlow - whether `test`-class scripts may be selected.
 * @returns the plan, or `undefined` when the project declares no check.
 */
export function detectCheck(read: ReadFile, allowSlow = false): CheckPlan | undefined {
  const packageJson = read('package.json')
  if (packageJson !== undefined) {
    const declared = scripts(packageJson)
    if (declared.typecheck !== undefined) {
      return { command: 'npm run --silent typecheck', label: 'typecheck', cost: 'fast' }
    }
    if (declared['check:types'] !== undefined) {
      return { command: 'npm run --silent check:types', label: 'type check', cost: 'fast' }
    }
    if (declared.lint !== undefined) {
      return { command: 'npm run --silent lint', label: 'lint', cost: 'fast' }
    }
    if (allowSlow && declared.test !== undefined) {
      return { command: 'npm run --silent test', label: 'test suite', cost: 'slow' }
    }
  }

  // No declared script: fall back to a checker the project's own config proves
  // is in use. `--noEmit` keeps tsc from writing output beside the sources.
  if (read('tsconfig.json') !== undefined) {
    return { command: 'npx --no-install tsc --noEmit --pretty false', label: 'TypeScript', cost: 'fast' }
  }
  if (read('Cargo.toml') !== undefined) {
    return { command: 'cargo check --message-format short --quiet', label: 'cargo check', cost: 'fast' }
  }
  if (read('go.mod') !== undefined) {
    return { command: 'go build ./...', label: 'go build', cost: 'fast' }
  }
  if (read('pyproject.toml') !== undefined || read('ruff.toml') !== undefined) {
    return { command: 'ruff check --output-format concise .', label: 'ruff', cost: 'fast' }
  }
  return undefined
}
