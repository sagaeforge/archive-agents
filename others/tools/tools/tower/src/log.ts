// One JSON object per line on stdout; journald keeps it. Substituted secrets never reach a line.
import { randomUUID } from 'node:crypto';

const boot = randomUUID().slice(0, 8);
export const secrets = new Set<string>();
// Longest first, so a value that starts another one cannot leave the other's tail. An echo inside a JSON body carries the escaped form.
const forms = () => [...secrets].flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]).sort((a, b) => b.length - a.length);
export const redact = (text: string) => forms().reduce((out, secret) => out.replaceAll(secret, '***'), text);
// A ring is cut at a byte offset and a value at the cut no longer matches, so a cut ring loses as many bytes as the longest value has.
export const redactRing = (ring: Buffer, cut: boolean) => redact(ring.subarray(cut ? Math.max(0, ...forms().map((s) => Buffer.byteLength(s))) : 0).toString());

// For JSON.stringify: each string on its own, because redacting the finished text would miss what its escaping changed.
export const redacted = (_key: string, value: unknown) => (typeof value === 'string' ? redact(value) : value);

export function log(kind: 'call' | 'http' | 'event', fields: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), boot, kind, ...fields }, redacted)}\n`);
}

export const event = (name: string, upstream?: string, detail?: unknown) => log('event', { event: name, upstream, detail });

export const faults = new Map<string, string>(); // What the last run of each attempt left wrong. Status shows it.

// A step that may fail without taking tower down, from a timer or at boot. The event name is the failure.
export function attempt<T>(name: string, step: () => T) {
  faults.delete(name);
  try {
    return step();
  } catch (err) {
    event(name, undefined, faults.set(name, redact((err as Error).message)).get(name));
  }
}
