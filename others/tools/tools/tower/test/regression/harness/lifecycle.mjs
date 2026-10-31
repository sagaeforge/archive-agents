// Candidate-agnostic crash and return test.
// usage: lifecycle.mjs <url> <legacy|modern> [--bearer tok] [--betaPids]
// Assumes alpha runs under svc.sh name "alpha".
import { ROOT as TT_ROOT, P as TT_P } from './env.mjs';
import { execFileSync } from 'node:child_process';
import { open, outcome, pick } from './lib.mjs';

const [url, era, ...rest] = process.argv.slice(2);
const argv = Object.fromEntries(rest.map((v, i) => (v.startsWith('--') ? [v.slice(2), rest[i + 1]] : null)).filter(Boolean));
const bearer = argv.bearer;
const S = `${TT_ROOT}`;
const svc = (...a) => execFileSync(`${S}/harness/svc.sh`, a, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (step, r) => console.log(`${step.padEnd(44)} ${typeof r === 'string' ? r : `${outcome(r)} (${r.ms} ms)`}`);
const ec = (r) => r.json?.result?.content?.find((c) => c.type === 'text')?.text ?? '';
const betaPid = (r) => Number(/pid=(\d+)/.exec(ec(r))?.[1]);
const alphaUp = async () => {
  for (let i = 0; i < 300; i++) {
    try { await fetch(`http://127.0.0.1:${TT_P.alpha}/mcp`, { signal: AbortSignal.timeout(100) }); return true; } catch { await sleep(10); }
  }
  return false;
};
const call = (s, name, args = {}) => s.call('tools/call', { name, arguments: args });

let s = await open(url, era, bearer);
log(`open ${era}`, `negotiated=${s.negotiated} session=${s.session ? 'yes' : 'no'}`);
let list = await s.call('tools/list');
log('tools/list', list);
const tools = list.json?.result?.tools ?? [];
const { a, b } = pick(tools);
log('picked', `alpha=${a} betaEcho=${b}`);
if (!a || !b) { console.log('cannot pick tools, stopping'); process.exit(0); }
log('call alpha', await call(s, a));
const b0 = await call(s, b, { text: 'x' });
log('call beta', b0);
const pid0 = betaPid(b0);

console.log('--- HTTP upstream down (alpha SIGTERM)');
svc('stop', 'alpha');
await sleep(200);
log('tools/list [alpha down]', await s.call('tools/list'));
log('call alpha [alpha down]', await call(s, a));
log('call beta  [alpha down]', await call(s, b, { text: 'x' }));
const s1b = await open(url, era, bearer);
log('NEW session [alpha down]', `negotiated=${s1b.negotiated} ${outcome(s1b.init ?? s1b.discover)}`);
if (s1b.negotiated) log('NEW session tools/list [alpha down]', await s1b.call('tools/list'));

console.log('--- HTTP upstream back');
svc('start', 'alpha', `${S}/upstreams`, 'node', 'alpha.mjs');
await alphaUp();
await sleep(200);
log('tools/list [alpha back, same session]', await s.call('tools/list'));
log('call alpha [alpha back, same session]', await call(s, a));
await sleep(2000);
log('call alpha [+2 s, same session]', await call(s, a));
const s2 = await open(url, era, bearer);
log('NEW session [alpha back]', `negotiated=${s2.negotiated}`);
if (s2.negotiated) {
  log('NEW session tools/list', await s2.call('tools/list'));
  log('NEW session call alpha', await call(s2, a));
}

console.log('--- stdio child SIGKILL');
const b1 = await call(s, b, { text: 'x' });
log('call beta before kill', b1);
const pid1 = betaPid(b1) || pid0;
if (pid1) {
  try { process.kill(pid1, 'SIGKILL'); log('kill -9', String(pid1)); } catch (e) { log('kill -9', `failed ${e.code} pid ${pid1}`); }
}
await sleep(300);
log('tools/list [+0.3 s]', await s.call('tools/list'));
const t1 = await call(s, b, { text: 'x' });
log('call beta [+0.3 s]', t1);
log('call alpha [+0.3 s]', await call(s, a));
await sleep(3000);
log('call beta [+3.3 s]', await call(s, b, { text: 'x' }));
await sleep(10000);
const t3 = await call(s, b, { text: 'x' });
log('call beta [+13.3 s]', t3);
log('tools/list [+13.3 s]', await s.call('tools/list'));
const s3 = await open(url, era, bearer);
log('NEW session after kill', `negotiated=${s3.negotiated}`);
if (s3.negotiated) {
  log('NEW session tools/list', await s3.call('tools/list'));
  log('NEW session call beta', await call(s3, b, { text: 'x' }));
}
