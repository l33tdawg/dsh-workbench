/** Current installed Cordis, policy, and shell resolver contracts; execution is a spy. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import * as verify from '../src/index.ts'

const runtime = createRequire(import.meta.resolve('@deepseek-ai/dsh-base'))
const { Context } = await import(runtime.resolve('@deepseek-ai/cordis'))
const { default: SystemPrompt } = await import(runtime.resolve('@deepseek-ai/dsh-system-prompt'))
const { default: ToolRuntime, defineTool } = await import(runtime.resolve('@deepseek-ai/dsh-tools'))
const { default: Projections } = await import(runtime.resolve('@deepseek-ai/dsh-session-projection'))
const { default: SandboxPolicy } = await import(runtime.resolve('@deepseek-ai/dsh-sandbox-policy'))
const { default: SandboxBash } = await import(runtime.resolve('@deepseek-ai/dsh-bash-sandbox'))
const { Session } = await import(runtime.resolve('@deepseek-ai/dsh-session'))

describe('installed policy and shell services', () => {
  for (const dropped of [undefined, 'sandboxPolicy', 'signal', 'onExpiry', 'stdoutMaxBytes']) {
    const incompatible = dropped !== undefined
    it(incompatible ? `refuses an executor that drops ${dropped}` : 'loads through real Cordis injection and preserves the session override in the real shell resolver', async () => {
      const ctx = new Context()
      const fibers: any[] = []
      const requests: any[] = [], executions: any[] = []
      // Use the genuine local + sandbox resolver, with its real volatile config
      // and policy service. Only process execution is replaced: this test must
      // not spawn a shell or require a platform sandbox installation.
      class RecordingBash extends SandboxBash {
        static inject = ['sandboxPolicy']
        resolve(request: any) {
          requests.push(request)
          const spec = super.resolve(request)
          if (dropped) delete spec[dropped]
          return spec
        }
        async execute(spec: any) {
          executions.push(spec)
          return { result: async () => ({ exitCode: 0, timedOut: false, aborted: false }) }
        }
      }
      try {
        fibers.push(await ctx.plugin(SystemPrompt))
        fibers.push(await ctx.plugin(ToolRuntime))
        fibers.push(await ctx.plugin(Projections))
        fibers.push(await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: '/fallback' }))
        fibers.push(await ctx.plugin(RecordingBash))
        fibers.push(await ctx.plugin(verify, { command: 'project-check', timeoutMs: 1234 }))
        ctx.tools.register(defineTool({
          name: 'edit', description: 'Test edit', parameters: { file_path: { type: 'string', required: true } },
          output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } }, render: () => [{ type: 'text', text: 'edited' }] },
          execute: async (args: any) => ({ path: args.file_path }),
        }))
        const seedHeader = Session.create('verification-policy').header
        const session = Session.create('verification-policy', undefined, { ...seedHeader, cwd: '/session-workspace' })
        session.append('sandbox/mode', { mode: 'read-only' })
        session.append('turn/start', { turn: 1 })
        const expected = ctx.get('sandboxPolicy').resolve({ session })
        assert.equal(expected.mode, 'read-only')
        assert.equal(expected.workspaceRoot, '/session-workspace')
        const caller = new AbortController()
        const result = await ctx.tools.execute({
          callId: 'edit-A', name: 'edit', arguments: { file_path: 'src/A.ts' }, signal: caller.signal,
          agent: { id: session.id, session, ctx, status: 'running' },
        })
        assert.equal(result.isError, false)
        assert.equal(requests.length, 1, 'the injected plugin must really activate')
        assert.deepEqual(requests[0].sandboxPolicy, expected)
        assert.equal(requests[0].onExpiry, 'kill')
        assert.equal(requests[0].timeoutMs, 1234)
        assert.equal(requests[0].stdoutMaxBytes, 32768)
        assert.ok(requests[0].signal instanceof AbortSignal)
        if (incompatible) {
          assert.equal(executions.length, 0, 'missing policy must never reach process execution')
          assert.match(JSON.stringify(result), /verify-on-edit: unavailable/)
        } else {
          assert.equal(executions.length, 1)
          assert.deepEqual(executions[0].sandboxPolicy, expected)
          assert.equal(executions[0].signal, requests[0].signal)
          assert.equal(executions[0].onExpiry, 'kill')
          assert.equal(executions[0].timeoutMs, 1234)
          assert.equal(executions[0].stdoutMaxBytes, 32768)
          assert.match(JSON.stringify(result), /verify-on-edit: passed/)
        }
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      }
    })
  }
})
