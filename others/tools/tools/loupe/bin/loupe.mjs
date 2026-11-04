#!/usr/bin/env node
// loupe CLI. serve and status (v1), and the terminal-only login commands of design v2 6.2 and 6.5. `open` (Orca tab) is Phase 5.
const [cmd = 'help', ...rest] = process.argv.slice(2);

if (cmd === 'serve') {
  const { serve } = await import('../server/serve.ts');
  await serve();
} else if (cmd === 'status') {
  const { DEFAULT_KB_URL, kbRequest, parseKbUrl } = await import('../server/upstream.ts');
  const target = parseKbUrl(process.env.KB_URL ?? DEFAULT_KB_URL);
  try {
    const res = await kbRequest(target, { method: 'GET', path: '/v1/meta', headers: { accept: 'application/json' }, firstByteMs: 5000, connectMs: 1000 });
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (res.statusCode !== 200) { console.error(`KB answered ${res.statusCode}: ${body.code ?? body.title}`); process.exit(1); }
    const { schema_version, epoch, applied_seq, data_as_of, degraded } = body;
    console.log(JSON.stringify({ schema_version, epoch, applied_seq, data_as_of, degraded }, null, 2));
  } catch (e) {
    console.error(`KB unreachable: ${e.code ?? e.message}`);
    process.exit(1);
  }
} else if (cmd === 'google-setup' || cmd === 'google-enroll' || cmd === 'breakglass') {
  const { main } = await import('../server/cli.ts');
  await main(cmd, rest);
  process.exit(0);
} else {
  console.log([
    'usage: loupe serve | loupe status | loupe google-setup | loupe google-enroll | loupe breakglass set|open',
    '  KB_URL (default unix:/home/user/sagae-kb-data/run/read.sock), LOUPE_PORT (default 4812), LOUPE_DIST,',
    '  LOUPE_CONFIG_DIR (default ~/.config/loupe). google-setup, google-enroll and breakglass need a terminal.',
  ].join('\n'));
  process.exit(cmd === 'help' ? 0 : 2);
}
