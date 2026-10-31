// node:http only, no third-party imports: floor for this machine.
import http from 'node:http';
let tL = 0, t; const IDLE = Number(process.env.IDLE_MS ?? 100);
const s = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ ok: true, listen_ms: tL, up_ms: performance.now() })); r.once('close', () => { clearTimeout(t); t = setTimeout(() => s.close(() => process.exit(0)), IDLE); }); });
s.listen({ fd: 3 }, () => { tL = performance.now(); });
