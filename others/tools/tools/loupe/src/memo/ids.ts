// Two things the window needs from the KB's id and hash rules (ADR-0005 5.1), computed the way kb-mock does until the KB is real:
//  - the id a create key leads to: `f-` + base32 of the first 16 bytes of SHA-256(prefix, actor, key), 26 characters. It lets a person who lost
//    the answer of a create (and then changed the text) keep going on the record the KB made, when the 409 does not name it.
//  - the payload hash of a record, to tell a 409 that is my own earlier save from someone else's. Over key-sorted compact JSON
//    (server/precheck.ts canonicalJson). `[가정]` until the KB fixes the form; a mismatch only makes the window show the conflict band.
import { canonicalJson } from '../../server/precheck.ts';

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const digest = (s: string) => globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
const b32 = (buf: Uint8Array) => {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, v = 0, out = '';
  for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += A[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  return bits > 0 ? out + A[(v << (5 - bits)) & 31] : out;
};

export const ACTOR = 'app:loupe';
export async function deriveRecordId(createKey: string): Promise<string> {
  return `f-${b32(new Uint8Array(await digest(`kb-record-id-editor-v1\0${ACTOR}\0${createKey}`)).subarray(0, 16)).slice(0, 26)}`;
}
/** What the save path sends as `record`: a memo (`Note`) or a document (`Page`, which may keep the `internal` it was made with and the `props` it has). */
export type NoteRecord = { type: 'Note' | 'Page'; title: string; body: string; body_format: 'markdown'; sensitivity: 'private' | 'internal'; props: Record<string, unknown>; links: never[] };
export async function payloadSha(r: NoteRecord): Promise<string> {
  return hex(await digest(canonicalJson({ type: r.type, title: r.title, body: r.body, body_format: r.body_format, sensitivity: r.sensitivity, props: r.props, links: r.links })));
}
