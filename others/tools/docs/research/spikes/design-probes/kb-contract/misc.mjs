import http from "node:http";
try { http.request({ socketPath: "/nonexistent", path: "/kb/v1/nodes/e%3Atopic%2F한글" }); console.log("accepted"); }
catch (e) { console.log("non-ASCII path:", e.code); }
const u = new URL("unix:/home/user/sagae-kb-data/run/read.sock");
console.log("unix: URL parses:", u.protocol, u.pathname);
