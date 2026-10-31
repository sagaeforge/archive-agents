// Preloaded into the real server entry point. index.mjs always dials the PVE API port, so this moves
// that one port onto the test's fake PVE and logs what the server asked for. A request for any other
// port stays where it is and fails, and the server files themselves run exactly as shipped.
// FAKE_PVE_TIMEOUT_MS shortens the wait for a host that never answers. FAKE_PVE_HOST also sends every
// address to the fake, for a test of the default hosts that must not reach them.
import { appendFileSync } from "node:fs";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const PVE_API_PORT = 8006;
const { FAKE_PVE_HOST, FAKE_PVE_LOG, FAKE_PVE_PORT, FAKE_PVE_TIMEOUT_MS } = process.env;
const { request } = https;

https.request = (options, callback) => {
  appendFileSync(FAKE_PVE_LOG, `${JSON.stringify({ ...options, ca: String(options.ca) })}\n`);
  const port = options.port === PVE_API_PORT ? Number(FAKE_PVE_PORT) : options.port;
  const host = FAKE_PVE_HOST || options.host;
  return request({ ...options, host, port, timeout: Number(FAKE_PVE_TIMEOUT_MS) || options.timeout }, callback);
};
syncBuiltinESMExports();
