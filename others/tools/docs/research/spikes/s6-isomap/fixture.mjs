// Synthetic fixtures for the isometric spike. Every name and address here is invented.
// Addresses come from the documentation ranges in RFC 5737 only. Run: node fixture.mjs
import { writeFileSync } from 'node:fs';

const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Today's shape: 3 nodes, 1 VM, 0 LXC, one bridge per node, one flat /24, no Docker source, no WAN source.
export function today() {
  const nodes = [
    { id: 'wan', kind: 'wan', title: 'WAN 미확인', basis: 'unknown', state: 'unknown' },
    { id: 'gw', kind: 'gateway', title: '게이트웨이 192.0.2.1', basis: 'derived', state: 'unknown' },
    { id: 'seg', kind: 'segment', title: '192.0.2.0/24', basis: 'derived', state: 'ok' },
  ];
  const edges = [
    { id: 'e-wan', source: 'wan', target: 'gw', kind: 'wan', basis: 'unknown' },
    { id: 'e-gw', source: 'gw', target: 'seg', kind: 'route', basis: 'derived' },
  ];
  for (const n of ['가', '나', '다']) {
    const id = `node-${n}`;
    nodes.push({ id, kind: 'node', title: `노드 ${n}`, basis: 'observed', state: 'ok' });
    edges.push({ id: `e-${id}`, source: 'seg', target: id, kind: 'uplink', basis: 'observed' });
    nodes.push({ id: `${id}-br`, kind: 'bridge', parent: id, title: 'vmbr0', basis: 'observed', state: 'ok' });
    nodes.push({ id: `${id}-s1`, kind: 'storage', parent: id, title: 'local', basis: 'observed', state: 'ok' });
    nodes.push({ id: `${id}-s2`, kind: 'storage', parent: id, title: 'local-lvm', basis: 'observed', state: 'ok' });
  }
  nodes.splice(6, 0, { id: 'vm-100', kind: 'vm', parent: 'node-가', title: 'VM 100', basis: 'observed', state: 'running' });
  edges.push({ id: 'e-vm', source: 'node-가-br', target: 'vm-100', kind: 'attached', basis: 'observed' });
  return {
    meta: {
      name: 'today', dockerSource: false,
      tiers: [
        ['외부', 'WAN 출처 없음 · GW 1 추정'],
        ['노드', '3 관측 · 브리지 3 · 저장소 6'],
        ['게스트', 'QEMU 1 · LXC 0 관측'],
        ['Docker', '출처 없음'],
      ],
      panel: {
        title: 'VM 100', sub: 'QEMU · 노드 가',
        rows: [
          ['상태', '실행 중', 'observed', '12초 전'], ['vCPU, 메모리', '4 vCPU · 16 GiB', 'observed', '12초 전'],
          ['NIC', 'net0 → vmbr0, VLAN 없음', 'observed', '4분 전'], ['IP 주소', '미확인', 'unknown', 'guest agent 응답 없음'],
          ['OS', '미확인', 'unknown', 'guest agent 응답 없음'], ['Docker', '미확인', 'unknown', '출처 없음'],
          ['방화벽 규칙', '0건', 'observed', '4분 전'], ['태그', '없음', 'observed', '12초 전'],
        ],
      },
    },
    nodes, edges,
  };
}

// About 300 objects. Mixed basis and state so every visual encoding appears.
export function large({ nodeCount = 5, guestsPerNode = 16, containerHosts = 14, addGuests = {} } = {}) {
  const r = seeded(20261101);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const svc = ['결제', '로그', '빌드', '검색', '메일', '사내위키', '모니터', '백업', '배포', '인증', '데이터베이스', '캐시'];
  const app = ['api', 'web', 'worker', 'redis', 'pg', 'nginx', 'queue', 'cron', '수집기', '색인기', '내보내기'];
  const nodes = [
    { id: 'wan', kind: 'wan', title: '회선 A (선언)', basis: 'declared', state: 'ok' },
    { id: 'tun', kind: 'tunnel', title: 'VPN 터널 (선언)', basis: 'declared', state: 'ok' },
    { id: 'gw', kind: 'gateway', title: '게이트웨이 192.0.2.1', basis: 'derived', state: 'unknown' },
    { id: 'rp', kind: 'proxy', title: '리버스 프록시 (선언)', basis: 'declared', state: 'ok' },
    { id: 'seg1', kind: 'segment', title: '관리 192.0.2.0/24', basis: 'derived', state: 'ok' },
    { id: 'seg2', kind: 'segment', title: 'VLAN 20 198.51.100.0/24', basis: 'observed', state: 'ok' },
  ];
  const edges = [
    { id: 'e1', source: 'wan', target: 'gw', kind: 'wan', basis: 'declared' },
    { id: 'e2', source: 'tun', target: 'gw', kind: 'wan', basis: 'declared' },
    { id: 'e3', source: 'gw', target: 'rp', kind: 'route', basis: 'declared' },
    { id: 'e4', source: 'gw', target: 'seg1', kind: 'route', basis: 'derived' },
    { id: 'e5', source: 'rp', target: 'seg2', kind: 'route', basis: 'declared' },
  ];
  let vmid = 100, hosts = 0;
  for (let i = 0; i < nodeCount; i++) {
    const id = `node-${i + 1}`;
    nodes.push({ id, kind: 'node', title: `노드 ${i + 1}`, basis: 'observed', state: i === 3 ? 'stale' : 'ok' });
    for (const [s, seg] of [[1, 'seg1'], [2, 'seg2']]) {
      nodes.push({ id: `${id}-br${s}`, kind: 'bridge', parent: id, title: `vmbr${s - 1}`, basis: 'observed', state: 'ok' });
      edges.push({ id: `e-${id}-${s}`, source: seg, target: id, kind: 'uplink', basis: 'observed' });
      nodes.push({ id: `${id}-st${s}`, kind: 'storage', parent: id, title: s === 1 ? 'local' : 'local-lvm', basis: 'observed', state: 'ok' });
    }
    for (let g = 0; g < guestsPerNode; g++) {
      const isDocker = hosts < containerHosts && g % 3 === 0;
      const kind = isDocker || r() < 0.45 ? 'vm' : 'lxc';
      const roll = r();
      // Collection failed for node 4, so everything under it is last-known, not current.
      const state = i === 3 ? 'stale' : roll < 0.05 ? 'stopped' : roll < 0.08 ? 'starting' : roll < 0.095 ? 'error' : 'running';
      const gid = `${kind}-${vmid}`;
      const title = `${pick(svc)}-${vmid}`;
      nodes.push({ id: gid, kind, parent: id, title, basis: 'observed', state, docker: isDocker });
      vmid++;
      if (isDocker) {
        hosts++;
        const count = 9 + Math.floor(r() * 8);
        for (let c = 0; c < count; c++) {
          const cr = r();
          nodes.push({ id: `${gid}-c${c}`, kind: 'container', parent: gid, title: pick(app), basis: 'observed',
            state: state !== 'running' ? 'stale' : cr < 0.06 ? 'stopped' : 'running' });
        }
      }
    }
  }
  // Appended last so the seeded sequence, and with it every other id, stays the same. Used by the stability check.
  for (const [parent, count] of Object.entries(addGuests)) {
    for (let g = 0; g < count; g++) nodes.push({ id: `vm-new-${parent}-${g}`, kind: 'vm', parent, title: `신규-${g}`, basis: 'observed', state: 'starting' });
  }
  const counts = (k) => nodes.filter((n) => n.kind === k).length;
  return {
    meta: {
      name: 'large', dockerSource: true,
      tiers: [
        ['외부', '선언 3 · GW 1 추정'],
        ['노드', `${counts('node')} 관측 · 낡음 1`],
        ['게스트', `QEMU ${counts('vm')} · LXC ${counts('lxc')}`],
        ['Docker', `호스트 ${hosts} · 컨테이너 ${counts('container')}`],
      ],
      panel: {
        title: '노드 4', sub: '수집 실패 · 마지막 관측 3분 전',
        rows: [
          ['상태', '낡음', 'observed', '3분 전'], ['게스트', `${guestsPerNode}개 (마지막 값)`, 'observed', '3분 전'],
          ['브리지', 'vmbr0, vmbr1', 'observed', '3분 전'], ['회선', '회선 A', 'declared', '검토일 지남'],
        ],
      },
    },
    nodes, edges,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync('fixture-today.json', JSON.stringify(today(), null, 1));
  writeFileSync('fixture-large.json', JSON.stringify(large(), null, 1));
  console.log('today', today().nodes.length, 'large', large().nodes.length);
}
