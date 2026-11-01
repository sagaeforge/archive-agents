import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PORT = { dev: 4816, built: 4819, serve: 4822 } as const; // live.spec.ts uses 4820 and 4821 for itself.
export const BUILT = `http://127.0.0.1:${PORT.built}`;
export const DEV = `http://127.0.0.1:${PORT.dev}`;
// A plain run leaves the tracked pictures alone. `npm run screenshots:refresh` points this at them.
export const shotDir = path.resolve(root, process.env.RELIEF_SHOT_DIR ?? '.cache/screenshots');
mkdirSync(shotDir, { recursive: true });
