import http from "node:http";
const sock = process.argv[2];
const paths = [
  "/v1/nodes/c-8k2p4q7m1xab",
  "/v1/nodes/e%3Afeature%2Fhooks",
  "/v1/nodes/e%3Afeature%2Fhooks/neighbors",
  "/v1/nodes/e%3Aconcept%2Fhistory",
  "/v1/nodes/e%3Aconcept%2Fneighbors",
];
const get = (path, headers) => new Promise((res) => {
  const r = http.get({ socketPath: sock, path, headers, agent: false }, (m) => {
    let b = ""; m.on("data", (d) => (b += d)); m.on("end", () => res(`${m.statusCode} ${m.headers["content-type"] ?? ""} ${b.slice(0, 80)}`));
  });
  r.on("error", (e) => res(`ERR ${e.code}`));
});
for (const p of paths) console.log(p.padEnd(44), await get(p));
console.log("Host default (node)     ", await get("/v1/nodes/c-1"));
console.log("Host 127.0.0.1:4812     ", await get("/v1/nodes/c-1", { Host: "127.0.0.1:4812" }));
console.log("Host localhost:4800     ", await get("/v1/nodes/c-1", { Host: "localhost:4800" }));
console.log("Host evil.example       ", await get("/v1/nodes/c-1", { Host: "evil.example" }));
