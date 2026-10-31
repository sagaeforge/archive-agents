// Read-only import from the repo's node_modules. Nothing is written there.
const { Hono } = await import("/home/user/sagae-tools/node_modules/hono/dist/index.js");
const pkg = JSON.parse((await import("node:fs")).readFileSync("/home/user/sagae-tools/node_modules/hono/package.json", "utf8"));
console.log("hono", pkg.version);
const app = new Hono();
const r = (name) => (c) => c.json({ h: name, id: c.req.param("id") });
app.get("/v1/nodes/:id/neighbors", r("neighbors"));
app.get("/v1/nodes/:id/history", r("history"));
app.get("/v1/nodes/:id", r("node"));
app.get("/kb/*", (c) => c.json({ path: c.req.path, rawUrl: c.req.raw.url }));
const show = async (u) => console.log(u.padEnd(52), await (await app.request(u)).text());
await show("/v1/nodes/e%3Afeature%2Fhooks");
await show("/v1/nodes/e%3Aconcept%2Fhistory");
await show("/v1/nodes/e%3Aconcept%2Fneighbors");
await show("/kb/v1/nodes/e%3Afeature%2Fhooks?as_of_valid=2026-01-01T00%3A00%3A00Z");
await show("/kb/v1/nodes/e%3Atopic%2F%ED%95%9C%EA%B8%80");
await show("/kb/v1/search?q=%ED%95%9C%EA%B8%80");
