// Does a 2026-07-28 input_required round trip survive a gateway? usage: _mrtr.mjs <url> <bearer|->
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const [url, bearer] = process.argv.slice(2);
const client = new Client({ name: 'mrtr', version: '0.0.1' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } });
let asked = 0;
client.setRequestHandler('elicitation/create', async () => { asked += 1; return { action: 'accept', content: { confirm: true } }; });
const headers = bearer === '-' ? {} : { authorization: `Bearer ${bearer}` };
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
const { tools } = await client.listTools();
const name = tools.find((t) => /confirm$/.test(t.name))?.name;
try {
  const r = await client.callTool({ name, arguments: {} }, { timeout: 15000 });
  console.log(`tool=${name} client asked ${asked}x result=${r.content?.[0]?.text?.slice(0, 120)} isError=${r.isError ?? false}`);
} catch (e) {
  console.log(`tool=${name} client asked ${asked}x FAILED ${String(e.message).slice(0, 160)}`);
}
process.exit(0);
