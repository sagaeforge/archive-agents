// A stand-in for the public-address service. Tests only: relief must never reach a real one from here.
import http from 'node:http';

export type WanMock = { state: { status: number; body: string; location?: string }; hits: { value: number }; url: string; close(): Promise<void> };

export async function startWanMock(address: string): Promise<WanMock> {
  const state: WanMock['state'] = { status: 200, body: `${address}\n` };
  const hits = { value: 0 };
  const s = http.createServer((_req, res) => {
    hits.value += 1;
    res.writeHead(state.status, state.location ? { location: state.location } : { 'content-type': 'text/plain' });
    res.end(state.body);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as { port: number };
  return { state, hits, url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); }) };
}
