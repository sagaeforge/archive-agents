// Stand-in HTTP upstream added for the tower scenarios: legacy Streamable HTTP with no SDK, so a failure can be put on any one message.
// RAW_HANG_INITIALIZED leaves notifications/initialized unanswered. RAW_LIST_500_AFTER answers tools/list with HTTP 500 after that many lists.
// RAW_ECHO=http|rpc answers tools/call, prompts/get and resources/read by quoting the headers it got, the way an API reports a rejected key.
import http from 'node:http';

const E = process.env;
let lists = 0;
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const m = JSON.parse(body);
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o })); };
    if (m.id === undefined) {
      if (E.RAW_HANG_INITIALIZED && m.method === 'notifications/initialized') return undefined;
      res.writeHead(202);
      return res.end();
    }
    const quoted = `rejected ${JSON.stringify(req.headers)}`;
    switch (m.method) {
      case 'server/discover': return json({ error: { code: -32601, message: 'Method not found' } });
      case 'initialize': return json({ result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'raw', version: '1' } } });
      case 'tools/list':
        lists += 1;
        if (E.RAW_LIST_500_AFTER && lists > Number(E.RAW_LIST_500_AFTER)) { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('list refused'); }
        return json({ result: { tools: [{ name: 'whoami', description: 'x', inputSchema: { type: 'object' } }] } });
      case 'prompts/list': return json({ result: { prompts: [{ name: 'hello' }] } });
      case 'resources/list': return json({ result: { resources: [{ uri: 'raw://one', name: 'one' }] } });
      case 'resources/templates/list': return json({ result: { resourceTemplates: [] } });
      default:
    }
    if (E.RAW_ECHO === 'http') { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end(quoted); }
    if (E.RAW_ECHO === 'rpc') return json({ error: { code: -32000, message: quoted, data: { said: quoted } } });
    return json({ result: { content: [{ type: 'text', text: 'ok' }] } });
  });
});
server.listen(Number(E.RAW_PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
