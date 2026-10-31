// tower status [name] | restart <name> | validate [path]. Run through the ~/.local/bin/tower shim.
import { Agent } from 'undici';
import { loadConfig, readToken } from './config.js';

const dispatcher = new Agent({ connect: { timeout: 1_000 } }); // A port with no socket unit behind it hangs instead of refusing.

const fail: (message: string) => never = (message) => process.exit((console.error(message), 1));

async function api(path: string, method = 'GET') {
  const url = `http://127.0.0.1:${process.env.TOWER_PORT ?? 4800}${path}`;
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${readToken()}` }, dispatcher } as RequestInit).catch(() => null);
  if (!response) fail('tower is not reachable. Check: systemctl --user status tower.socket');
  console.log(JSON.stringify(await response.json().catch(() => response.statusText), null, 2));
  process.exit(response.ok ? 0 : 1);
}

function validate(path?: string) {
  try {
    const { upstreams, routes } = loadConfig(path);
    console.log(`ok: ${Object.keys(upstreams).length} upstreams, ${Object.keys(routes).length} routes`);
  } catch (err) {
    fail(`invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const [command, arg] = process.argv.slice(2);
if (command === 'status') await api(arg ? `/admin/upstreams/${encodeURIComponent(arg)}` : '/admin/status');
else if (command === 'restart' && arg) await api(`/admin/upstreams/${encodeURIComponent(arg)}/restart`, 'POST');
else if (command === 'validate') validate(arg);
else fail('usage: tower status [name] | tower restart <name> | tower validate [path]');
