import http from "node:http";
import net from "node:net";
import fs from "node:fs";
const stale = process.argv[2], live = process.argv[3];
const hit = (socketPath, agent) => new Promise((res) => {
  const t0 = performance.now();
  const r = http.get({ socketPath, path: "/v1/meta", agent: agent ?? false }, (m) => { m.resume(); m.on("end", () => res(`status ${m.statusCode}`)); });
  r.setTimeout(3000, () => r.destroy(new Error("timeout")));
  r.on("error", (e) => res(`error ${e.code ?? e.message} after ${(performance.now()-t0).toFixed(1)} ms, reusedSocket=${r.reusedSocket}`));
});
console.log("stale socket file            ->", await hit(stale));
// Server that answers the first request, then dies on the second request of the same connection.
// This is the shape of an idle exit racing a pooled connection.
fs.rmSync(live, { force: true });
const srv = net.createServer((c) => {
  let n = 0;
  c.on("data", () => {
    n += 1;
    if (n === 1) c.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}");
    else c.destroy();
  });
  c.on("error", () => {});
});
await new Promise((r) => srv.listen(live, r));
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
console.log("pooled, first request        ->", await hit(live, agent));
console.log("pooled, server drops on reuse->", await hit(live, agent));
console.log("no pool, next request        ->", await hit(live));
agent.destroy(); srv.close();
