// Aggregates per-cell results: median across reps of each run's metric, plus min-max.
import fs from 'node:fs';
const f=process.argv[2]; const rows=fs.readFileSync(f,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.P&&r.P.mode==='bench');
const key=r=>{const p=r.P;return [p.ds||'payload',p.size||'-',p.v,p.tech||'',p.K||'',p.dash?'dash':'',p.hm||'',p.hide?'hide':''].filter(x=>x!=='').join(' ')};
const med=a=>{a=a.filter(x=>x!=null).sort((x,y)=>x-y);return a.length?a[Math.floor((a.length-1)/2)]:null};
const R=(a)=>{a=a.filter(x=>x!=null);if(!a.length)return '-';const m=med(a);return `${m}`};
const rng=a=>{a=a.filter(x=>x!=null);return a.length?`${Math.min(...a)}-${Math.max(...a)}`:'-'};
const g={};for(const r of rows)(g[key(r)]??=[]).push(r);
const out=[];
for(const [k,rs] of Object.entries(g).sort()){
 if(rs[0].nullRaf){out.push({k,n:rs.length,fps:rs.map(r=>(r.nullRaf.n/10).toFixed(0)).join('/'),p50:R(rs.map(r=>r.nullRaf.p50)),p95:R(rs.map(r=>r.nullRaf.p95)),over20:rs.map(r=>r.over20).join('/')});continue}
 const o={k,n:rs.length,vis:[...new Set(rs.map(r=>r.env.vis))].join(),
  fps:R(rs.map(r=>r.passive.fps)),fpsR:rng(rs.map(r=>r.passive.fps)),
  p50:R(rs.map(r=>r.passive.rAF.p50)),p95:R(rs.map(r=>r.passive.rAF.p95)),p99:R(rs.map(r=>r.passive.rAF.p99)),over20:R(rs.map(r=>r.passive.over20)),
  js50:R(rs.map(r=>r.passive.jsRender.p50)),js95:R(rs.map(r=>r.passive.jsRender.p95)),
  gpu50:R(rs.map(r=>r.sync.cpuGpuFrame.p50)),gpu95:R(rs.map(r=>r.sync.cpuGpuFrame.p95)),
  ov50:R(rs.map(r=>r.passive.ovTotal?.p50)),ov95:R(rs.map(r=>r.passive.ovTotal?.p95)),sel50:R(rs.map(r=>r.passive.ovSelect?.p50)),draw50:R(rs.map(r=>r.passive.ovDraw?.p50)),
  lblMean:R(rs.map(r=>r.passive.labels?.mean)),churn:R(rs.map(r=>r.passive.churnMean)),
  init:R(rs.map(r=>r.init.firstFrameMs)),initR:rng(rs.map(r=>r.init.firstFrameMs)),ctor:R(rs.map(r=>r.init.ctorMs)),build:R(rs.map(r=>r.init.buildMs)),
  hov50:R(rs.map(r=>r.hoverEnter.p50)),hov95:R(rs.map(r=>r.hoverEnter.p95)),leave50:R(rs.map(r=>r.hoverLeave.p50)),
  heapLoaded:R(rs.map(r=>r.heap.loaded&&+(r.heap.loaded.used/1e6).toFixed(1))),heapAfter:R(rs.map(r=>r.heap.after&&+(r.heap.after.used/1e6).toFixed(1))),heapGraph:R(rs.map(r=>r.heap.graph&&+(r.heap.graph.used/1e6).toFixed(1))),heapBase:R(rs.map(r=>r.heap.before&&+(r.heap.before.used/1e6).toFixed(1)))};
 out.push(o);
}
fs.writeFileSync(process.argv[3],JSON.stringify(out,null,0));
const cols=['k','n','fps','p50','p95','p99','over20','js50','js95','gpu50','gpu95','ov50','ov95','lblMean','churn','init','ctor','hov50','hov95','heapLoaded','heapAfter'];
console.log(cols.join('\t'));for(const o of out)console.log(cols.map(c=>o[c]??'').join('\t'));
