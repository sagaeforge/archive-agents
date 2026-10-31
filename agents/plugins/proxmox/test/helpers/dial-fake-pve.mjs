// Preloaded into the real server entry point. index.mjs always dials the PVE API port, so this moves
// that one port onto the test's fake PVE and logs what the server asked for. A request for any other
// port stays where it is and fails, and the server files themselves run exactly as shipped.
import { appendFileSync } from "node:fs";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const PVE_API_PORT = 8006;
const { FAKE_PVE_LOG, FAKE_PVE_PORT } = process.env;
const { request } = https;

https.request = (options, callback) => {
  appendFileSync(FAKE_PVE_LOG, `${JSON.stringify({ ...options, ca: String(options.ca) })}\n`);
  const port = options.port === PVE_API_PORT ? Number(FAKE_PVE_PORT) : options.port;
  return request({ ...options, port }, callback);
};
syncBuiltinESMExports();
