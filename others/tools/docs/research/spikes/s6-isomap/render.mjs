// Smallest proof of the look: ELK layout -> isometric projection -> plain SVG -> headless Chromium PNG.
// Run from this directory with PLAYWRIGHT_BROWSERS_PATH and LD_LIBRARY_PATH set (see tools/loupe/.cache).
import { writeFileSync } from 'node:fs';
import ELK from 'elkjs/lib/elk.bundled.js';
import { chromium } from 'playwright';
import { today, large } from './fixture.mjs';

const FONT = '"Malgun Gothic","Noto Sans KR",sans-serif';
const SIZE = { wan: [60, 60], tunnel: [60, 60], gateway: [64, 64], proxy: [60, 60], segment: [44, 150], bridge: [30, 30], storage: [30, 30], vm: [52, 52], lxc: [38, 38], container: [20, 20] };
const HEIGHT = { wan: 34, tunnel: 26, gateway: 34, proxy: 30, segment: 8, node: 14, bridge: 4, storage: 12, vm: 30, lxc: 20, container: 12, dockerhost: 8 };
const COLOR = { wan: '#dd7f33', tunnel: '#dd7f33', gateway: '#dd7f33', proxy: '#dd7f33', segment: '#3f9b6c', node: '#d8dee8', bridge: '#6b7a90', storage: '#b99558', vm: '#4a78e0', lxc: '#2ba193', container: '#8a68d4', dockerhost: '#7f9fea' };
const STATE = { stopped: '#a9b0bb', error: '#d9483b', starting: '#e9a820' };

// --- layout. Root placement and edge routes come from ELK. Inside a slab, `shelf` keeps slots in first-seen order so a new
// guest never moves its neighbours; `elk` is the rectpacking alternative, kept to reproduce the comparison in results.json.
const INFRA = new Set(['bridge', 'storage']);
const quant = (v, q) => Math.ceil(v / q) * q;

function shelfHost(n, kids) {
  const cols = kids.length <= 16 ? 4 : 5; // capacity steps: a pad keeps its size while containers come and go
  const pad = 8; const gap = 6; const cell = SIZE.container[0];
  const side = cols * cell + (cols - 1) * gap + 2 * pad;
  return { id: n.id, width: side, height: side, children: kids.map((c, i) => ({ id: c.id, x: pad + (i % cols) * (cell + gap), y: pad + Math.floor(i / cols) * (cell + gap), width: cell, height: cell })) };
}

function shelfNode(n, kids, childrenOf, W) {
  // Bridges and storage hold a column on the west edge, where uplinks arrive, so taller guests never stand in front of them.
  const pad = 14; const gap = 10; const out = [];
  let colY = pad;
  for (const c of kids.filter((k) => INFRA.has(k.kind))) { out.push({ id: c.id, x: pad, y: colY, width: SIZE[c.kind][0], height: SIZE[c.kind][1] }); colY += SIZE[c.kind][1] + gap; }
  const left = pad + SIZE.bridge[0] + 2 * gap; let x = left; let y = pad; let rowH = 0;
  for (const c of kids.filter((k) => !INFRA.has(k.kind))) {
    const sub = childrenOf(c.id);
    const item = sub.length ? shelfHost(c, sub) : { id: c.id, width: SIZE[c.kind][0], height: SIZE[c.kind][1] };
    if (x + item.width > W - pad) { x = left; y += rowH + gap; rowH = 0; }
    out.push({ ...item, x, y }); x += item.width + gap; rowH = Math.max(rowH, item.height);
  }
  return { id: n.id, width: W, height: quant(Math.max(colY - gap, y + rowH) + pad, 80), children: out };
}

async function layout(data, pack = 'shelf') {
  const elk = new ELK();
  const kids = (id) => data.nodes.filter((n) => n.parent === id);
  const rootNodes = data.nodes.filter((n) => !n.parent);
  const elkPack = { 'elk.algorithm': 'rectpacking', 'elk.aspectRatio': '1.5', 'elk.spacing.nodeNode': '10', 'elk.padding': '[top=14,left=14,bottom=14,right=14]' };
  const toElk = (n) => {
    const c = kids(n.id);
    if (!c.length) { const [width, height] = SIZE[n.kind]; return { id: n.id, width, height }; }
    return { id: n.id, layoutOptions: elkPack, children: c.map(toElk) };
  };
  const area = Math.max(...rootNodes.filter((n) => n.kind === 'node').map((n) => kids(n.id).reduce((s, c) => s + (kids(c.id).length ? 114 ** 2 : SIZE[c.kind][0] ** 2 * 1.5), 0)));
  const W = Math.max(240, quant(Math.sqrt(area * 1.6), 80));
  const slabs = new Map();
  const toRoot = (n) => {
    if (pack === 'elk') return toElk(n);
    if (n.kind !== 'node') return toElk(n);
    const s = shelfNode(n, kids(n.id), kids, W); slabs.set(n.id, s);
    return { id: n.id, width: s.width, height: s.height };
  };
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '70', 'elk.layered.spacing.nodeNodeBetweenLayers': '120', 'elk.layered.spacing.edgeNodeBetweenLayers': '30',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: rootNodes.map(toRoot),
    edges: data.edges.filter((e) => e.kind !== 'attached').map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const t0 = performance.now();
  const out = await elk.layout(graph);
  const ms = performance.now() - t0;
  for (const c of out.children) if (slabs.has(c.id)) c.children = slabs.get(c.id).children;
  return { out, ms };
}

// --- projection and scene
const C = Math.cos(Math.PI / 6);
const project = (mode, S) => (mode === 'iso'
  ? (x, y, z = 0) => [(x - y) * C * S, (x + y) * 0.5 * S - z * S]
  : (x, y) => [x * S, y * S]);
const pts = (a) => a.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
const shade = (hex, f) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * f).toString(16).padStart(2, '0')).join('');
const tint = (hex, f) => '#' + [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16); return Math.round(c + (255 - c) * f).toString(16).padStart(2, '0'); }).join('');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const wide = (s) => [...s].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e7f ? 1.0 : 0.58), 0);

// Painter's order for axis-aligned boxes: a is drawn first when it lies behind b on an axis and overlaps it on the other.
function paintOrder(list) {
  const before = (a, b) => (a.x + a.width <= b.x && a.y < b.y + b.height && b.y < a.y + a.height) || (a.y + a.height <= b.y && a.x < b.x + b.width && b.x < a.x + a.width);
  const rest = [...list]; const done = [];
  while (rest.length) {
    let i = rest.findIndex((a) => !rest.some((b) => b !== a && before(b, a)));
    if (i < 0) i = 0;
    done.push(rest.splice(i, 1)[0]);
  }
  return done;
}

function scene(data, g, { mode = 'iso', S, crop = null, lod = 'group' }) {
  const P = project(mode, S);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const el = []; const labels = []; let bounds = [1e9, 1e9, -1e9, -1e9];
  const grow = (pp) => { for (const [x, y] of pp) { bounds = [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)]; } };
  const boxOf = new Map();

  const box = (o, x, y, w, h, z, zh, fillHex) => {
    const n = byId.get(o.id);
    const basis = n.basis; const hollow = basis === 'unknown';
    const base = n.state in STATE ? STATE[n.state] : fillHex;
    const fill = basis === 'derived' ? tint(base, 0.55) : base;
    const top = [P(x, y, z + zh), P(x + w, y, z + zh), P(x + w, y + h, z + zh), P(x, y + h, z + zh)];
    const left = [P(x, y + h, z + zh), P(x + w, y + h, z + zh), P(x + w, y + h, z), P(x, y + h, z)];
    const right = [P(x + w, y, z + zh), P(x + w, y + h, z + zh), P(x + w, y + h, z), P(x + w, y, z)];
    grow(top); if (mode === 'iso') { grow(left); grow(right); }
    const dash = basis === 'derived' || hollow ? ' stroke-dasharray="5 3"' : '';
    const stroke = hollow ? '#7c8798' : basis === 'derived' ? shade(base, 0.7) : 'rgba(255,255,255,.55)';
    const sw = hollow || basis === 'derived' ? 1.2 : 0.6;
    const faces = hollow
      ? [[left, '#ffffff'], [right, '#ffffff'], [top, '#ffffff']].map(([f, c]) => `<polygon points="${pts(f)}" fill="${c}" fill-opacity=".55" stroke="${stroke}" stroke-width="${sw}"${dash}/>`)
      : [...(mode === 'iso' ? [[left, shade(fill, 0.8)], [right, shade(fill, 0.66)]] : []), [top, basis === 'declared' ? 'url(#declared)' : fill]]
        .map(([f, c]) => `<polygon points="${pts(f)}" fill="${c}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`);
    const op = n.state === 'stale' ? ' opacity=".5"' : '';
    el.push(`<g data-id="${esc(n.id)}" data-kind="${n.kind}" data-basis="${basis}" data-state="${n.state}"${op}>${faces.join('')}</g>`);
    boxOf.set(n.id, { x, y, w, h, z, zh, top });
    return top;
  };

  const wire = (a, b, cls) => {
    el.push(`<polyline points="${pts([a, b])}" class="${cls}"/>`);
  };

  const place = (e, ox, oy, z) => {
    const n = byId.get(e.id); const x = ox + e.x; const y = oy + e.y;
    const hasKids = e.children?.length;
    const k = n.kind === 'vm' && hasKids ? 'dockerhost' : n.kind;
    const zh = HEIGHT[k];
    box(e, x, y, e.width, e.height, z, zh, COLOR[k]);
    if (!hasKids) return;
    const list = e.children.map((c) => ({ ...c, width: c.width, height: c.height }));
    if (n.kind === 'node') {
      const zt = z + zh; const br = e.children.filter((c) => byId.get(c.id).kind === 'bridge');
      const guests = data.edges.filter((d) => d.kind === 'attached');
      for (const d of guests) {
        const a = e.children.find((c) => c.id === d.source); const b = e.children.find((c) => c.id === d.target);
        if (a && b) wire(P(x + a.x + a.width / 2, y + a.y + a.height / 2, zt), P(x + b.x + b.width / 2, y + b.y + b.height / 2, zt), 'attach');
      }
      for (const c of br) wire(P(x, y + c.y + c.height / 2, zt), P(x + c.x, y + c.y + c.height / 2, zt), 'attach');
    }
    for (const c of paintOrder(list)) place(c, x, y, z + zh);
  };

  // Ground grid, then edges on the ground plane, then blocks back to front.
  const top = paintOrder(g.children);
  const W = g.width; const H = g.height; const pad = 40;
  grow([P(-pad, -pad), P(W + pad, -pad), P(W + pad, H + pad), P(-pad, H + pad)]);
  el.push(`<polygon points="${pts([P(-pad, -pad), P(W + pad, -pad), P(W + pad, H + pad), P(-pad, H + pad)])}" fill="#f8f9fb" stroke="#d6dbe3"/>`);
  for (let t = 0; t <= W + 2 * pad; t += 80) el.push(`<polyline points="${pts([P(t - pad, -pad), P(t - pad, H + pad)])}" class="grid"/>`);
  for (let t = 0; t <= H + 2 * pad; t += 80) el.push(`<polyline points="${pts([P(-pad, t - pad), P(W + pad, t - pad)])}" class="grid"/>`);
  for (const e of g.edges ?? []) {
    const d = data.edges.find((x) => x.id === e.id);
    for (const s of e.sections ?? []) {
      const line = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => P(p.x, p.y));
      el.push(`<polyline points="${pts(line)}" class="edge ${d.basis}" data-edge="${esc(e.id)}"/>`);
    }
  }
  for (const c of top) place(c, 0, 0, 0);

  // Docker plane with no source: a dashed ghost above the cluster. It claims a tier with unknown content, not containers.
  if (!data.meta.dockerSource && mode === 'iso') {
    const nodes = g.children.filter((c) => byId.get(c.id).kind === 'node');
    const x0 = Math.min(...nodes.map((n) => n.x)) - 16; const x1 = Math.max(...nodes.map((n) => n.x + n.width)) + 16;
    const y0 = Math.min(...nodes.map((n) => n.y)) - 16; const y1 = Math.max(...nodes.map((n) => n.y + n.height)) + 16;
    const z = 110; const q = [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)]; grow(q);
    el.push(`<polygon points="${pts(q)}" fill="#8a68d4" fill-opacity=".03" stroke="#8a68d4" stroke-width="1.2" stroke-dasharray="7 5" data-id="plane-docker" data-kind="plane" data-basis="unknown" data-state="unknown"/>`);
    byId.set('plane-docker', { id: 'plane-docker', kind: 'plane', title: 'Docker 계층 · 출처 없음' });
    boxOf.set('plane-docker', { top: q });
    labels.push({ id: 'plane-docker', text: 'Docker 계층 · 출처 없음', at: [q[0][0] + 100, q[0][1] - 4], pr: 0, color: '#6a4cc0' });
  }

  // Labels stay screen-horizontal, never sheared with the plane. Priority decides who shows; candidates keep edge objects visible.
  const rank = { node: 0, wan: 1, gateway: 1, tunnel: 1, proxy: 1, segment: 1, vm: 2, lxc: 2 };
  const edgeTier = new Set(['wan', 'gateway', 'tunnel', 'proxy', 'segment']);
  const dense = data.nodes.length >= 60;
  const obstacles = [];
  for (const n of data.nodes) {
    const b = boxOf.get(n.id); if (!b) continue;
    const leaf = ['vm', 'lxc', 'container', 'bridge', 'storage'].includes(n.kind);
    if (leaf && dense && lod !== 'all') continue;
    const xs = b.top.map((p) => p[0]); const ys = b.top.map((p) => p[1]);
    const cx = xs.reduce((s, p) => s + p, 0) / 4; const cy = ys.reduce((s, p) => s + p, 0) / 4;
    const bx = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (edgeTier.has(n.kind)) obstacles.push({ x: bx[0], y: bx[1], w: bx[2] - bx[0], h: bx[3] - bx[1] + 34 * S });
    let at = [cx, cy]; let offsets = [[0, 0]];
    if (n.kind === 'node') {
      at = mode === 'iso' ? [(b.top[0][0] + b.top[3][0]) / 2 - 6, (b.top[0][1] + b.top[3][1]) / 2 - 16] : [b.top[0][0] + 50, b.top[0][1] - 12];
      if (mode === 'iso') offsets = [[0, 0], [(b.top[3][0] + b.top[2][0]) / 2 - at[0] - 34, (b.top[3][1] + b.top[2][1]) / 2 - at[1] + 28 * S + 16]];
    } else if (edgeTier.has(n.kind)) { at = [cx, bx[1] - 14]; offsets = [[0, 0], [-(bx[2] - bx[0]) / 2 - 70, 26], [(bx[2] - bx[0]) / 2 + 70, 26], [0, bx[3] - bx[1] + 44 * S + 26]]; }
    else if (leaf && mode === 'iso') at = [cx, cy - 10];
    let text = n.title;
    if (n.state === 'starting') text += ' · 기동 중'; else if (n.state === 'error') text += ' · 오류'; else if (n.state === 'stopped') text += ' · 중지'; else if (n.state === 'stale') text += ' · 낡음';
    if (n.kind === 'node' && dense) text += ` · 게스트 ${data.nodes.filter((c) => c.parent === n.id && ['vm', 'lxc'].includes(c.kind)).length}`;
    labels.push({ id: n.id, text, at, offsets, pr: rank[n.kind] ?? (n.kind === 'container' ? 6 : INFRA.has(n.kind) ? 3 : 4), anchor: n.kind === 'node' ? null : [cx, cy] });
  }

  const v = crop ?? [bounds[0] - 24, bounds[1] - 44, bounds[2] - bounds[0] + 48, bounds[3] - bounds[1] + 88];
  // The tier card and the legend float over the map; labels under them would be unreadable.
  const k = v[2] / 1140; const covers = [[0, 0, 300, 160], [0, 790, 330, 852]].map(([a, b, c, d]) => ({ x: v[0] + a * k, y: v[1] + b * k, w: (c - a) * k, h: (d - b) * k }));
  const placed = []; const hidden = [];
  const fs = 12;
  const clash = (r, p, m = 3) => r.x < p.x + p.w + m && p.x < r.x + r.w + m && r.y < p.y + p.h + 2 && p.y < r.y + r.h + 2;
  for (const l of [...labels].sort((a, b) => a.pr - b.pr)) {
    const w = wide(l.text) * fs + 12; const h = fs + 7; let done = false;
    for (const [dx, dy] of l.offsets ?? [[0, 0]]) {
      const r = { x: l.at[0] + dx - w / 2, y: l.at[1] + dy - h / 2, w, h };
      const inside = r.x >= v[0] + 2 && r.y >= v[1] + 2 && r.x + w <= v[0] + v[2] - 2 && r.y + h <= v[1] + v[3] - 2;
      const others = obstacles.filter((o) => !(l.pr === 1 && (l.offsets?.length ?? 0) > 1 && l.anchor && Math.abs(o.x + o.w / 2 - l.anchor[0]) < 1));
      if (!inside || covers.some((c) => clash(r, c, 0)) || placed.some((p) => clash(r, p)) || others.some((o) => clash(r, o, 0))) continue;
      placed.push({ ...r, l: { ...l, at: [l.at[0] + dx, l.at[1] + dy] } }); done = true; break;
    }
    if (!done) hidden.push(l.id);
  }
  const lb = placed.map(({ x, y, w, h, l }) => {
    const lead = l.anchor && Math.hypot(l.anchor[0] - l.at[0], l.anchor[1] - l.at[1]) > 18 ? `<line x1="${l.at[0].toFixed(1)}" y1="${(y + h).toFixed(1)}" x2="${l.anchor[0].toFixed(1)}" y2="${l.anchor[1].toFixed(1)}" class="lead"/>` : '';
    return `<g class="lb" data-for="${esc(l.id)}">${lead}<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="3"/><text x="${(x + w / 2).toFixed(1)}" y="${(y + h - 5.4).toFixed(1)}" text-anchor="middle"${l.color ? ` fill="${l.color}"` : ''}>${esc(l.text)}</text></g>`;
  });
  return { svgBody: el.join('') + lb.join(''), view: v, bounds, hidden, shown: placed.length };
}

const page = (data, s, mode, note) => {
  const basisName = { observed: '관측', derived: '추정', declared: '선언', unknown: '미확인' };
  const m = data.meta;
  return `<!doctype html><meta charset="utf-8"><title>relief spike</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%}body{font:13px ${FONT};color:#1d2530;background:#eef1f5;display:grid;grid-template:48px 1fr/1fr 300px;width:1440px;height:900px;overflow:hidden}
header{grid-column:1/3;display:flex;align-items:center;gap:14px;padding:0 16px;background:#fff;border-bottom:1px solid #d6dbe3}
header b{font-size:15px}.seg{display:flex;border:1px solid #c3ccd8;border-radius:5px;overflow:hidden}.seg span{padding:3px 11px}.seg .on{background:#1d2530;color:#fff}.chip{margin-left:auto;color:#55617a}
main{position:relative;overflow:hidden}svg{display:block;width:100%;height:100%}
.grid{stroke:#e9ecf1;stroke-width:1;fill:none}.edge{fill:none;stroke:#5d6b80;stroke-width:1.6}.edge.unknown,.edge.derived{stroke-dasharray:6 4}.edge.declared{stroke:#dd7f33}.attach{fill:none;stroke:#5d6b80;stroke-width:1.1}
.lb rect{fill:rgba(255,255,255,.93);stroke:#c3ccd8;stroke-width:.6}.lb text{font:500 12px ${FONT};fill:#1d2530}.lead{stroke:#7c8798;stroke-width:.8}
.tiers{position:absolute;left:14px;top:14px;background:rgba(255,255,255,.94);border:1px solid #d6dbe3;border-radius:6px;padding:9px 12px;width:286px}
.tiers h4,.legend h4{margin:0 0 5px;font-size:12px;color:#55617a;font-weight:600}.tiers div{display:flex;justify-content:space-between;gap:8px;line-height:21px;white-space:nowrap}.tiers i{font-style:normal;color:#55617a;text-align:right}
.legend{position:absolute;left:14px;bottom:14px;background:rgba(255,255,255,.94);border:1px solid #d6dbe3;border-radius:6px;padding:9px 12px;display:flex;gap:13px;align-items:center}
.sw{display:inline-block;width:15px;height:11px;margin-right:4px;vertical-align:-1px;background:#4a78e0}.sw.derived{background:#fff;border:1.4px dashed #4a78e0}.sw.declared{background:repeating-linear-gradient(135deg,#dd7f33 0 3px,#f3d3b6 3px 6px)}.sw.unknown{background:#fff;border:1.4px dashed #7c8798}
aside{background:#fff;border-left:1px solid #d6dbe3;padding:14px;overflow:hidden}aside h3{margin:0;font-size:16px}aside p{margin:2px 0 12px;color:#55617a}
.row{padding:7px 0;border-top:1px solid #edf0f4}.row .k{color:#55617a;font-size:12px}.row .v{font-size:14px}.row .v.unknown{color:#8a5a00}.row .m{color:#6b7688;font-size:11.5px}
</style><header><b>relief</b><div class="seg"><span class="${mode === 'iso' ? 'on' : ''}">3D</span><span class="${mode === 'iso' ? '' : 'on'}">2D</span></div>
<div class="seg"><span class="on">상태</span><span>부하</span><span>출처</span><span>신선도</span></div><span class="chip">합성 fixture · ${esc(note)}</span></header>
<main><svg viewBox="${s.view.map((n) => n.toFixed(1)).join(' ')}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="sagae 네트워크 지도"><defs><pattern id="declared" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#f3d3b6"/><rect width="3.5" height="7" fill="#dd7f33"/></pattern></defs>${s.svgBody}</svg>
<div class="tiers"><h4>계층</h4>${m.tiers.map(([a, b]) => `<div><span>${esc(a)}</span><i>${esc(b)}</i></div>`).join('')}</div>
<div class="legend"><h4 style="margin:0">근거</h4><span><span class="sw"></span>관측</span><span><span class="sw derived"></span>추정</span><span><span class="sw declared"></span>선언</span><span><span class="sw unknown"></span>미확인</span></div></main>
<aside><h3>${esc(m.panel.title)}</h3><p>${esc(m.panel.sub)}</p>${m.panel.rows.map(([k, v, b, age]) => `<div class="row"><div class="k">${esc(k)}</div><div class="v ${b}">${esc(v)}</div><div class="m">${basisName[b]} · ${esc(age)}</div></div>`).join('')}</aside>`;
};

// Run in the page: geometry truth from the browser, not from the width estimate.
const audit = () => {
  const svg = document.querySelector('svg'); const box = svg.getBoundingClientRect();
  const lbs = [...document.querySelectorAll('.lb')].map((g) => ({ id: g.dataset.for, r: g.querySelector('rect').getBoundingClientRect(), t: g.querySelector('text').getBoundingClientRect() }));
  const overlaps = [];
  for (let i = 0; i < lbs.length; i++) for (let j = i + 1; j < lbs.length; j++) {
    const a = lbs[i].r; const b = lbs[j].r;
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push([lbs[i].id, lbs[j].id]);
  }
  const clipped = lbs.filter((l) => l.r.left < box.left || l.r.right > box.right || l.r.top < box.top || l.r.bottom > box.bottom).map((l) => l.id);
  const overflow = lbs.filter((l) => l.t.width > l.r.width - 2).map((l) => l.id);
  const objects = [...document.querySelectorAll('[data-id]')];
  const ids = new Set(objects.map((o) => o.dataset.id));
  const orphans = lbs.filter((l) => !ids.has(l.id)).map((l) => l.id);
  const far = [];
  for (const l of lbs) {
    const o = document.querySelector(`[data-id="${CSS.escape(l.id)}"]`); if (!o) continue;
    const r = o.getBoundingClientRect();
    const d = Math.hypot(Math.max(r.left - l.r.right, 0, l.r.left - r.right), Math.max(r.top - l.r.bottom, 0, l.r.top - r.bottom)); // gap between the two rectangles
    if (d > 24) far.push([l.id, Math.round(d)]);
  }
  const noBasis = objects.filter((o) => !o.dataset.basis).length;
  const panel = document.querySelector('aside'); const tiers = document.querySelector('.tiers').getBoundingClientRect();
  const underLegend = lbs.filter((l) => l.r.left < tiers.right && l.r.top < tiers.bottom).map((l) => l.id);
  const legend = document.querySelector('.legend').getBoundingClientRect();
  const underLegend2 = lbs.filter((l) => l.r.left < legend.right && l.r.bottom > legend.top).map((l) => l.id);
  return { labels: lbs.length, overlaps, clipped, overflow, orphans, far, objects: objects.length, noBasis, panelOverflow: panel.scrollHeight > panel.clientHeight, underLegend, underLegend2, elements: document.querySelectorAll('svg *').length };
};

const fit = (g, mode, sx = 1140, sy = 852) => {
  const probe = scene(g.data, g.out, { mode, S: 1 });
  const [a, b, c, d] = probe.bounds; const bw = c - a + 48; const bh = d - b + 88;
  return Math.min(sx / bw, sy / bh);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const results = {};
async function shot(name, data, g, opts, note) {
  const s = scene(data, g, opts);
  const html = page(data, s, opts.mode ?? 'iso', note);
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(String(e)));
  const t0 = performance.now();
  await p.setContent(html, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  const paintMs = await p.evaluate(() => new Promise((r) => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t))); }));
  await p.screenshot({ path: `${name}.png` });
  const a = await p.evaluate(audit);
  results[name] = { ...a, hiddenLabels: s.hidden.length, S: +opts.S.toFixed(3), loadMs: Math.round(performance.now() - t0), rafMs: Math.round(paintMs), svgKB: Math.round(html.length / 1024), errors };
  await p.close();
}

const t = today(); const l = large();
const tL = await layout(t); const lL = await layout(l);
results.layoutMs = { today: Math.round(tL.ms), large: Math.round(lL.ms), objects: { today: t.nodes.length, large: l.nodes.length, edges: l.edges.length } };

await shot('today', t, tL.out, { S: fit({ data: t, out: tL.out }, 'iso') * 0.96 }, '오늘 모양');
await shot('today-2d', t, tL.out, { mode: '2d', S: fit({ data: t, out: tL.out }, '2d') * 0.96 }, '오늘 모양, 2D');
await shot('large', l, lL.out, { S: fit({ data: l, out: lL.out }, 'iso') * 0.96 }, `${l.nodes.length}개 객체`);
const zS = 1.15;
const n2 = lL.out.children.find((c) => c.id === 'node-2'); const cx = (n2.x + n2.width / 2 - n2.y - n2.height / 2) * C * zS; const cy = (n2.x + n2.width / 2 + n2.y + n2.height / 2) * 0.5 * zS;
await shot('large-zoom', l, lL.out, { S: zS, lod: 'all', crop: [cx - 570, cy - 426, 1140, 852] }, `${l.nodes.length}개 객체, 확대`);

// Scale and stability, measured on the same pipeline. Not GPU numbers.
const big = large({ nodeCount: 9, guestsPerNode: 18, containerHosts: 26 });
const bL = await layout(big);
await shot('scale-500', big, bL.out, { S: fit({ data: big, out: bL.out }, 'iso') * 0.96 }, `${big.nodes.length}개 객체`);
results.layoutMs.big = { objects: big.nodes.length, ms: Math.round(bL.ms) };

const flat = (root) => { const m = new Map(); const walk = (e, ox, oy) => { for (const c of e.children ?? []) { m.set(c.id, [ox + c.x, oy + c.y]); walk(c, ox + c.x, oy + c.y); } }; walk(root, 0, 0); return m; };
async function moved(pack, addGuests) {
  const A = flat((await layout(large(), pack)).out); const B = flat((await layout(large({ addGuests }), pack)).out);
  const d = []; for (const [id, a] of A) { const b = B.get(id); if (b) { const v = Math.hypot(a[0] - b[0], a[1] - b[1]); if (v > 0.5) d.push(v); } }
  return { objects: A.size, moved: d.length, maxMove: Math.round(Math.max(0, ...d)) };
}
results.stability = {};
for (const pack of ['elk', 'shelf']) {
  const one = []; for (let i = 1; i <= 5; i++) one.push(await moved(pack, { [`node-${i}`]: 1 }));
  results.stability[pack] = { addOne: one, addTwelveToNode2: await moved(pack, { 'node-2': 12 }) };
}
await browser.close();
writeFileSync('results.json', JSON.stringify(results, null, 1));
for (const [k, v] of Object.entries(results)) console.log(k, JSON.stringify(v));
