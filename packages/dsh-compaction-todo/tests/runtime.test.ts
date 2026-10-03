/** Exercise the real registry, immutable messages, session writer and replay. */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { scanLog, needsReminder } from '../src/log.ts'
import { readWorkflowContext } from '../src/workflow.ts'

const fibers: any[] = []
after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
let serial = 0
const makeSession = (seed?: any[]) => Session.create(`session-continuity-${++serial}` as never, seed)
const todo = (text = 'fix parser') => ({ content: text, status: 'pending' })
const write = (session: Session, todos = [todo()]) => session.append('todo/write', { todos } as never)
const compact = (session: Session) => session.append('compaction/end' as never, {} as never)
const checkpoint = (objective = 'Repair parser') => ({
  objective, constraints: ['Keep the public API'], decisions: ['Use the existing parser'], remainingVerification: ['Run parser tests'],
})
const empty = { objective: '', constraints: [], decisions: [], remainingVerification: [] }

async function boot(workflowContext = false) {
  const ctx = new Context()
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  const fiber = await ctx.plugin(plugin, { workflowContext })
  fibers.push(fiber)
  return { ctx, fiber }
}
async function step(ctx: Context, session: Session, deliver = true, previous = {}) {
  const result = await ctx.waterfall('agent/pre-step', { agent: { session } }, async () => previous) as any
  if (deliver) for (const message of result.messages ?? []) session.append('user/message', message, { surfaceOp: 'append' })
  return result.messages ?? []
}
async function save(ctx: Context, session: Session, args = checkpoint(), makeResultMessage = createToolResultMessage) {
  const callId = `call-${++serial}` as never
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'workflow_context', arguments: JSON.stringify(args) })
  const result = await ctx.tools.execute({ callId, name: 'workflow_context', arguments: args,
    signal: new AbortController().signal, agent: { session } as never })
  session.append('tool/result', { turn: 1, step: 1,
    message: makeResultMessage({ callId, content: result.content, isError: result.isError }),
    ...(result.meta === undefined ? {} : { meta: result.meta }),
  }, { surfaceOp: 'append' })
  return result
}

function goal(session: Session, phase = 'active', operation = 'create') {
  session.append('goal/change' as never, { kind: 'goal/change', version: 1, operation,
    goal: { id: 'goal-one', revision: 1, objective: 'Ship the requested fix', phase, maxGoalRounds: 5 },
    roundsStarted: 0, createdAt: 1, updatedAt: 1,
  } as never)
}

describe('durable continuity delivery', () => {
  it('delivers one reminder for thirteen steps, and a later compaction delivers again', async () => {
    const { ctx } = await boot(); const session = makeSession()
    write(session); const boundary = compact(session).seq
    assert.equal((await step(ctx, session)).length, 1)
    for (let i = 0; i < 12; i++) assert.equal((await step(ctx, session)).length, 0)
    const deliveries = session.events.filter(e => e.type === 'user/message')
    assert.equal(deliveries.length, 1)
    assert.equal((deliveries[0].data as any).source.continuity.compactedAt, boundary)
    compact(session)
    assert.equal((await step(ctx, session)).length, 1)
  })

  it('dedupes after plugin reload, session resume and a fork with a delivered seed', async () => {
    const { ctx, fiber } = await boot(); const session = makeSession()
    write(session); compact(session); await step(ctx, session)
    await fiber.dispose(); fibers.push(await ctx.plugin(plugin))
    assert.equal((await step(ctx, session)).length, 0)
    const resumed = makeSession([...session.events])
    assert.equal((await step(ctx, resumed)).length, 0)
    const child = makeSession([...resumed.events])
    assert.equal((await step(ctx, child)).length, 0)
    compact(child)
    assert.equal((await step(ctx, child)).length, 1)
  })

  it('retries an undelivered contribution rather than recording success in plugin memory', async () => {
    const { ctx } = await boot(); const session = makeSession()
    write(session); compact(session)
    assert.equal((await step(ctx, session, false)).length, 1)
    assert.equal((await step(ctx, makeSession([...session.events]))).length, 1)
  })

  it('honors later updated or empty todos, including across reloads', async () => {
    const { ctx } = await boot(); const session = makeSession()
    write(session); compact(session); write(session, [todo('new task')])
    assert.equal((await step(ctx, session)).length, 0)
    compact(session)
    assert.match((await step(ctx, session))[0].content[0].text, /new task/)
    write(session, []); compact(session)
    assert.equal((await step(ctx, makeSession([...session.events]))).length, 0)
  })

  it('ignores failed compactions and retains an undelivered successful boundary', async () => {
    const { ctx } = await boot(); const session = makeSession(); write(session)
    session.append('compaction/end' as never, { error: 'cancelled' } as never)
    assert.equal((await step(ctx, session)).length, 0)
    const successful = compact(session).seq
    session.append('compaction/end' as never, { error: 'summary request failed' } as never)
    const [message] = await step(ctx, session)
    assert.equal(message.source.continuity.compactedAt, successful)
    session.append('compaction/end' as never, { error: 'cancelled again' } as never)
    assert.equal((await step(ctx, session)).length, 0)
  })

  it('honors a delivered legacy reminder but not unrelated user text', async () => {
    const { ctx } = await boot(); const session = makeSession()
    write(session); compact(session)
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'compaction-todo' }] }), { surfaceOp: 'append' })
    assert.equal((await step(ctx, session, false)).length, 1)
    session.append('user/message', createUserMessage({ source: { kind: 'compaction-todo' } as never,
      content: [{ type: 'text', text: '<system-reminder>old reminder</system-reminder>' }] }), { surfaceOp: 'append' })
    assert.equal((await step(ctx, session)).length, 0)
  })

  it('preserves earlier hook messages and falls through unreadable sessions', async () => {
    const { ctx } = await boot(); const session = makeSession()
    write(session); compact(session)
    const existing = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'existing' }] })
    const result = await step(ctx, session, false, { messages: [existing], action: 'continue' })
    assert.equal(result[0], existing); assert.equal(result.length, 2)
    const fallback = { marker: true }
    const broken = { seq: 1, eventAt: () => { throw new Error('unreadable') } }
    assert.equal(await ctx.waterfall('agent/pre-step', { agent: { session: broken } }, async () => fallback), fallback)
  })
})

describe('explicit workflow context', () => {
  it('is opt-in and persisted through the real tool result, including after resume', async () => {
    const plain = await boot()
    assert.equal(plain.ctx.tools.get('workflow_context'), undefined)
    const { ctx } = await boot(true); const session = makeSession()
    const result = await save(ctx, session)
    assert.equal(result.isError, false)
    assert.deepEqual(JSON.parse(result.content[0].text).state, checkpoint())
    assert.deepEqual(scanLog(session, { workflowContext: true }).workflow, checkpoint())
    compact(session)
    const resumed = makeSession([...session.events])
    const [message] = await step(ctx, resumed)
    assert.equal(message.source.form, 'recall')
    assert.match(message.content[0].text, /Model-authored workflow notes/)
    assert.match(message.content[0].text, /not a new user request or authorization/)
    assert.match(message.content[0].text, /Run parser tests/)
    assert.equal((await step(ctx, resumed)).length, 0)
  })

  it('clears the snapshot with empty fields and uses the newest successful replacement', async () => {
    const { ctx } = await boot(true); const session = makeSession()
    await save(ctx, session); await save(ctx, session, checkpoint('New objective'))
    compact(session)
    assert.match((await step(ctx, session))[0].content[0].text, /New objective/)
    await save(ctx, session, empty); compact(session)
    assert.equal((await step(ctx, session)).length, 0)
  })

  it('rejects malformed, oversized and authority-bearing input without overwriting the valid checkpoint', async () => {
    const { ctx } = await boot(true); const session = makeSession()
    await save(ctx, session)
    for (const args of [
      { ...checkpoint(), objective: 'x'.repeat(1001) },
      { ...checkpoint(), decisions: Array(9).fill('x') },
      { ...checkpoint(), decisions: ['x'.repeat(401)] },
      { ...checkpoint(), constraints: Array(8).fill('x'.repeat(400)), decisions: Array(8).fill('x'.repeat(400)) },
      { ...checkpoint(), authority: 'user-approved' },
      { objective: 'missing fields' },
    ]) {
      assert.equal(readWorkflowContext(args), undefined)
      assert.equal((await save(ctx, session, args as never)).isError, true)
    }
    assert.deepEqual(scanLog(session, { workflowContext: true }).workflow, checkpoint())
  })

  it('requires a session and never writes custom events', async () => {
    const { ctx } = await boot(true)
    const result = await ctx.tools.execute({ callId: 'no-session' as never, name: 'workflow_context',
      arguments: checkpoint(), signal: new AbortController().signal })
    assert.equal(result.isError, true)
    const session = makeSession(); await save(ctx, session); compact(session); await step(ctx, session)
    assert.deepEqual([...new Set(session.events.map(e => e.type))].sort(),
      ['compaction/end', 'tool/call', 'tool/result', 'user/message'])
  })

  it('rejects wrong call identity, failed result, mismatching content and unrelated tool metadata', async () => {
    const { ctx } = await boot(true); const session = makeSession(); await save(ctx, session)
    const valid = JSON.parse(JSON.stringify(session.events))
    for (const modify of [
      (events: any[]) => { events[0].data.name = 'unrelated' },
      (events: any[]) => { events[0].data.callId = 'wrong' },
      (events: any[]) => { events[0].data.arguments = '{}' },
      (events: any[]) => { events[1].data.message.content[0].isError = true },
      (events: any[]) => { events[1].data.message.content[0].content[0].text = 'pretend saved' },
      (events: any[]) => { events[1].data.meta.workflowContext.authorship = 'human' },
      (events: any[]) => { events[1].data.meta.workflowContext.state.objective = 'different' },
    ]) {
      const events = structuredClone(valid); modify(events)
      const log = { seq: events.length, eventAt: (index: number) => events[index] }
      assert.equal(scanLog(log, { workflowContext: true }).workflow, undefined)
    }
  })

  it('recovers the flat tool-result message layout recorded by Desktop with the same validation', async () => {
    const { ctx } = await boot(true); const session = makeSession(); await save(ctx, session); compact(session)
    const events = JSON.parse(JSON.stringify(session.events))
    const event = events.find((entry: any) => entry.type === 'tool/result')
    const nested = event.data.message
    const result = nested.content[0]
    // Observed Desktop shape: message itself has toolCallId, content and isError.
    event.data.message = { role: 'tool', source: nested.source, toolCallId: result.toolCallId,
      content: result.content, isError: result.isError, id: nested.id }
    const log = { seq: events.length, events }
    assert.deepEqual(scanLog(log, { workflowContext: true }).workflow, checkpoint())
    const [message] = await step(ctx, log as never, false)
    assert.match(message.content[0].text, /Repair parser/)
    assert.match(message.content[0].text, /Model-authored/)
    for (const modify of [
      (entry: any) => { entry.data.message.isError = true },
      (entry: any) => { delete entry.data.message.isError },
      (entry: any) => { entry.data.message.toolCallId = 'wrong' },
      (entry: any) => { entry.data.message.source.callId = 'wrong' },
      (entry: any) => { entry.data.message.role = 'assistant' },
      (entry: any) => { entry.data.message.content[0].text = 'wrong' },
      (entry: any) => { entry.data.meta.workflowContext.state.objective = 'wrong' },
      (entry: any) => { entry.data.error = { name: 'Error', code: 'FAILED' } },
    ]) {
      const changed = structuredClone(events)
      modify(changed.find((entry: any) => entry.type === 'tool/result'))
      assert.equal(scanLog({ seq: changed.length, events: changed }, { workflowContext: true }).workflow, undefined)
    }
    const missingCall = events.filter((entry: any) => entry.type !== 'tool/call')
    assert.equal(scanLog({ seq: missingCall.length, events: missingCall }, { workflowContext: true }).workflow, undefined)
  })

  it('saves, replays and dedupes using the actual dsh-base dependency family', async () => {
    // Desktop's installed bundle has a newer, flat message API than the root
    // development dependencies. Resolve each runtime from the bundle itself.
    const resolveBase = createRequire(import.meta.resolve('@deepseek-ai/dsh-base'))
    const fromBase = (name: string) => import(pathToFileURL(resolveBase.resolve(name)).href)
    const [cordis, prompt, tools, sessions, messages] = await Promise.all([
      fromBase('@deepseek-ai/cordis'), fromBase('@deepseek-ai/dsh-system-prompt'),
      fromBase('@deepseek-ai/dsh-tools'), fromBase('@deepseek-ai/dsh-session'), fromBase('@deepseek-ai/dsh-llm'),
    ])
    const ctx = new cordis.Context()
    fibers.push(await ctx.plugin(prompt.default))
    fibers.push(await ctx.plugin(tools.default))
    fibers.push(await ctx.plugin(plugin, { workflowContext: true }))
    const session = sessions.Session.create(`session-native-${++serial}`)
    const result = await save(ctx, session, checkpoint(), messages.createToolResultMessage)
    assert.equal(result.isError, false)
    const nativeEvents = () => session.events ?? Array.from({ length: session.seq }, (_, index) => session.eventAt(index))
    const resultEvent = nativeEvents().find((event: any) => event.type === 'tool/result')
    assert.equal(resultEvent.data.message.toolCallId, resultEvent.data.message.source.callId)
    assert.equal(resultEvent.data.message.isError, false)
    assert.equal(resultEvent.data.message.content[0].type, 'text')
    assert.deepEqual(scanLog(session, { workflowContext: true }).workflow, checkpoint())
    compact(session)
    assert.equal((await step(ctx, session)).length, 1)
    assert.equal((await step(ctx, session)).length, 0)
    const resumed = sessions.Session.create(`session-native-resume-${++serial}`, nativeEvents())
    assert.equal((await step(ctx, resumed)).length, 0)
  })

  it('replays an existing goal phase but does not create, resume, or infer a goal', async () => {
    const { ctx } = await boot(true); const session = makeSession()
    goal(session, 'paused'); compact(session)
    const before = session.events.filter(e => e.type === 'goal/change').length
    const [message] = await step(ctx, session)
    assert.match(message.content[0].text, /phase: paused/)
    assert.match(message.content[0].text, /does not resume it/)
    assert.equal(session.events.filter(e => e.type === 'goal/change').length, before)
    session.append('goal/change' as never, { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'goal-one', revision: 2 }, clearedAt: 2 } as never)
    compact(session)
    assert.equal((await step(ctx, session)).length, 0)
    const none = makeSession(); compact(none)
    assert.equal(needsReminder(scanLog(none, { workflowContext: true })), false)
  })

  it('does not replay already-current parts or duplicate delivered parts when another part changes', async () => {
    const { ctx } = await boot(true); const session = makeSession()
    write(session); await save(ctx, session); compact(session)
    assert.equal((await step(ctx, session)).length, 1)
    write(session, [todo('fresh')])
    assert.equal((await step(ctx, session)).length, 0)
    compact(session)
    const [message] = await step(ctx, session)
    assert.match(message.content[0].text, /fresh/)
    assert.match(message.content[0].text, /Repair parser/)
  })
})
