#!/usr/bin/env node
// Token CLI contract fixture. Never starts a MCP server or chain node.
import { appendFileSync } from 'node:fs'
const [command, action, ...args] = process.argv.slice(2)
if (command !== 'mcp-token' || !['create', 'revoke'].includes(action)) process.exit(99)
if (process.env.FIXTURE_CALLS) appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ command, action, args, url: process.env.SAGE_API_URL }) + '\n')
if (process.env.FIXTURE_FAIL) {
  console.log('Token: secret-that-must-never-be-logged')
  console.error('secret-that-must-never-be-logged')
  process.exit(1)
}
if (action === 'create') {
  console.log('ID: 00000000-0000-4000-8000-000000000001')
  console.log(`Agent: ${args[args.indexOf('--agent') + 1]}`)
  console.log(`Token: fixture-${args[args.indexOf('--name') + 1]}`)
}
