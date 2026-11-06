// The text of an "SSH 명령 복사" button (design 1, 7.1, 19). relief only builds a line; it never connects, spawns or holds a credential.
// The owner pastes the line into a real shell, and guest-agent values are attacker-influenced, so every part passes an allowlist and anything else gives no command.
import type { Entity } from './fact.ts';
import { v4 } from './rules.ts';

/** A name that cannot start with `-` (no ssh option injection) and holds no shell metacharacter, space, quote or non-ASCII letter. */
export const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

/** Canonical dotted quad only: `010.0.0.1` is octal to ssh, and a zone or a port is no part of an address. */
export const isDottedV4 = (a: unknown): a is string => {
  if (typeof a !== 'string' || a.length > 15) return false;
  const n = v4(a);
  return n !== null && [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.') === a;
};

/** Pure: the same input, the same single line. Returns null whenever a part fails its rule. */
export function sshLine(target: unknown, user?: unknown): string | null {
  // All digits and dots is an address or nothing: `010.0.0.1` and `192.0.2.256` pass the name rule, but a resolver may read them as octal or as another host.
  const t = typeof target === 'string' && (isDottedV4(target) || (SSH_HOST.test(target) && !/^[0-9.]+$/.test(target))) ? target : null;
  if (t === null) return null;
  if (user === undefined || user === null) return `ssh ${t}`;
  return typeof user === 'string' && SSH_USER.test(user) ? `ssh ${user}@${t}` : null;
}

export type SshOffer = { command: string } | { why: string };

/** Nodes by their observed name; guests by their first observed IPv4, with the declared user if there is one. Other kinds get no offer (null). */
export function sshOffer(e: Entity): SshOffer | null {
  if (e.kind === 'node') {
    if (e.basis !== 'observed' || e.gone) return { why: '관측된 노드가 아니다' };
    // The id carries the name PVE gave, whole; the title is cut and stripped for the screen.
    const c = e.id.startsWith('pve:node:') ? sshLine(e.id.slice('pve:node:'.length)) : null;
    return c ? { command: c } : { why: '노드 이름이 SSH에 쓸 수 있는 형식이 아니다' };
  }
  if (e.kind === 'workstation') return { why: 'SSH 서버가 확인되지 않았다' };
  if (e.kind !== 'vm' && e.kind !== 'lxc') return null;
  if (e.gone) return { why: '게스트가 사라졌다' };
  const ip = e.facts.ip;
  if (ip?.basis !== 'observed' || !Array.isArray(ip.value)) return { why: ip?.why ?? '관측된 IP가 없다' };
  const addr = (ip.value as unknown[]).find((a) => isDottedV4(a) && !a.startsWith('127.') && !a.startsWith('169.254.'));
  if (addr === undefined) return { why: '쓸 수 있는 IPv4가 없다' };
  const u = e.facts.sshUser;
  const user = u?.basis === 'declared' && typeof u.value === 'string' ? u.value : undefined;
  if (u?.basis === 'declared' && user === undefined) return { why: 'SSH 사용자 선언이 형식에 맞지 않는다' };
  const c = sshLine(addr, user);
  return c ? { command: c } : { why: 'SSH 사용자 선언이 형식에 맞지 않는다' };
}
