// Test ports 4830-4839. A Unix socket path has a 108-byte limit, so names stay short and LOUPE_SOCKET_DIR must be short too.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const sockDir = process.env.LOUPE_SOCKET_DIR ?? path.join(root, '.cache/sock');
export const logDir = process.env.LOUPE_LOG_DIR ?? path.join(root, '.cache/logs');
export const shotsDir = process.env.LOUPE_SHOTS_DIR ?? path.join(root, '.cache/shots');

export const PORT = { research: 4830, hostile: 4831, sample: 4832, crossSite: 4833, offline: 4834, idp: 4835, auth: 4836, authB: 4837, tls: 4838 } as const;
// The app's origin is localhost (design v2 6.3: WebAuthn cannot use an IP as RP ID); the sockets stay on 127.0.0.1.
export const base = (port: number) => `http://localhost:${port}`;
/** A page on another site: `127.0.0.1` and `localhost` are different sites to the browser. */
export const crossSiteUrl = (p = '/') => `http://127.0.0.1:${PORT.crossSite}${p}`;
export const RESEARCH = base(PORT.research);
export const HOSTILE = base(PORT.hostile);
export const SAMPLE = base(PORT.sample);
export const accessLog = (name: string) => path.join(logDir, `e2e-${name}.log`);
export const sock = (name: string) => path.join(sockDir, `${name}.s`);
/** The login files every harness `loupe serve` reads: a test client and the test provider's owner `sub`. */
export const authDir = path.join(root, '.cache/auth/harness');
export const IDP = `http://127.0.0.1:${PORT.idp}`;
