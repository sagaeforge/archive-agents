// `edge.json` and the public address on the map (design 7.1). Observed wins on the map; what disagrees with it is a warning, never a failure of the source.
import { reviewByOf, type EdgeFile } from '../collect/edge.ts';
import type { LocalRead } from '../collect/local.ts';
import type { Basis, Entity, Fact, Relation } from './fact.ts';
import { inRange, networkOf, inNetwork } from './rules.ts';

export type WanRead = { address: string; at: string; ttlS: number };
export type External = { edge: EdgeFile | null; wan: WanRead | null; wanOff: boolean; local: LocalRead | null };

const BLANK = 'decl:wan:none';
const WARN = { record: 'A 레코드 낡음 가능', plan: '계획 밖 주소', nat: 'NAT 선언 모순' } as const;

const unk = (source: string, why: string): Fact<never> => ({ value: null, basis: 'unknown', source, at: null, ttlS: null, why });
const drv = (value: string, rule: string, at: string | null): Fact<string> => ({ value, basis: 'derived', source: `rule:${rule}`, at, ttlS: null });

function warn(e: Entity, text: string) { e.warnings = [...(e.warnings ?? []), text]; }

/** Current address of a host: observed first, unless a person saw a newer one after the observation went quiet. */
export const currentOf = (e: Entity | undefined, lease: { address: string; seenAt: string } | undefined) => {
  const seen = e?.facts.address;
  if (seen?.basis !== 'observed' || typeof seen.value !== 'string') return lease?.address;
  return lease && seen.at && Date.parse(lease.seenAt) > Date.parse(seen.at) ? lease.address : seen.value;
};

function checkPlan(e: Entity, f: EdgeFile, plan: string | undefined, addr: string | undefined, ptr: string) {
  if (plan === undefined) return;
  const p = f.addressPlan?.find((x) => x.key === plan);
  if (!p || addr === undefined) { e.facts.plan = unk(`rule:address-plan`, '비교 불가 · 주소가 없다'); return; }
  if (inRange(addr, p.from, p.to)) { e.facts.plan = { value: p.title, basis: 'declared', source: `edge.json#${ptr}`, at: f.declaredAt, ttlS: null, reviewBy: reviewByOf(f) }; return; }
  e.facts.plan = drv(`${WARN.plan} · ${p.title}`, 'address-plan', f.declaredAt);
  warn(e, WARN.plan);
}

export function overlayEdge(out: { nodes: Entity[]; edges: Relation[] }, x: External, nowMs: number) {
  const { nodes, edges } = out;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const add = (e: Entity) => { nodes.push(e); byId.set(e.id, e); return e; };
  const rel = (id: string, source: string, target: string, kind: Relation['kind'], basis: Basis, facts: Relation['facts'] = {}) => { if (byId.has(source) && byId.has(target) && !edges.some((r) => r.id === id)) edges.push({ id, source, target, kind, basis, facts }); };
  const wanFresh = x.wan !== null && (nowMs - Date.parse(x.wan.at)) / 1000 <= x.wan.ttlS;
  const publicIp = (e: Entity) => {
    e.facts.publicIp = x.wan ? { value: x.wan.address, basis: 'observed', source: 'wan-ip:', at: x.wan.at, ttlS: x.wan.ttlS } : unk('wan-ip:', x.wanOff ? '공인 IP 출처를 정하지 않았다' : '공인 IP를 아직 읽지 못했다');
  };
  const f = x.edge;
  if (!f) { const b = byId.get(BLANK); if (b) publicIp(b); return; }

  const reviewBy = reviewByOf(f);
  const d = <T>(value: T, ptr: string): Fact<T> => ({ value, basis: 'declared', source: `edge.json#${ptr}`, at: f.declaredAt, ttlS: null, reviewBy });
  const kept = (o: Record<string, unknown>, ptr: string, ks: string[]) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, d(o[k], ptr)]));
  const decl = (id: string, kind: Entity['kind'], title: string, ptr: string, facts: Entity['facts'] = {}, parent?: string) => add({ id, kind, title, basis: 'declared', state: 'ok', facts: { state: d('선언됨', ptr), ...facts }, ...(parent ? { parent } : {}) });

  // Outside tier. `lines: []` says there is none, so the blank box goes; no `lines` keeps it.
  if (f.lines) {
    const i = nodes.findIndex((n) => n.id === BLANK);
    if (i >= 0) { nodes.splice(i, 1); byId.delete(BLANK); for (let j = edges.length - 1; j >= 0; j--) if (edges[j]!.source === BLANK) edges.splice(j, 1); }
    f.lines.forEach((l, n) => {
      const ptr = `/lines/${n}`;
      const e = decl(`decl:wan:${l.key}`, 'wan', l.title, ptr, kept(l, ptr, ['isp', 'medium', 'addressing', 'downMbps', 'upMbps']));
      publicIp(e);
      const dd = (f.ddns ?? []).filter((y) => y.line === l.key).map((y) => y.hostname);
      if (dd.length) e.facts.ddns = d(dd, '/ddns');
    });
  } else {
    const b = byId.get(BLANK); if (b) publicIp(b);
  }

  // The router gives the guessed gateway a name, or stands by itself where nothing was guessed.
  const guessed = nodes.filter((n) => n.kind === 'gateway');
  let gw: Entity | undefined;
  if (f.router) {
    const r = f.router; const ptr = '/router';
    const same = r.address ? guessed.find((g) => g.facts.address?.value === r.address) : guessed.length === 1 ? guessed[0] : undefined;
    const facts = { ...kept(r, ptr, ['vendor', 'model', 'firmware']), state: d('선언됨', ptr) };
    if (same) {
      gw = same; same.title = r.title; same.basis = 'declared'; same.state = 'ok'; Object.assign(same.facts, facts);
    } else if (guessed.length === 1 && r.address) {
      // Two values for one device: the guess from observation stays on the map, the declared one stands beside it.
      gw = guessed[0]!; gw.facts.declaredAddress = d(r.address, ptr); Object.assign(gw.facts, facts); gw.title = r.title; gw.basis = 'declared'; gw.state = 'ok';
    } else {
      // By key, never by address: ids reach the state file and the change log, and a declared address must not.
      gw = decl(`decl:gateway:${r.key}`, 'gateway', r.title, ptr, { ...facts, ...(r.address ? { address: d(r.address, ptr) } : {}) });
    }
    if (r.lanCidr) gw.facts.lanCidr = d(r.lanCidr, ptr);
    if (r.dhcpRange) gw.facts.dhcpRange = d(r.dhcpRange.join(' ~ '), ptr);
  } else if (guessed.length === 1) gw = guessed[0];

  if (gw) {
    if (f.addressPlan?.length) gw.facts.addressPlan = d(f.addressPlan.map((p) => `${p.title} ${p.from}~${p.to}`), '/addressPlan');
  }

  let natHolder: Entity | undefined = gw;
  if (f.modem) {
    const m = f.modem; const ptr = '/modem';
    const me = decl(`decl:modem:${m.key}`, 'modem', m.title, ptr, kept(m, ptr, ['mode', 'vendor', 'model', 'allPortsTo']));
    natHolder = gw ?? me;
    rel(`e-wan-modem-${m.key}`, `decl:wan:${m.line}`, `decl:modem:${m.key}`, 'wan', 'declared');
    if (gw) rel(`e-modem-gw-${m.key}`, `decl:modem:${m.key}`, gw.id, 'wan', 'declared');
  } else if (gw) {
    for (const l of f.lines ?? []) rel(`e-wan-gw-${l.key}`, `decl:wan:${l.key}`, gw.id, 'wan', f.router ? 'declared' : 'unknown');
  }

  // The contradiction is between the file's own two values, so it needs no gateway: with none, the modem carries it.
  if (natHolder) {
    const nat = f.natLayers;
    natHolder.facts.natLayers = nat == null ? unk('edge.json#/natLayers', 'NAT 겹 수를 적지 않았다') : d(nat, '/natLayers');
    if (f.modem && nat != null && ((f.modem.mode === 'bridge' && nat >= 2) || (f.modem.mode === 'router' && nat <= 1))) {
      natHolder.facts.natCheck = drv(WARN.nat, 'nat-layers', f.declaredAt);
      warn(natHolder, WARN.nat);
    }
  }

  // Hosts: a node gets more facts, the workstation becomes a slab of its own, a BMC sits on its parent.
  const hostEntity = new Map<string, Entity>();
  const unmatched: string[] = [];
  f.hosts?.forEach((h, i) => {
    const ptr = `/hosts/${i}`;
    let e: Entity | undefined;
    if (h.kind === 'pve-node') {
      e = byId.get(`pve:node:${h.pveNode ?? h.key}`);
      if (!e) { unmatched.push(h.title); return; }
    } else if (h.kind === 'workstation') {
      // This machine, read by the `local` adapter: its own timestamp, observed. No safe interface means no address, never a guess.
      const l = x.local;
      const ob = (value: unknown): Fact<unknown> => ({ value, basis: 'observed', source: 'local:os', at: l!.at, ttlS: null });
      const facts: Entity['facts'] = {};
      if (l) {
        if (l.hostname) facts.hostname = ob(l.hostname);
        facts.address = l.address ? ob(l.address) : unk('local:os', '안전한 LAN 인터페이스를 찾지 못했다');
        if (l.cores) facts.cores = ob(l.cores);
        if (l.memTotal) facts.memTotal = ob(`${(l.memTotal / 2 ** 30).toFixed(1)} GiB`);
        if (l.memTotal && l.memFree !== null) facts.mem = ob(Math.min(1, Math.max(0, 1 - l.memFree / l.memTotal)));
      }
      e = decl(`host:${h.key}`, 'workstation', h.title, ptr, facts);
    } else { unmatched.push(h.title); return; }
    hostEntity.set(h.key, e);
    if (h.os) e.facts.os = d(h.os, `${ptr}/os`);
    if (h.lease) e.facts.lease = { value: h.lease.address, basis: 'declared', source: `edge.json#${ptr}/lease`, at: h.lease.seenAt, ttlS: null, reviewBy };
    checkPlan(e, f, h.plan, currentOf(e, h.lease), ptr);
    if (h.bmc === undefined) e.facts.bmc = unk(`edge.json#${ptr}/bmc`, 'BMC 유무를 적지 않았다');
    else if (h.bmc === 'none') e.facts.bmc = d('없음', `${ptr}/bmc`);
    else if (e.kind !== 'node') e.facts.bmc = d('있음', `${ptr}/bmc`); // A workstation slab has no shelf to stand on.
    else {
      const b = h.bmc; const bp = `${ptr}/bmc`;
      const me = decl(`decl:bmc:${h.key}`, 'bmc', `BMC ${h.title}`.slice(0, 64), bp, {
        ...(b.interface ? { interface: d(b.interface, bp) } : {}),
        address: b.lease ? { value: b.lease.address, basis: 'declared', source: `edge.json#${bp}/lease`, at: b.lease.seenAt, ttlS: null, reviewBy } : unk(`edge.json#${bp}/lease`, '주소 미확인'),
      }, e.id);
      checkPlan(me, f, b.plan, b.lease?.address, bp);
    }
  });
  // The login name of a guest, for the copy-only SSH button. It sits on the observed guest; a guest nobody sees gets nothing.
  f.guests?.forEach((g, i) => {
    const e = nodes.find((n) => (n.kind === 'vm' || n.kind === 'lxc') && n.basis === 'observed' && n.id.split(':')[2] === String(g.vmid));
    if (e && g.sshUser) e.facts.sshUser = d(g.sshUser, `/guests/${i}`);
    if (e && g.expected) e.facts.expected = d(g.expected, `/guests/${i}`);
  });
  if (gw && unmatched.length) gw.facts.unmatchedHosts = d(unmatched, '/hosts');

  // Everything else that hangs off the router.
  const anchor = (k?: string) => (k === undefined || k === f.router?.key ? gw : hostEntity.get(k) ?? byId.get(`decl:proxy:${k}`));
  f.proxies?.forEach((p, i) => {
    decl(`decl:proxy:${p.key}`, 'proxy', p.title, `/proxies/${i}`, p.address ? { address: d(p.address, `/proxies/${i}`) } : {});
    if (gw) rel(`e-gw-proxy-${p.key}`, gw.id, `decl:proxy:${p.key}`, 'lan', 'declared');
  });
  const forwards = f.portForwards;
  if (gw) {
    gw.facts.portForwards = forwards === undefined ? unk('edge.json#/portForwards', '포트 포워드 미확인') : d(`${forwards.filter((p) => p.enabled).length}개 선언`, '/portForwards');
    const off = forwards?.filter((p) => !p.enabled).map((p) => p.title) ?? [];
    if (off.length) gw.facts.forwardsOff = d(off, '/portForwards');
    const lost = forwards?.filter((p) => p.enabled && !hostEntity.has(p.host)).map((p) => p.title) ?? [];
    if (lost.length) gw.facts.forwardsLost = d(lost, '/portForwards');
    forwards?.forEach((p) => { const t = hostEntity.get(p.host); if (p.enabled && t) rel(`e-forward-${p.key}`, gw!.id, t.id, 'forward', 'declared', { port: d(`${p.protocol} ${String(p.externalPort)} → ${String(p.internalPort)}`, '/portForwards') }); });
  }
  f.dnsRecords?.forEach((r, i) => {
    const ptr = `/dnsRecords/${i}`;
    const e = decl(`decl:domain:${r.key}`, 'domain', r.hostname.slice(0, 64), ptr, kept(r, ptr, ['provider', 'managedBy']));
    e.facts.record = r.value ? d(r.value, ptr) : unk(`edge.json#${ptr}`, 'A 레코드 값을 적지 않았다');
    const wanOk = wanFresh ? x.wan! : null;
    // Behind a proxy the record names the proxy's address, which says nothing about this line's.
    if (f.proxies?.some((p) => p.key === r.target)) e.facts.aRecord = unk('rule:a-record', '비교 불가 · 프록시를 가리키는 레코드다');
    else if (!r.value) e.facts.aRecord = unk('rule:a-record', '비교 불가 · 선언값이 없다');
    else if (!x.wan) e.facts.aRecord = unk('rule:a-record', x.wanOff ? '비교 불가 · 공인 IP 출처가 없다' : '비교 불가 · 공인 IP를 읽지 못했다');
    else if (!wanOk) e.facts.aRecord = unk('rule:a-record', '비교 불가 · 공인 IP가 낡았다');
    else if (wanOk.address !== r.value) { publicIp(e); e.facts.aRecord = drv(WARN.record, 'a-record', wanOk.at); warn(e, WARN.record); }
    else { publicIp(e); e.facts.aRecord = drv('일치', 'a-record', wanOk.at); }
    const t = anchor(r.target);
    if (t) {
      rel(`e-dns-${r.key}`, e.id, t.id, 'dns', 'declared');
      e.facts.path = d(forwards === undefined ? '도메인 → 라우터 · 포트 포워드 미확인' : `도메인 → 라우터 · 포트 포워드 ${forwards.filter((p) => p.enabled).length}개 선언`, ptr);
    }
  });
  f.vpn?.forEach((v, i) => {
    const ptr = `/vpn/${i}`;
    const e = decl(`decl:tunnel:${v.key}`, 'tunnel', v.title, ptr, kept(v, ptr, ['protocol', 'role', 'port', 'subnet', 'enabled']));
    if (gw) rel(`e-tun-${v.key}`, e.id, gw.id, 'tunnel', 'declared');
  });
  f.wifi?.forEach((w, i) => {
    const ptr = `/wifi/${i}`;
    const e = decl(`decl:wifi:${w.key}`, 'wifi', w.title, ptr, kept(w, ptr, ['bands', 'guest', 'enabled']));
    if (gw) rel(`e-gw-wifi-${w.key}`, gw.id, e.id, 'lan', 'declared');
  });
  f.clients?.forEach((c, i) => {
    const ptr = `/clients/${i}`;
    const e = decl(`decl:clients:${c.key}`, 'clients', c.title, ptr, { presence: d(c.presence === 'intermittent' ? '가끔 보인다' : '늘 보인다', ptr), ...(c.devices ? { devices: d(c.devices.map((v) => v.title), ptr) } : {}) });
    if (c.via) rel(`e-wifi-${c.key}`, `decl:wifi:${c.via}`, e.id, 'wireless', 'declared');
  });
  f.switches?.forEach((s, i) => {
    const ptr = `/switches/${i}`;
    decl(`decl:switch:${s.key}`, 'switch', s.title, ptr, kept(s, ptr, ['model', 'ports']));
  });
  f.switches?.forEach((s) => {
    const id = `decl:switch:${s.key}`;
    const up = s.uplink === f.router?.key ? gw?.id : `decl:switch:${s.uplink}`;
    if (up) rel(`e-lan-${s.key}`, up, id, 'lan', 'declared');
    for (const h of s.hosts ?? []) { const t = hostEntity.get(h); if (t) rel(`e-lan-${s.key}-${h}`, id, t.id, 'lan', 'declared'); }
  });
  // A wired PC no switch names sits on the LAN segment, as the nodes do: its address says which, and with no address a lone segment is the only one it can be on.
  // With no segment to stand on, or an address outside them all, it hangs off the router (design 7.1). A node needs none of this: its uplink is observed.
  f.hosts?.forEach((h, i) => {
    const t = hostEntity.get(h.key);
    if (!t || t.kind !== 'workstation' || !gw) return;
    const onSwitch = f.switches?.some((s) => s.hosts?.includes(h.key)) ?? false;
    const segments = nodes.filter((n) => n.kind === 'segment');
    const addr = currentOf(t, h.lease)?.split('/')[0];
    const segment = addr === undefined ? (segments.length === 1 ? segments[0] : undefined) : segments.find((n) => typeof n.facts.cidr?.value === 'string' && inNetwork(addr, n.facts.cidr.value));
    // Nobody declared this cable: the address implies it, so it reads as derived, with the rule's name.
    const onSegment = !onSwitch && !!segment;
    t.facts.link = onSegment ? drv('유선 · LAN', 'lan-address', f.declaredAt) : d(onSwitch ? '유선 · 스위치' : '유선 · 라우터', `/hosts/${i}`);
    if (!onSwitch) rel(`e-lan-${h.key}`, (segment ?? gw).id, t.id, 'lan', onSegment ? 'derived' : 'declared');
  });
}
