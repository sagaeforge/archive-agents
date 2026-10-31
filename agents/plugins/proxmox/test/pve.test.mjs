import assert from "node:assert/strict";
import { test } from "node:test";
import { PveApiError, buildPath, createClient, loadToken } from "../server/pve.mjs";

const ok = (data) => ({ status: 200, reason: "OK", body: JSON.stringify({ data }) });
const client = (transport) => createClient({ hosts: ["a", "b"], getToken: () => "t", transport });

test("buildPath rejects traversal and relative paths", () => {
  assert.throws(() => buildPath("/nodes/../access"));
  assert.throws(() => buildPath("nodes"));
});

test("buildPath encodes params and drops undefined", () => {
  assert.equal(buildPath("/x", { type: "vm", skip: undefined }), "/x?type=vm");
  assert.equal(buildPath("/x", { q: "a b&c" }), "/x?q=a+b%26c");
});

test("get unwraps the data envelope", async () => {
  assert.deepEqual(await client(async () => ok([1])).get("/version"), [1]);
});

test("get fails over and then sticks to the working host", async () => {
  const calls = [];
  const c = client(async (host) => {
    calls.push(host);
    if (host === "a") throw new Error("down");
    return ok(host);
  });
  assert.equal(await c.get("/x"), "b");
  assert.equal(await c.get("/x"), "b");
  assert.deepEqual(calls, ["a", "b", "b"]);
});

test("HTTP errors surface without trying other hosts", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return { status: 403, reason: "Permission check failed", body: "" };
  });
  await assert.rejects(c.get("/x"), (e) => e instanceof PveApiError && e.status === 403);
  assert.equal(calls, 1);
});

test("get reports every host when all are unreachable", async () => {
  const c = client(async (host) => {
    throw new Error(`${host} down`);
  });
  await assert.rejects(c.get("/x"), /a: a down; b: b down/);
});

test("loadToken prefers env and explains a missing file", () => {
  assert.equal(loadToken({ PVE_API_TOKEN: " x\n" }), "x");
  assert.throws(() => loadToken({ PVE_TOKEN_FILE: "/nonexistent" }), /bootstrap-token/);
});
