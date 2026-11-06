import { MCPServer } from 'mcp-use';
const server = new MCPServer({ name: 'gateway', version: '1.0.0', host: '127.0.0.1' });
await server.proxy({ alpha: { url: 'http://127.0.0.1:18101/mcp' } });
await server.listen(18132);
try { await server.proxy({ gamma: { url: 'http://127.0.0.1:18102/mcp' } }); console.log('late proxy ok'); } catch (e) { console.log('late proxy threw:', e.message); }
process.exit(0);
