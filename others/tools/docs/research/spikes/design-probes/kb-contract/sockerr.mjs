// Note: Node unlinks the stale file on close here, so the stale-socket case gives ENOENT; sockerr2.mjs needs an externally prepared stale socket.
// Note: EACCES was measured with mode 0000 under the same UID, not with a different UID.
// What a node:http client sees for each state of the KB socket file.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
const dir = process.argv[2];
const hit = (socketPath) => new Promise((res) => {
  const t0 = performance.now();
  const r = http.get({ socketPath, path: "/v1/meta", agent: false }, (m) => { m.resume(); m.on("end", () => res(`status ${m.statusCode}, Host seen: ${m.headers["x-host"]}, ${(performance.now()-t0).toFixed(1)} ms`)); });
  r.setTimeout(3000, () => { r.destroy(new Error("timeout")); });
  r.on("error", (e) => res(`error ${e.code ?? e.message}, ${(performance.now()-t0).toFixed(1)} ms`));
});
// 1 missing file
console.log("missing socket file   ->", await hit(path.join(dir, "nope.sock")));
// 2 file exists, nothing listening (systemd stop without RemoveOnStop, or crash)
const stale = path.join(dir, "stale.sock");
fs.rmSync(stale, { force: true });
await new Promise((res) => {
  const s = net.createServer();
  s.listen(stale, () => { s._handle.close(); res(); });   // close the fd without unlinking
});
await new Promise((r) => setTimeout(r, 100));
console.log("stale socket file     ->", await hit(stale), "| exists:", fs.existsSync(stale));
// 3 live server, mode 0600 and then mode 0000 for the same uid
const live = path.join(dir, "live.sock");
fs.rmSync(live, { force: true });
const srv = http.createServer((q, s) => { s.setHeader("x-host", q.headers.host ?? "(none)"); s.end("{}"); });
await new Promise((r) => srv.listen(live, r));
fs.chmodSync(live, 0o600);
console.log("live socket, 0600     ->", await hit(live));
fs.chmodSync(live, 0o000);
console.log("live socket, 0000     ->", await hit(live));
fs.chmodSync(live, 0o600);
// 4 keep-alive connection reused after the server side closed it
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const once = () => new Promise((res) => {
  const r = http.get({ socketPath: live, path: "/v1/meta", agent }, (m) => { m.resume(); m.on("end", () => res(`status ${m.statusCode}`)); });
  r.on("error", (e) => res(`error ${e.code}`));
});
console.log("keep-alive first      ->", await once());
srv.closeAllConnections();
console.log("keep-alive, same tick ->", await once());
srv.close();
agent.destroy();
