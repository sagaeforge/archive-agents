import { readFileSync } from "node:fs";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOSTS = "192.0.2.1,192.0.2.1,192.0.2.1";
const DEFAULT_CA_FILE = fileURLToPath(new URL("../certs/pve-root-ca.pem", import.meta.url));
const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "proxmox-mcp", "token");
const REQUEST_TIMEOUT_MS = 8000;

const STATUS_HINTS = {
  401: "The token was rejected: it was revoked, rotated or has expired. To replace it, run scripts/bootstrap-token.sh --rotate from this plugin, with the user's approval. If that reports nothing to do, this version of the script cannot rotate, so ask the user for a working token file instead.",
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
  BAD_RESPONSE: [
    "No PVE host sent a PVE API response",
    "Something other than PVE may be answering, such as a proxy. Check PVE_HOSTS and what listens on port 8006.",
  ],
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

// A call that ended without an answer from PVE. `code` says why, and `failures` what each host did.
export class PveRequestError extends Error {
  constructor(code, message, failures = []) {
    super(`${code}: ${message}`);
    this.code = code;
    this.failures = failures;
  }
}

// Maps an error from the transport to TLS_VERIFY, TIMEOUT, REFUSED, BAD_REQUEST or UNREACHABLE.
export function classifyTransportError({ code = "" }) {
  return TRANSPORT_CODES[code] ?? (TLS_VERIFY_CODES.test(code) ? "TLS_VERIFY" : "UNREACHABLE");
}

// Where this process talks to PVE, for anything that has to see the cluster the way the server does.
export function connectionSettings(env = process.env) {
  return { hosts: (env.PVE_HOSTS || DEFAULT_HOSTS).split(","), caFile: env.PVE_CA_FILE || DEFAULT_CA_FILE };
}

export const tokenFile = (env = process.env) => env.PVE_TOKEN_FILE || DEFAULT_TOKEN_FILE;

export function loadToken(env = process.env) {
  if (env.PVE_API_TOKEN) return env.PVE_API_TOKEN.trim();
  const file = tokenFile(env);
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new PveRequestError(
      "NO_TOKEN",
      `API token not found at ${file}. Ask the user how to provide one. Do not run scripts/bootstrap-token.sh from this plugin without their approval: it changes tokens on the cluster, and if machines still share one token, it locks the others out.`,
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
    // The path is left out: the caller chose it, so it can hold a token, and the reply is kept.
    throw new PveRequestError(
      "BAD_REQUEST",
      "Invalid API path: it must start with /, hold only printable ASCII, have no .. segment, and use well-formed %-escapes.",
    );
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  // PVE stops reading at a fragment, so whatever followed one would be lost.
  const target = path.split("#", 1)[0];
  const qs = query.toString();
  if (!qs) return target;
  // PVE refuses a query with an empty pair, so one left open takes no further separator.
  const separator = !target.includes("?") ? "?" : /[?&]$/.test(target) ? "" : "&";
  return `${target}${separator}${qs}`;
}

// PVE wraps every success in { data }, so anything else came from something other than PVE.
function pveEnvelope(body) {
  try {
    const envelope = JSON.parse(body);
    return "data" in envelope ? envelope : null;
  } catch {
    return null; // Not JSON, or JSON that is not an object.
  }
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

const REASON_LIMIT = 1000;
const MIN_SECRET_LENGTH = 8;

const WITHHELD_REASON = "PVE's reason was withheld because it repeated the API token.";
const MAX_DECODE_ROUNDS = 10;

// Every form the text takes as its percent-escapes are undone, one round at a time, so a token
// encoded any number of times is still found. Unlike decodeURIComponent this never throws: an escape
// that is not valid is left as it is and the rest is decoded. A round that changes the text shortens
// it, so the loop ends by itself, and the bound only decides what to do with a pathological input:
// text still shrinking after it is not trusted.
function decodedForms(text) {
  const forms = [text];
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next = forms.at(-1).replace(/%([0-9a-f]{2})/gi, (_escape, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === forms.at(-1)) return { forms, settled: true };
    forms.push(next);
  }
  return { forms, settled: false };
}

// PVE can repeat what it was asked for in its reason: a path, a parameter's value, a node name. The
// caller chose those, so they can hold the token, and the reply is kept. Encodings of the token are
// too many to list, so the reason is compared as it reads once decoded, ignoring case. If any form
// holds the token or its secret, the whole reason goes: there is no telling where an encoded token
// ends, so none of it is cut out. What is kept is cut to a bound.
function safeReason(reason, token) {
  const secret = token.slice(token.lastIndexOf("=") + 1);
  // A real secret is a UUID. A stub of a few characters would also match ordinary words.
  const needles = [token, secret].filter((needle) => needle.length >= MIN_SECRET_LENGTH).map((needle) => needle.toLowerCase());
  const { forms, settled } = decodedForms(reason);
  if (!settled || forms.some((form) => needles.some((needle) => form.toLowerCase().includes(needle)))) return WITHHELD_REASON;
  return reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT)}…` : reason;
}

function allHostsFailed(failures) {
  const codes = new Set(failures.map(({ code }) => code));
  const code = codes.size === 1 ? [...codes][0] : "UNREACHABLE";
  const [summary, advice] = NO_HOST_SERVED[code];
  return new PveRequestError(code, `${summary} (${failures.map(({ detail }) => detail).join("; ")}). ${advice}`, failures);
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
          const envelope = res.status === 200 ? pveEnvelope(res.body) : null;
          if (res.status === 200 && !envelope) {
            // The body stays out of this: it is not PVE's, and the message reaches the tool result.
            failures.push({ code: "BAD_RESPONSE", detail: `${host}: a 200 without a PVE API body` });
            continue;
          }
          preferred = index;
          outcome.status = res.status;
          if (res.status !== 200) throw new PveApiError(res.status, safeReason(failureReason(res), token));
          return envelope.data;
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
