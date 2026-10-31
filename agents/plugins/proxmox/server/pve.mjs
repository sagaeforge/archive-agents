import { readFileSync } from "node:fs";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "proxmox-mcp", "token");
const REQUEST_TIMEOUT_MS = 8000;

export class PveApiError extends Error {
  constructor(status, message) {
    super(`PVE API ${status}: ${message}`);
    this.status = status;
  }
}

export function loadToken(env = process.env) {
  if (env.PVE_API_TOKEN) return env.PVE_API_TOKEN.trim();
  const file = env.PVE_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`API token not found at ${file}. Run plugins/proxmox/scripts/bootstrap-token.sh first.`);
  }
}

// The cluster CA signs every node certificate, so all hosts share one trust root.
export function httpsTransport({ caFile }) {
  const ca = readFileSync(caFile);
  return (host, path, token) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          host,
          port: 8006,
          path: `/api2/json${path}`,
          method: "GET",
          ca,
          timeout: REQUEST_TIMEOUT_MS,
          headers: { Authorization: `PVEAPIToken=${token}` },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode, reason: res.statusMessage, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`)));
      req.on("error", reject);
      req.end();
    });
}

export function buildPath(path, params = {}) {
  if (!path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Invalid API path: ${path}`);
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

export function createClient({ hosts, getToken, transport }) {
  let preferred = 0;

  return {
    // GET only: this client deliberately has no way to issue a mutating request.
    async get(path, params) {
      const target = buildPath(path, params);
      const token = getToken();
      const failures = [];

      for (let i = 0; i < hosts.length; i++) {
        const index = (preferred + i) % hosts.length;
        let res;
        try {
          res = await transport(hosts[index], target, token);
        } catch (err) {
          failures.push(`${hosts[index]}: ${err.message}`);
          continue;
        }
        preferred = index;
        if (res.status !== 200) throw new PveApiError(res.status, res.reason);
        return JSON.parse(res.body).data;
      }
      throw new Error(`All PVE hosts unreachable (${failures.join("; ")})`);
    },
  };
}
