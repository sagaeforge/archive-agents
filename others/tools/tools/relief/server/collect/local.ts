// The `local` read adapter (design 5, 19): this machine, from `node:os` only. No network call, no process, no file.
// Values pass the same gate as a guest's: cut, stripped of invisible characters, and refused unless they parse.
import * as os from 'node:os';
import { clean } from '../model/guest.ts';
import { isDottedV4 } from '../model/ssh.ts';

export type LocalRead = { hostname: string | null; address: string | null; cores: number | null; memTotal: number | null; memFree: number | null; at: string };

/** Physical-looking names only: eth0, eno1, enp3s0, ens5, enx<mac>, wlan0, wlp2s0. Everything else (lo, docker0, veth*, br-*, virbr*, tailscale0, wg0, vEthernet) is not on the list, so a new kind of virtual interface starts out refused. */
const LAN_NAME = /^(?:eth\d{1,3}|en(?:o|p|s|x)[a-z0-9]{1,24}|wlan\d{1,3}|wl[a-z0-9]{1,24})$/;
type Ifaces = ReturnType<typeof os.networkInterfaces>;

/** The primary LAN IPv4: the first allowed interface (eth0 first, then by name) with a plain, non-loopback, non-link-local address. Null when none is safe. */
export function pickLan(ifaces: Ifaces): string | null {
  const names = Object.keys(ifaces).filter((n) => LAN_NAME.test(n)).sort((a, b) => (a === 'eth0' ? -1 : b === 'eth0' ? 1 : a < b ? -1 : 1));
  for (const n of names) {
    for (const i of ifaces[n] ?? []) {
      const a = i.address;
      if (i.family !== 'IPv4' || i.internal || !isDottedV4(a)) continue;
      if (a.startsWith('127.') || a.startsWith('169.254.') || a.startsWith('0.') || Number(a.split('.')[0]) >= 224) continue;
      return a;
    }
  }
  return null;
}

const count = (n: unknown): number | null => (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null);

export type LocalSource = Pick<typeof os, 'hostname' | 'networkInterfaces' | 'availableParallelism' | 'totalmem' | 'freemem'>;

export function readLocal(nowMs: number, src: LocalSource = os): LocalRead {
  const host = clean(src.hostname(), 64).trim();
  const total = count(src.totalmem()); const free = src.freemem();
  return {
    hostname: /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(host) ? host : null,
    address: pickLan(src.networkInterfaces()),
    cores: count(src.availableParallelism()),
    memTotal: total,
    memFree: total !== null && typeof free === 'number' && free >= 0 && free <= total ? free : null,
    at: new Date(nowMs).toISOString(),
  };
}
