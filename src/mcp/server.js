// ──────────────────────────────────────────────────────────────────────────
// NaLog Agent — Model Context Protocol (MCP) server.
//
// Exposes the agent's agronomy capabilities as MCP tools over stdio, so ANY MCP
// client (Claude Desktop, Cursor, other agents) can read NaLog field state,
// query the farmer's memory, and prepare human-in-the-loop irrigation proposals.
// The same tool handlers power the in-app ReAct loop and this MCP surface — one
// implementation, two integration paths.
//
// Run:  node src/mcp/server.js     (or: npm run mcp)
// ──────────────────────────────────────────────────────────────────────────
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryManager } from '../memory/memoryManager.js';
import { getStore } from '../memory/store/index.js';
import { handlers } from '../agent/tools.js';
import { DEMO_FARMER } from '../integrations/demoData.js';

const FARMER_ID = process.env.MCP_FARMER_ID || DEMO_FARMER.farmerId;

export async function buildMcpServer() {
  const memory = await MemoryManager.create();
  const store = await getStore();

  const server = new McpServer({ name: 'nalog-agent', version: '0.1.0' });

  // Each MCP call gets a fresh agent context bound to the configured farmer.
  const newCtx = () => ({
    farmerId: FARMER_ID,
    sessionId: 'mcp',
    paddyId: null,
    memory,
    store,
    createdProposals: [],
    recalledMemories: [],
  });

  const text = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });

  const register = (name, def, handlerName) =>
    server.registerTool(name, def, async (args) => {
      try {
        return text(await handlers[handlerName](args || {}, newCtx()));
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    });

  register(
    'get_farm_overview',
    { title: 'Farm overview', description: 'List the farmer\'s farms and paddies (crop type, growth stage).', inputSchema: {} },
    'get_farm_overview'
  );

  register(
    'get_paddy_status',
    {
      title: 'Paddy status',
      description: 'Current real state of a paddy: crop, growth stage, AWD phase, sensors, latest readings and trend.',
      inputSchema: { paddyId: z.string().describe('Paddy id, e.g. paddy-rice-3') },
    },
    'get_paddy_status'
  );

  register(
    'get_sensor_history',
    {
      title: 'Sensor history',
      description: 'Summarised sensor readings over the last N hours.',
      inputSchema: { sensorId: z.string(), hours: z.number().optional().describe('Lookback hours (default 72)') },
    },
    'get_sensor_history'
  );

  register(
    'recall_memory',
    {
      title: 'Recall memory',
      description: 'Recall the most relevant past experience/preferences for the farmer.',
      inputSchema: { query: z.string(), paddyId: z.string().optional() },
    },
    'recall_memory'
  );

  register(
    'save_memory',
    {
      title: 'Save memory',
      description: 'Save a durable piece of field experience for next season.',
      inputSchema: {
        type: z.enum(['observation', 'preference', 'outcome', 'decision']),
        text: z.string(),
        paddyId: z.string().optional(),
        structured: z.record(z.any()).optional(),
      },
    },
    'save_memory'
  );

  register(
    'propose_irrigation',
    {
      title: 'Propose irrigation (human-in-the-loop)',
      description: 'Prepare a pump action for human approval. Never executes by itself.',
      inputSchema: {
        paddyId: z.string(),
        action: z.enum(['on', 'off']),
        reason: z.string(),
      },
    },
    'propose_irrigation'
  );

  return server;
}

// Start over stdio when run directly.
const isMain = process.argv[1] && process.argv[1].endsWith('mcp/server.js');
if (isMain) {
  const server = await buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP uses stdout for protocol; log to stderr only.
  console.error('nalog-agent MCP server running on stdio');
}
