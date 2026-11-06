// Probe: can the loupe proxy decode a zstd export from a Unix socket and stream plain JSON, whichever way KB labels it?
import http from "node:http"; import zlib from "node:zlib"; import crypto from "node:crypto"; import fs from "node:fs"; import { pipeline } from "node:stream/promises";
const sock = process.argv[2]; const proxyPort = 0;
const rows = Array.from({ length: 50000 }, (_, i) => [`e:feature/n${i}`, "Feature", `라벨${i}`, "external", "active", "G"]);
const json = Buffer.from(JSON.stringify({ schema_version: "0.1.0", nodes: { columns: ["id","type","label","origin","status","domain"], rows } }));
const zst = zlib.zstdCompressSync(json);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 12);
for (const label of ["content-encoding", "application/zstd"]) {
  fs.rmSync(sock, { force: true });
  const kb = http.createServer((q, s) => {
    const h = label === "content-encoding" ? { "content-type": "application/json", "content-encoding": "zstd" } : { "content-type": "application/zstd" };
    s.writeHead(200, { ...h, "content-length": zst.length }); s.end(zst);
  }).listen(sock);
  await new Promise((r) => kb.once("listening", r));
  const proxy = http.createServer((q, s) => {
    http.get({ socketPath: sock, path: q.url, agent: false }, async (u) => {
      s.writeHead(200, { "content-type": "application/json" });
      await pipeline(u, zlib.createZstdDecompress(), s);
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => proxy.once("listening", r));
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${proxy.address().port}/kb/v1/export/graph?profile=core`);
  const body = Buffer.from(await res.arrayBuffer());
  const t1 = performance.now();
  const ok = sha(body) === sha(json); const parsed = JSON.parse(body.toString()).nodes.rows.length;
  console.log(label.padEnd(18), "raw", json.length, "zstd", zst.length, "same bytes", ok, "rows", parsed, "ms", (t1 - t0).toFixed(1));
  proxy.close(); kb.close();
}
fs.rmSync(sock, { force: true });
