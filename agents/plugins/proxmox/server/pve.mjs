import { readFileSync } from "node:fs";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "proxmox-mcp", "token");
const REQUEST_TIMEOUT_MS = 8000;

const STATUS_HINTS = {
  401: "The token was rejected: it was revoked, rotated or has expired. To replace it, run scripts/bootstrap-token.sh --rotate from this plugin, with the user's approval.",
  403: "The token's role lacks this permission, so retrying will not help.",
};

// The failure every host had in common, as a summary and what to do about it.
const NO_HOST_SERVED = {
  TLS_VERIFY: [
    "No PVE host passed certificate verification",
    "The hosts answered, so this is a CA or certificate problem, not an outage. Check certs/pve-root-ca.pem or PVE_CA_FILE against the cluster CA, and the expiry of the node certificates.",
  ],
  TIMEOUT: ["No PVE host answered in time", "Check that this machine can reach the cluster, and any node name in the path."],
  REFUSED: ["Every PVE host refused the connection", "Check PVE_HOSTS and that pveproxy is running on the nodes."],
  UNREACHABLE: ["All PVE hosts unreachable", "Check that this machine can reach the cluster."],
};

const TRANSPORT_CODES = {
  ECONNREFUSED: "REFUSED",
  ETIMEDOUT: "TIMEOUT",
  ERR_INVALID_CHAR: "BAD_REQUEST",
  ERR_UNESCAPED_CHARACTERS: "BAD_REQUEST",
};
const TLS_VERIFY_CODES = /CERT|CRL|UNABLE_TO_|INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED|HOSTNAME_MISMATCH/;

// An answer from PVE that is not a success. `status` is the HTTP status.
export class PveApiError extends Error {
  constructor(status, message) {
    super([`PVE API ${status}: ${message}`, STATUS_HINTS[status]].filter(Boolean).join("\n"));
    this.status = status;
  }
}

// A call that ended without an answer from PVE. `code` says why.
export class PveRequestError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// Maps an error from the transport to TLS_VERIFY, TIMEOUT, REFUSED, BAD_REQUEST or UNREACHABLE.
export function classifyTransportError({ code = "" }) {
  return TRANSPORT_CODES[code] ?? (TLS_VERIFY_CODES.test(code) ? "TLS_VERIFY" : "UNREACHABLE");
}

export function loadToken(env = process.env) {
  if (env.PVE_API_TOKEN) return env.PVE_API_TOKEN.trim();
  const file = env.PVE_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new PveRequestError(
      "NO_TOKEN",
      `API token not found at ${file}. Run plugins/proxmox/scripts/bootstrap-token.sh first.`,
    );
  }
}

function readCa(caFile) {
  try {
    return readFileSync(caFile);
  } catch (err) {
    throw new PveRequestError("CA_FILE", `Cannot read the PVE CA certificate. ${err.message}`);
  }
}

// The cluster CA signs every node certificate, so all hosts share one trust root. It is read on the
// first call, so that a missing file fails that call and not the whole server.
export function httpsTransport({ caFile, port = 8006 }) {
  let ca;
  return (host, path, token) =>
    new Promise((resolve, reject) => {
      ca ??= readCa(caFile);
      const req = https.request(
        {
          host,
          port,
          path: `/api2/json${path}`,
          method: "GET",
          ca,
          timeout: REQUEST_TIMEOUT_MS,
          headers: { Authorization: `PVEAPIToken=${token}` },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          // A connection lost mid-body ends neither the response nor the request, and has no timeout left.
          res.on("error", reject);
          res.on("end", () =>
            resolve({ status: res.statusCode, reason: res.statusMessage, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      req.on("timeout", () =>
        req.destroy(Object.assign(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`), { code: "ETIMEDOUT" })),
      );
      req.on("error", reject);
      req.end();
    });
}

const withoutQuery = (path) => path.split(/[?#]/, 1)[0];

// Judged by what PVE will decode. Anything Node would refuse to send is caught here too, where it
// can be called a bad path instead of looking like a host that failed.
function isSafePath(path) {
  if (!path.startsWith("/") || /[^\x21-\x7e]/.test(path)) return false;
  try {
    const decoded = decodeURIComponent(withoutQuery(path));
    return !decoded.split(/[/\\]/).includes("..") && !/[\x00-\x1f\x7f]/.test(decoded);
  } catch {
    return false; // Malformed percent-encoding.
  }
}

export function buildPath(path, params = {}) {
  if (!isSafePath(path)) {
    throw new PveRequestError("BAD_REQUEST", `Invalid API path: ${path}`);
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

// PVE's status line only says that verification failed. The offending parameters are in the body.
function failureReason({ reason, body }) {
  let errors;
  try {
    ({ errors } = JSON.parse(body));
  } catch {
    return reason; // Not every failure comes from PVE's JSON layer.
  }
  if (typeof errors !== "object" || errors === null) return reason;
  const details = Object.entries(errors).map(([name, problem]) => `${name}: ${problem}`);
  return details.length > 0 ? `${reason} (${details.join("; ")})` : reason;
}

function allHostsFailed(failures) {
  const codes = new Set(failures.map(({ code }) => code));
  const code = codes.size === 1 ? [...codes][0] : "UNREACHABLE";
  const [summary, advice] = NO_HOST_SERVED[code];
  return new PveRequestError(code, `${summary} (${failures.map(({ detail }) => detail).join("; ")}). ${advice}`);
}

export function createClient({ hosts, getToken, transport, log = () => {} }) {
  let preferred = 0;

  return {
    // GET only: this client deliberately has no way to issue a mutating request.
    async get(path, params) {
      const started = Date.now();
      const outcome = { host: null, failover: false };
      try {
        const target = buildPath(path, params);
        const token = getToken();
        const failures = [];

        for (let i = 0; i < hosts.length; i++) {
          const index = (preferred + i) % hosts.length;
          const host = hosts[index];
          Object.assign(outcome, { host, failover: i > 0 });
          let res;
          try {
            res = await transport(host, target, token);
          } catch (err) {
            if (err instanceof PveRequestError) throw err;
            const code = classifyTransportError(err);
            // Only the request is at fault, so no other host would take it either.
            if (code === "BAD_REQUEST") throw new PveRequestError(code, err.message);
            // Node's text for a TLS failure ends in advice that does not apply to a pinned CA.
            failures.push({ code, detail: `${host}: ${code === "TLS_VERIFY" ? err.code : err.message || err.code}` });
            continue;
          }
          preferred = index;
          outcome.status = res.status;
          if (res.status !== 200) throw new PveApiError(res.status, failureReason(res));
          return JSON.parse(res.body).data;
        }
        throw allHostsFailed(failures);
      } catch (err) {
        outcome.status ??= err.code ?? "ERROR";
        throw err;
      } finally {
        log({ ...outcome, path: withoutQuery(path), ms: Date.now() - started });
      }
    },
  };
}
