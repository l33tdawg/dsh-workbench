// Minimal stdio MCP server used by the integration test: one `echo` tool.
// The SDK owns the protocol, so the test asserts on real traffic rather than a
// hand-rolled client/server imitation.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo-fixture', version: '0.0.1' })

server.registerTool(
  'echo',
  {
    description: 'Return the text it was given.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: 'text', text }] }),
)

await server.connect(new StdioServerTransport())
