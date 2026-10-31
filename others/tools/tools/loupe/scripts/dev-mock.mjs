// One command for Phase 1: kb-mock with the research fixture on 4811 and Vite on 4810, both on 127.0.0.1. Ctrl-C stops both.
// KB_FIXTURES picks another fixture: contract-sample/fixtures/kb-hostile.json or kb.json.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = process.env.KB_FIXTURES ?? 'contract-sample/fixtures/kb-research.json';
const run = (args, env = {}) => spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });

const children = [
  run(['dev/kb-mock/main.ts'], { KB_FIXTURES: fixture, KB_MOCK_PORT: '4811' }),
  run([viteBin]),
];
const stop = () => { for (const c of children) c.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => { stop(); process.exitCode ??= code ?? 0; });
