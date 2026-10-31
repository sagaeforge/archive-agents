// Test ports 4830-4834. A Unix socket path has a 108-byte limit, so names stay short and LOUPE_SOCKET_DIR must be short too.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const sockDir = process.env.LOUPE_SOCKET_DIR ?? path.join(root, '.cache/sock');
export const logDir = process.env.LOUPE_LOG_DIR ?? path.join(root, '.cache/logs');
export const shotsDir = process.env.LOUPE_SHOTS_DIR ?? path.join(root, '.cache/shots');

export const PORT = { research: 4830, hostile: 4831, sample: 4832, crossSite: 4833, offline: 4834 } as const;
export const base = (port: number) => `http://127.0.0.1:${port}`;
export const RESEARCH = base(PORT.research);
export const HOSTILE = base(PORT.hostile);
export const SAMPLE = base(PORT.sample);
export const accessLog = (name: string) => path.join(logDir, `e2e-${name}.log`);
export const sock = (name: string) => path.join(sockDir, `${name}.s`);
