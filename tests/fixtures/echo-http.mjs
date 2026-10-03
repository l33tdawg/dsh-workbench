import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

/** A real SDK server already listening before Harness mounts its MCP client. */
export async function echoHttp() {
  const requests = []
  const listener = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    if (!req.headers.authorization?.startsWith('Bearer fixture-')) { res.writeHead(401).end(); return }
    requests.push(req.headers.authorization)
    const server = new McpServer({ name: 'shared-echo', version: '1.0.0' })
    server.registerTool('echo', { inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${listener.address().port}/v1/mcp/streamable`, requests,
    close: () => new Promise((resolve) => { listener.close(resolve); listener.closeAllConnections() }),
  }
}
