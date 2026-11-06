// usage: ttl.mjs <url> <bearer> <waitSeconds>
import { execSync } from 'node:child_process';
import { open, outcome, post } from './lib.mjs';
const [url, bearer, wait] = process.argv.slice(2);
const S='/tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s1-aggregation';
const live=()=>execSync(`${S}/harness/livebeta.sh`).toString().trim();
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
console.log('live at start',live());
const s=await open(url,'legacy',bearer);
console.log('after open: live',live());
console.log('call',outcome(await s.call('tools/call',{name:'beta_beta_echo',arguments:{text:'x'}})));
const ping=setInterval(()=>{},1000);
const t0=Date.now(); let gone=null;
while((Date.now()-t0)<Number(wait)*1000){ if(live()==='0'&&gone===null){gone=Date.now()-t0;break;} await sleep(250);}
clearInterval(ping);
console.log(`child gone after ${gone===null?'NOT GONE within '+wait+' s':gone+' ms'} (idle session)`);
console.log('reuse expired session tools/list:',outcome(await s.call('tools/list')));
console.log('reuse expired session call:',outcome(await s.call('tools/call',{name:'alpha_status',arguments:{}})));
console.log('live now',live());
// DELETE teardown
const d=await open(url,'legacy',bearer);
console.log('session2 live',live());
const res=await fetch(url,{method:'DELETE',headers:{authorization:`Bearer ${bearer}`,'mcp-session-id':d.session,'mcp-protocol-version':'2025-11-25'}});
console.log('DELETE status',res.status);
await sleep(600);
console.log('after DELETE live',live());
// concurrent sessions
const opens=await Promise.all([1,2,3,4,5].map(()=>open(url,'legacy',bearer)));
await sleep(300);
console.log('5 concurrent sessions: negotiated',opens.filter(o=>o.negotiated).length,'live',live());
