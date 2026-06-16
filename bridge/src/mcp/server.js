// MCP server — exposes tools to Claude Code over stdio.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { tools } from '../tools/index.js'
import { log } from '../log.js'

export async function startMcpServer({ hub }) {
  const server = new Server(
    { name: 'qqb-cc-bridge', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const tool = tools.find((t) => t.name === name)
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
      }
    }
    try {
      const result = await tool.handler({ args: args ?? {}, hub })
      return {
        content: [
          {
            type: 'text',
            text:
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
      }
    } catch (err) {
      log('warn', `tool ${name} failed: ${err.message}`)
      return {
        isError: true,
        content: [{ type: 'text', text: `error: ${err.message}` }],
      }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
