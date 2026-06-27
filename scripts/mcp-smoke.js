// Smoke-test the MCP server with a real MCP client over stdio:
// spawn the server, list tools, call one, and a memory round-trip.
// Usage: node scripts/mcp-smoke.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m, d) => { failures++; console.error(`  ✗ ${m} — ${d}`); };

async function main() {
  const transport = new StdioClientTransport({ command: 'node', args: ['src/mcp/server.js'] });
  const client = new Client({ name: 'mcp-smoke', version: '1.0.0' });
  await client.connect(transport);
  console.log('MCP smoke test\n');

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const expected = ['get_farm_overview', 'get_paddy_status', 'recall_memory', 'save_memory', 'propose_irrigation'];
  expected.every((n) => names.includes(n))
    ? ok(`listTools → ${names.length} tools`)
    : fail('listTools', `missing some of ${expected.join(',')} (got ${names.join(',')})`);

  const farm = await client.callTool({ name: 'get_farm_overview', arguments: {} });
  const farmText = farm.content?.[0]?.text || '';
  farmText.includes('paddy-rice-3') ? ok('callTool get_farm_overview') : fail('callTool get_farm_overview', farmText.slice(0, 120));

  const save = await client.callTool({
    name: 'save_memory',
    arguments: { type: 'observation', text: 'mcp smoke memory', paddyId: 'paddy-rice-3' },
  });
  save.content?.[0]?.text?.includes('saved') ? ok('callTool save_memory') : fail('callTool save_memory', JSON.stringify(save));

  const recall = await client.callTool({ name: 'recall_memory', arguments: { query: 'mcp smoke', paddyId: 'paddy-rice-3' } });
  recall.content?.[0]?.text?.includes('mcp smoke') ? ok('callTool recall_memory') : fail('callTool recall_memory', JSON.stringify(recall));

  await client.close();
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('mcp smoke crashed:', err);
  process.exit(1);
});
