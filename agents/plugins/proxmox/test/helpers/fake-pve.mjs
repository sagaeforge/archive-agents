// A local PVE stand-in, and the throwaway directory the tests around it need.
import { mkdtempSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LOOPBACK = "127.0.0.1";

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "proxmox-mcp-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Serves on a free loopback port until the test ends, hanging up on anyone still connected.
export async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

// `requests` records what actually arrived, not what the client meant to send.
export async function startFakePve(t, credentials, data = { served: true }) {
  const requests = [];
  const server = https.createServer(credentials, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { method, url, headers } = req;
      requests.push({ method, url, headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  return { port: await listen(t, server), requests };
}
