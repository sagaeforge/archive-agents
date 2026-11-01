import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PORT = { dev: 4816, built: 4819 } as const;
export const BUILT = `http://127.0.0.1:${PORT.built}`;
export const DEV = `http://127.0.0.1:${PORT.dev}`;
export const shotDir = path.join(root, 'screenshots');
