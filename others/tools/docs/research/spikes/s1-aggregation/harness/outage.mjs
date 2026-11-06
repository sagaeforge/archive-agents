// How does the merged endpoint behave across a sustained HTTP upstream outage?
// usage: outage.mjs <url> <legacy|modern> <bearer|-> <seconds>
import { execFileSync } from 'node:child_process';
import { open, outcome, pick } from './lib.mjs';

const [url, era, bearerArg, secs] = process.argv.slice(2);
const bearer = bearerArg === '-' ? undefined : bearerArg;
const S = '/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation';
const svc = (...a) => execFileSync(`${S}/harness/svc.sh`, a, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (r) => {
  const o = outcome(r);
  return o.length > 88 ? `${o.slice(0, 88)}…` : o;
};

const s = await open(url, era, bearer);
const list = await s.call('tools/list');
const { a, b } = pick(list.json?.result?.tools ?? []);
console.log(`era=${era} negotiated=${s.negotiated} a=${a} b=${b}`);
const t0 = Date.now();
const stamp = () => `${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s`;
const sample = async (tag) => {
  const l = await s.call('tools/list');
  const n = l.json?.result?.tools?.length;
  const cb = await s.call('tools/call', { name: b, arguments: { text: 'x' } });
  const fresh = await open(url, era, bearer);
  const ok = fresh.negotiated ? 'ok' : short(fresh.init ?? fresh.discover);
  console.log(`${stamp()} ${tag} list=${n ?? short(l)} | beta=${short(cb)} | newSession=${ok}`);
};
await sample('up  ');
svc('stop', 'alpha');
const end = Date.now() + Number(secs) * 1000;
while (Date.now() < end) {
  await sample('DOWN');
  await sleep(3000);
}
svc('start', 'alpha', `${S}/upstreams`, 'node', 'alpha.mjs');
await sleep(1200);
for (let i = 0; i < 4; i++) {
  await sample('back');
  await sleep(1000);
}
