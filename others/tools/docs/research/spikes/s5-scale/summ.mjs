import fs from 'node:fs';
const L = fs.readFileSync('out/results-s5.jsonl', 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.sync !== undefined);
const f = (o) => (o ? `${o.p50}/${o.p95}` : '-');
L.forEach((r, i) => console.log(i, r.P.size, 'rep', r.P.rep, 'n/m', r.n, r.m, '| first', r.init.firstFrameMs, 'ctor', r.init.ctorMs, '| fps', r.passive?.fps, 'rAF', f(r.passive?.rAF), 'o20', r.passive?.over20, '| cpugpu', f(r.sync?.cpuGpuFrame), 'rAFs', f(r.sync?.rAF), 'o20s', r.sync?.over20, '| ov', f(r.passive?.ovTotal), '| hv', f(r.hoverEnter), 'hl', f(r.hoverLeave), 'err', r.hverr?.length, '| vis', r.vis?.end, r.vis?.VIS?.changes));
