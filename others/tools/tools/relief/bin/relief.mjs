#!/usr/bin/env node
// relief CLI (design 11).
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
} else if (cmd === 'forget') {
  const { forgetCli } = await import('../server/check.ts');
  process.exitCode = await forgetCli(rest[0]);
} else if (cmd === 'open') {
  const { open } = await import('../server/open.ts');
  process.exitCode = open({ dryRun: rest.includes('--print') });
} else {
  console.log('usage: relief serve | relief status | relief check [--live] | relief forget <id> | relief open [--print]\n  RELIEF_PORT (default 4815), RELIEF_CONFIG, RELIEF_STATE, TOWER_CONFIG');
  process.exitCode = cmd === 'help' ? 0 : 2;
}
