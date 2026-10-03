#!/usr/bin/env node
/**
 * Score a completed benchmark run.
 *
 * The score is the fixture's own test suite, run against whatever the agent
 * left behind — with one protection that matters more than the rest: **the
 * fixture's `test/` directory and `package.json` are restored before the suite
 * runs.** Without that, "make the tests pass" has an easier solution than
 * fixing the code, and a run that deleted an assertion would score as a clean
 * pass. The agent's source changes are left exactly as it made them.
 *
 * The session the run produced is audited separately, because the fixture's
 * tests answer "is the patch correct" and the audit answers "did the agent
 * verify it" — the second question `RELIABILITY-EVAL.md` asks and the first
 * cannot see. `verify-on-edit` records its checks as durable session events, so
 * that read needs no instrumentation of its own.
 *
 * Usage:
 *   node bench/score.mjs --run .scratch/bench-runs/signature-change/off/rep-1
 *
 * @module bench/score
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = join(ROOT, 'bench', 'fixtures')

/**
 * Parse the command line.
 * @param argv - `process.argv`.
 * @returns the options.
 */
export function parseArgs(argv) {
  let run
  for (let index = 2; index < argv.length; index++) {
    if (argv[index] === '--run') run = argv[++index]
    else throw new Error(`unknown argument: ${argv[index]}`)
  }
  if (run === undefined) throw new Error('--run is required')
  return { run: resolve(run) }
}

/**
 * Read a fixture's summary counts from the TAP-ish output `node --test` prints.
 *
 * Silence is reported as unknown rather than as a pass: a suite that never ran
 * must not be indistinguishable from one that passed.
 * @param output - the combined stdout and stderr of the test command.
 * @returns the parsed counts, or `undefined` when no summary was printed.
 */
export function parseSummary(output) {
  const tests = /^# tests (\d+)$/m.exec(output)
  const pass = /^# pass (\d+)$/m.exec(output)
  const fail = /^# fail (\d+)$/m.exec(output)
  if (tests === null || pass === null || fail === null) return undefined
  return { tests: Number(tests[1]), pass: Number(pass[1]), fail: Number(fail[1]) }
}

/**
 * Restore the parts of a fixture an agent must not be able to change the rules with.
 * @param work - the run's work tree.
 * @param fixture - the fixture directory name.
 * @returns nothing.
 */
export function restoreScoringInputs(work, fixture) {
  const source = join(FIXTURES, fixture)
  rmSync(join(work, 'test'), { recursive: true, force: true })
  cpSync(join(source, 'test'), join(work, 'test'), { recursive: true })
  cpSync(join(source, 'package.json'), join(work, 'package.json'))
}

/**
 * Run the fixture's suite in a work tree.
 * @param work - the run's work tree.
 * @returns the exit code and combined output.
 */
export function runSuite(work) {
  const manifest = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8'))
  const script = manifest.scripts?.test
  if (typeof script !== 'string') throw new Error('the fixture declares no test script')
  try {
    const output = execFileSync('sh', ['-c', script], { cwd: work, encoding: 'utf8', stdio: 'pipe' })
    return { exitCode: 0, output }
  } catch (error) {
    return { exitCode: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/**
 * Audit the one session this run produced.
 *
 * The bench home is shared by every run, so reading its corpus whole would
 * answer a question about the corpus and report it as though it were about this
 * run - two runs against the same fixture then print identical counters.
 * `--session` narrows it; the id comes from the run's own stream.
 * @param home - the run's harness home.
 * @param sessionId - the session the run reported, if it reported one.
 * @returns the audit's totals, or `undefined` when they could not be read.
 */
export function auditCorpus(home, sessionId) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const args = [join(ROOT, 'tools', 'session-audit.mjs'), '--root', root, '--session', sessionId, '--json']
    const parsed = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }))
    return { sessionId, sessions: parsed.sessions, total: parsed.total }
  } catch {
    return undefined
  }
}

/** CLI entry point. */
function main() {
  const options = parseArgs(process.argv)
  const record = JSON.parse(readFileSync(join(options.run, 'result.json'), 'utf8'))
  if (record.dryRun === true) throw new Error('this run was a dry run; there is nothing to score')

  restoreScoringInputs(record.work, record.fixture)
  const suite = runSuite(record.work)
  const summary = parseSummary(suite.output)

  const score = {
    fixture: record.fixture,
    variant: record.variant,
    rep: record.rep,
    exitCode: record.exitCode,
    elapsedMs: record.elapsedMs,
    steps: record.steps,
    usage: record.usage,
    suiteExitCode: suite.exitCode,
    summary,
    /** `undefined` means the suite printed no summary - unknown, never a pass. */
    suitePassed: summary === undefined ? undefined : summary.fail === 0,
    patchBytes: record.patchBytes,
    corpus: auditCorpus(record.home, record.sessionId),
  }
  writeFileSync(join(options.run, 'score.json'), `${JSON.stringify(score, null, 2)}\n`)

  const verdict = summary === undefined ? 'UNKNOWN (no test summary)' : `${summary.pass}/${summary.tests} passed`
  console.log(`${record.fixture} ${record.variant} rep-${record.rep}: ${verdict}`)
  const counters = score.corpus?.total
  if (counters !== undefined) {
    console.log(`  session: ${counters.toolCalls} calls, ${counters.filesEdited} files edited, ` +
      `read-after-edit ${counters.readAfterEdit}, rework ${counters.rework}`)
  }
  if (suite.exitCode !== 0 && summary?.fail === 0) console.log('  the suite failed without reporting a failed test')
}

if (import.meta.url === `file://${process.argv[1]}`) main()
