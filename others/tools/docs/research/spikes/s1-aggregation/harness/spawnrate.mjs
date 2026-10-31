// Spawns per request for one tool over a modern client. usage: spawnrate.mjs <url> <bearer|-> <toolRegex> <n>
import { readFileSync } from 'node:fs';
import { open, outcome, pick } from './lib.mjs';
const [url, bearerArg, toolRe, n] = process.argv.slice(2);
const bearer = bearerArg === '-' ? undefined : bearerArg;
const LOG='/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation/logs/beta-spawn.log';
const spawns=()=>readFileSync(LOG,'utf8').split('\n').filter(l=>l.includes('"spawn"')).length;
const s=await open(url,'modern',bearer);
const list=await s.call('tools/list');
const t=list.json.result.tools.find(x=>new RegExp(toolRe).test(x.name));
const args=/echo/.test(t.name)?{text:'x'}:{};
const lat=[];
const b0=spawns();
for(let i=0;i<Number(n);i++){const r=await s.call('tools/call',{name:t.name,arguments:args}); lat.push(r.ms); if(!r.json?.result) console.log(outcome(r));}
await new Promise(r=>setTimeout(r,500));
lat.sort((a,b)=>a-b);
console.log(`${t.name}: calls=${n} spawns=${spawns()-b0} latency p50=${lat[Math.floor(lat.length/2)]} ms max=${lat.at(-1)} ms`);
