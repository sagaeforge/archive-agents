#!/usr/bin/env node
// relief CLI (design 11). `open` belongs to Phase 5.
const [cmd = 'help', ...rest] = process.argv.slice(2);

if (cmd === 'serve') {
  const { serve } = await import('../server/serve.ts');
  await serve();
} else if (cmd === 'status') {
  const { status } = await import('../server/check.ts');
  process.exitCode = await status();
} else if (cmd === 'check') {
  const { check } = await import('../server/check.ts');
  process.exitCode = await check({ live: rest.includes('--live') });
} else {
  console.log('usage: relief serve | relief status | relief check [--live]\n  RELIEF_PORT (default 4815), RELIEF_CONFIG, RELIEF_STATE, TOWER_CONFIG');
  process.exitCode = cmd === 'help' ? 0 : 2;
}
