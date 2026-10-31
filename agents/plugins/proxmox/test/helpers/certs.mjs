// Throwaway certificate authority for TLS tests. Node can verify X.509 but not create it, and a
// committed key would be a secret in the repository, so every run mints its own keys. This encodes
// only what TLS verification reads: names, validity, CA:TRUE, and an IP subjectAltName.
import { X509Certificate, generateKeyPairSync, sign } from "node:crypto";

const ECDSA_WITH_SHA256 = "2a8648ce3d040302";
const COMMON_NAME = "550403";
const BASIC_CONSTRAINTS = "551d13";
const SUBJECT_ALT_NAME = "551d11";
const HOUR_MS = 60 * 60 * 1000;

let nextSerial = 1;

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const size = body.length;
  const length = size < 0x80 ? [size] : size < 0x100 ? [0x81, size] : [0x82, size >> 8, size & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts) => der(0x30, ...parts);
const oid = (hex) => der(0x06, Buffer.from(hex, "hex"));
const integer = (value) => der(0x02, Buffer.from([value]));
const octetString = (value) => der(0x04, value);
const bitString = (value) => der(0x03, Buffer.from([0]), value);
const TRUE = der(0x01, Buffer.from([0xff]));

const signatureAlgorithm = sequence(oid(ECDSA_WITH_SHA256));
const name = (commonName) => sequence(der(0x31, sequence(oid(COMMON_NAME), der(0x0c, Buffer.from(commonName)))));
const utcTime = (ms) => der(0x17, Buffer.from(`${new Date(ms).toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
const keyPair = () => generateKeyPairSync("ec", { namedCurve: "P-256" });

function certificate({ subject, issuer, publicKey, signingKey, extension, expired = false, validForMs = HOUR_MS }) {
  const now = Date.now();
  const validity = expired ? [now - 2 * HOUR_MS, now - HOUR_MS] : [now - HOUR_MS, now + validForMs];
  const tbs = sequence(
    der(0xa0, integer(2)), // X.509 v3
    integer(nextSerial++),
    signatureAlgorithm,
    name(issuer),
    sequence(...validity.map(utcTime)),
    name(subject),
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(extension)),
  );
  return new X509Certificate(sequence(tbs, signatureAlgorithm, bitString(sign("sha256", tbs, signingKey)))).toString();
}

export function createCa(commonName, { expired, validForMs } = {}) {
  const { publicKey, privateKey } = keyPair();
  return {
    cert: certificate({
      subject: commonName,
      issuer: commonName,
      publicKey,
      signingKey: privateKey,
      extension: sequence(oid(BASIC_CONSTRAINTS), TRUE, octetString(sequence(TRUE))),
      expired,
      validForMs,
    }),
    // A server certificate naming one IPv4 address, the way PVE node certificates do.
    issue(ip, { expired } = {}) {
      const server = keyPair();
      const address = der(0x87, Buffer.from(ip.split(".").map(Number)));
      return {
        key: server.privateKey.export({ type: "pkcs8", format: "pem" }),
        cert: certificate({
          subject: `server ${ip}`,
          issuer: commonName,
          publicKey: server.publicKey,
          signingKey: privateKey,
          extension: sequence(oid(SUBJECT_ALT_NAME), octetString(sequence(address))),
          expired,
        }),
      };
    },
  };
}
