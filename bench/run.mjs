#!/usr/bin/env node
/**
 * Run one benchmark fixture in one configuration, and record what happened.
 *
 * The comparison this exists for is specified in `research/RELIABILITY-EVAL.md`:
 * the same small fixtures, model and reasoning setting, run against two
 * configurations that differ only in which plugin bundles are mounted, with the
 * resulting patch scored against the fixture's own tests.
 *
 * Three properties make the runs comparable, and each is deliberate:
 *
 * - **The fixture is a fresh copy per rep.** The agent's session workspace is
 *   that copy, so the harness's own file sandbox bounds it there, and no run can
 *   see another run's work.
 * - **The harness home is isolated** (`$DSH_HOME` under the output directory,
 *   never `~/.dsh`). Benchmark sessions therefore land in their own corpus and
 *   cannot be mistaken for real usage when the census is next run. Credentials
 *   are the one thing copied in, because an isolated home has none.
 * - **The configuration is a `--patch` overlay, not an installed profile.** The
 *   overlay is applied by the same loader path a bundle uses, so the plugins are
 *   mounted the way they are mounted for real; nothing is installed, and the
 *   "off" arm is the untouched shipped profile.
 *
 * Usage:
 *   node bench/run.mjs --fixture signature-change --variant off [--reps 1]
 *   node bench/run.mjs --fixture bug-fix --variant on --reps 3
 *
 * `--permission-mode` sets `DSH_PERMISSION_MODE` for the run. It exists because
 * of a nesting limit rather than a preference: DSH's macOS confinement applies
 * seatbelt via `sandbox-exec`, and `sandbox-exec` cannot be applied from inside
 * another sandbox. Launched from a confined shell, the inner sandbox fails
 * closed with `sandbox_apply: Operation not permitted` and every command is
 * refused, so the agent cannot run the fixture's tests at all. Passing
 * `danger-full-access` turns DSH's own sandbox off for the run, which means the
 * containment has to come from somewhere else - see `bench/README.md`.
 *
 * @module bench/run
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VARIANTS, overlayFor } from './variants.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = join(ROOT, 'bench', 'fixtures')
const DEFAULT_OUT = join(ROOT, '.scratch', 'bench-runs')

/** The benchmark image, built from `bench/container/Dockerfile`. */
const DEFAULT_IMAGE = 'dsh-bench:0.2.0-rc.2'

/** Where a container run mounts this checkout's `packages/`, read-only. */
const CONTAINER_PACKAGES = '/repo/packages'

/**
 * The shell a container run goes through before it starts the harness.
 *
 * The mounted plugins import the harness's own packages by name, and Node
 * resolves those by walking up from the importing file - which, for a file
 * under `/repo/packages/...`, never reaches the global install. Without this
 * link the plugins that import a package for its VALUE fail to load
 * (`dsh-compaction-todo` needs `createUserMessage` from `@deepseek-ai/dsh-llm`)
 * while the type-only imports are erased and load fine, so the arm silently
 * mounts a subset of what it claims to.
 *
 * `"$0" "$@"` rather than an interpolated command, so the task text reaches the
 * harness as one argument without being re-quoted by this shell.
 */
const CONTAINER_PRELUDE = 'ln -sfn "$(npm root -g)/@deepseek-ai/dsh/node_modules" /repo/node_modules; exec "$0" "$@"'

/**
 * Parse the command line.
 * @param {string[]} argv - `process.argv`.
 * @returns the options.
 */
export function parseArgs(argv) {
  const options = { reps: 1, variant: 'off', out: DEFAULT_OUT, model: undefined, dryRun: false, fixtures: [], permissionMode: undefined, container: false, image: DEFAULT_IMAGE }
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`${key} needs a value`)
      return value
    }
    if (key === '--fixture') options.fixtures.push(next())
    else if (key === '--variant') options.variant = next()
    else if (key === '--reps') options.reps = Number(next())
    else if (key === '--out') options.out = resolve(next())
    else if (key === '--model') options.model = next()
    else if (key === '--permission-mode') options.permissionMode = next()
    else if (key === '--container') options.container = true
    else if (key === '--image') options.image = next()
    else if (key === '--dry-run') options.dryRun = true
    else throw new Error(`unknown argument: ${key}`)
  }
  if (options.fixtures.length === 0) throw new Error('--fixture is required (repeatable)')
  if (!(options.variant in VARIANTS)) throw new Error(`--variant must be one of: ${Object.keys(VARIANTS).join(', ')}`)
  if (!Number.isInteger(options.reps) || options.reps < 1) throw new Error('--reps must be a positive integer')
  return options
}

/**
 * Prepare the isolated harness home.
 *
 * Credentials are copied because the home is new and would otherwise have none;
 * everything else about the home is left to the harness to create.
 * @param home - the harness home path.
 * @returns nothing.
 */
export function prepareHome(home) {
  mkdirSync(home, { recursive: true })
  const credentials = join(home, '.credentials.yaml')
  if (!existsSync(credentials)) {
    const source = join(homedir(), '.dsh', '.credentials.yaml')
    if (!existsSync(source)) throw new Error(`no credentials at ${source}; the benchmark cannot call a model without them`)
    cpSync(source, credentials)
  }
}

/**
 * Read a fixture's task text.
 * @param fixture - the fixture directory name.
 * @returns the task markdown.
 */
export function taskOf(fixture) {
  const path = join(FIXTURES, fixture, 'task.md')
  if (!existsSync(path)) throw new Error(`no task.md for fixture "${fixture}"`)
  return readFileSync(path, 'utf8')
}

/**
 * Parse the headless runner's newline-delimited events.
 *
 * A line that does not parse is kept rather than dropped: the runner's output
 * shape is not a contract this repository owns, and silently discarding what it
 * does not recognize is how a broken run reads as an empty one.
 * @param text - the captured stdout.
 * @returns the parsed events and the unparsed lines.
 */
export function parseEvents(text) {
  const events = []
  const unparsed = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      unparsed.push(line)
    }
  }
  return { events, unparsed }
}

/**
 * Summarize a run's events.
 * @param events - the parsed events.
 * @returns the final answer, session id, token totals and stop reason.
 */
export function summarize(events) {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
  let sessionId
  let final
  let reason
  let steps = 0
  for (const event of events) {
    if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
    if (event.type === 'final' && typeof event.text === 'string') final = event.text
    if (event.type === 'status' && event.phase === 'step_end') {
      steps++
      for (const key of Object.keys(usage)) usage[key] += event.usage?.[key] ?? 0
    }
    if (event.type === 'status' && event.phase === 'turn_end' && event.reason !== undefined) reason = event.reason
  }
  return { sessionId, final, usage, reason, steps }
}

/**
 * Run one rep.
 * @param options - the parsed options.
 * @param fixture - the fixture name.
 * @param rep - the 1-based repetition number.
 * @returns the run record.
 */
function runOne(options, fixture, rep) {
  const out = join(options.out, fixture, options.variant, `rep-${rep}`)
  rmSync(out, { recursive: true, force: true })
  const work = join(out, 'work')
  mkdirSync(work, { recursive: true })
  cpSync(join(FIXTURES, fixture), work, { recursive: true })

  // A committed baseline is what makes `git diff` afterwards the agent's patch
  // rather than the fixture's own contents.
  const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'pipe' })
  git('init', '--quiet')
  git('config', 'user.email', 'bench@localhost')
  git('config', 'user.name', 'bench')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'fixture baseline')

  const overlay = join(out, 'overlay.yml')
  // Inside a container the checkout is mounted read-only, so the overlay has to
  // name the paths the container sees rather than the ones this process sees.
  writeFileSync(overlay, overlayFor(options.variant, options.container ? CONTAINER_PACKAGES : undefined))

  const home = join(options.out, 'harness-home')
  prepareHome(home)

  // The container IS the boundary, so DSH's own sandbox stays off inside it.
  // On the host this has to be asked for explicitly, because with the inner
  // sandbox on a nested run gets no shell at all.
  const permission = options.permissionMode ?? (options.container ? 'danger-full-access' : undefined)

  const args = ['--profile', 'headless']
  if (VARIANTS[options.variant].length > 0) args.push('--patch', options.container ? '/out/overlay.yml' : overlay)
  if (options.model !== undefined) args.push('--model', options.model)
  args.push('--json', taskOf(fixture))

  let command = 'dsh'
  let commandArgs = args
  let cwd = work
  let env = { ...process.env, DSH_HOME: home }
  if (permission !== undefined) env.DSH_PERMISSION_MODE = permission
  if (options.container && !options.dryRun) {
    command = 'docker'
    commandArgs = [
      'run', '--rm',
      '--volume', `${out}:/out`,
      '--volume', `${home}:/dsh-home`,
      '--volume', `${join(ROOT, 'packages')}:${CONTAINER_PACKAGES}:ro`,
      '--workdir', '/out/work',
      '--env', 'DSH_HOME=/dsh-home',
      ...(permission === undefined ? [] : ['--env', `DSH_PERMISSION_MODE=${permission}`]),
      options.image,
      'sh', '-c', CONTAINER_PRELUDE, 'dsh', ...args,
    ]
    // Docker reads the host environment, not the container's; DOCKER_CONFIG in
    // particular may have been relocated to somewhere this sandbox can write.
    cwd = ROOT
    env = { ...process.env }
  }

  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  if (!options.dryRun) {
    // spawnSync, not execFileSync: execFileSync lets the child's stderr inherit
    // the terminal and returns only stdout, so a plugin that fails to import
    // prints its reason to the screen, is never recorded, and leaves a run that
    // exited 0 looking clean. A warning nobody kept is not a warning.
    const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env })
    stdout = result.stdout ?? ''
    stderr = result.stderr ?? ''
    exitCode = result.error === undefined ? (result.status ?? 1) : 1
    if (result.error !== undefined) stderr += `\n${String(result.error.message)}\n`
  }
  const elapsedMs = Date.now() - started

  const patch = options.dryRun ? '' : git('diff').toString()
  const { events, unparsed } = parseEvents(stdout)
  const summary = summarize(events)

  const record = {
    fixture,
    variant: options.variant,
    rep,
    dryRun: options.dryRun,
    permissionMode: options.permissionMode ?? (options.container ? 'danger-full-access (container default)' : '(profile default)'),
    container: options.container,
    image: options.container ? options.image : undefined,
    work,
    home,
    exitCode,
    elapsedMs,
    unparsed,
    ...summary,
    patchBytes: patch.length,
  }
  if (!options.dryRun) {
    writeFileSync(join(out, 'patch.diff'), patch)
    writeFileSync(join(out, 'stdout.ndjson'), stdout)
    writeFileSync(join(out, 'stderr.txt'), stderr)
    writeFileSync(join(out, 'answer.txt'), summary.final ?? '')
  }
  writeFileSync(join(out, 'result.json'), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** CLI entry point. */
function main() {
  const options = parseArgs(process.argv)
  const records = []
  for (const fixture of options.fixtures) {
    for (let rep = 1; rep <= options.reps; rep++) {
      const record = runOne(options, fixture, rep)
      records.push(record)
      const state = options.dryRun ? 'prepared (dry run)' : `exit ${record.exitCode}`
      console.log(`${fixture} ${options.variant} rep-${rep}: ${state}, ${record.steps} step(s), ${record.elapsedMs}ms`)
      if (record.unparsed.length > 0) console.log(`  ${record.unparsed.length} unparsed output line(s)`)
    }
  }
  mkdirSync(options.out, { recursive: true })
  writeFileSync(join(options.out, `run-${options.variant}-${Date.now()}.json`), `${JSON.stringify(records, null, 2)}\n`)
  console.log(`\n${records.length} run(s) recorded under ${options.out}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
