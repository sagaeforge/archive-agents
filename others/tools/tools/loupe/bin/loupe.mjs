#!/usr/bin/env node
// loupe CLI. Phase 0: serve and status. `open` (Orca tab) is Phase 5.
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
} else {
  console.log('usage: loupe serve | loupe status\n  KB_URL (default unix:/home/user/sagae-kb-data/run/read.sock), LOUPE_PORT (default 4812), LOUPE_DIST');
  process.exit(cmd === 'help' ? 0 : 2);
}
void rest;
