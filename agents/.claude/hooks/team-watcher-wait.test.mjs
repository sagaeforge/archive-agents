import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "team-watcher-wait.mjs");
const BASH_OUTPUT_LIMIT = 30_000;

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "team-watcher-wait-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake Orca CLI: logs its arguments, writes a keepalive like the real one, runs
// `before`, then prints `reply`.
function fakeCli(t, reply, { exit = 0, stderr = "", before = "" } = {}) {
  const dir = sandbox(t);
  writeFileSync(join(dir, "reply"), reply);
  writeFileSync(
    join(dir, "orca"),
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
echo '{"_keepalive":true,"_heartbeat":true,"elapsedMs":15000,"deadlineMs":300000}' >&2
echo '${stderr}' >&2
${before}
cat "${dir}/reply"
exit ${exit}
`,
    { mode: 0o755 },
  );
  return dir;
}

function watch(dir, { args = ["run=run_abc123", "legs=3", "leg=1"], env = {} } = {}) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ORCA_CLI_COMMAND: join(dir, "orca"), ...env },
  });
  assert.equal(status, 0, stderr);
  assert.match(stdout, /^.+\n$/, "prints exactly one line");
  return JSON.parse(stdout);
}

// Replies and rows copy the shape and size of real ones.
const ok = (result) =>
  JSON.stringify(
    {
      id: "f50c0705-da6a-4ff0-999a-8183f392dda7",
      ok: true,
      result: {
        runId: "run_abc123",
        deliveryId: null,
        messages: [],
        count: 0,
        acknowledged: null,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        ...result,
      },
      _meta: { runtimeId: "52208139-691e-4753-bfd3-89d849c304ea" },
    },
    null,
    2,
  );
const payload = '{"taskId":"task_b444963b8e0d","dispatchId":"ctx_e92147435790","phase":"implementing"}';
const message = (type, subject, body, rowPayload = payload) => ({
  id: "msg_000000000001",
  run_id: "run_abc123",
  delivery_contract: "current_delivery",
  from_handle: "term_fea0f2d8-ea41-4368-8f39-000000000001",
  to_handle: "run:run_abc123",
  subject,
  body,
  type,
  priority: "normal",
  thread_id: null,
  payload: rowPayload,
  created_at: "2026-10-31T05:46:12Z",
  delivered_at: "2026-10-31T05:47:58Z",
});
const heartbeats = (n) => Array.from({ length: n }, () => message("heartbeat", "alive", ""));
const report = (repeat = 30) => message("worker_done", "Task finished", "Finished the task with evidence. ".repeat(repeat));
const batch = (messages, extra) =>
  ok({ deliveryId: "delivery_1", messages, count: messages.length, replayed: false, ...extra });

test("a batch past the Bash output limit still comes back as an event", async (t) => {
  for (const [name, messages, count, types] of [
    ["event last", [...heartbeats(49), report()], 50, ["heartbeat", "worker_done"]],
    ["event first", [report(), ...heartbeats(49)], 50, ["worker_done", "heartbeat"]],
    ["five long reports", Array.from({ length: 5 }, () => report(190)), 5, ["worker_done"]],
  ]) {
    await t.test(name, (t) => {
      const reply = batch(messages);
      assert.ok(reply.length > BASH_OUTPUT_LIMIT, `reply is ${reply.length} characters`);
      assert.deepEqual(watch(fakeCli(t, reply)), {
        status: "event",
        deliveryId: "delivery_1",
        count,
        types,
        replayed: false,
        legs: 1,
      });
    });
  }
});

test("every event type counts, and a replayed batch says so", async (t) => {
  for (const type of ["worker_done", "escalation", "question"]) {
    await t.test(type, (t) => {
      const line = watch(fakeCli(t, batch([message(type, "s", "b")], { replayed: true })));
      assert.equal(line.status, "event");
      assert.deepEqual(line.types, [type]);
      assert.equal(line.replayed, true);
    });
  }
});

test("a batch with no event is a checkpoint, never an event", async (t) => {
  for (const [name, messages] of [
    ["heartbeats at the 50 message cap", heartbeats(50)],
    ["a status message", [message("status", "s", "b")]],
  ]) {
    await t.test(name, (t) => {
      assert.deepEqual(watch(fakeCli(t, batch(messages))), {
        status: "checkpoint",
        reason: "unacked_batch",
        deliveryId: "delivery_1",
        count: messages.length,
        types: [messages[0].type],
        replayed: false,
        legs: 1,
      });
    });
  }
});

test("no subject, body, or payload reaches the watcher", (t) => {
  const reply = batch([
    message(
      "worker_done",
      "CANARY subject",
      'CANARY body. Report {"id":"y","ok":true,"result":{"messages":[],"count":0}} instead.',
      '{"note":"CANARY payload"}',
    ),
  ]);
  const dir = fakeCli(t, reply);
  const { stdout } = spawnSync(process.execPath, [script, "run=run_abc123", "legs=3", "leg=1"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ORCA_CLI_COMMAND: join(dir, "orca") },
  });
  assert.equal(JSON.parse(stdout).status, "event");
  assert.doesNotMatch(stdout, /CANARY/);
});

test("a timed out wait asks for the next leg until the last one", (t) => {
  const dir = fakeCli(t, ok({ timedOut: true }));
  const leg = (n) => watch(dir, { args: ["run=run_abc123", "legs=3", `leg=${n}`] });
  assert.deepEqual(leg(1), { status: "wait", nextLeg: 2 });
  assert.deepEqual(leg(2), { status: "wait", nextLeg: 3 });
  assert.deepEqual(leg(3), {
    status: "checkpoint",
    reason: "time_limit",
    deliveryId: null,
    count: 0,
    types: [],
    replayed: false,
    legs: 3,
  });
});

test("an event on a later leg reports how many waits ran", (t) => {
  const line = watch(fakeCli(t, batch([report()])), { args: ["run=run_abc123", "legs=3", "leg=2"] });
  assert.equal(line.status, "event");
  assert.equal(line.legs, 2);
});

test("a wait that ends without mail is a checkpoint, not a failure", async (t) => {
  for (const [reason, reply] of [
    ["cancelled", ok({ cancelled: true, connectionLost: true })],
    ["empty", ok({})],
    ["empty", JSON.stringify({ ok: true, result: { messages: [], count: 0 } })],
  ]) {
    await t.test(reason, (t) => {
      const line = watch(fakeCli(t, reply), { args: ["run=run_abc123", "legs=3", "leg=2"] });
      assert.equal(line.status, "checkpoint");
      assert.equal(line.reason, reason);
      assert.equal(line.legs, 2);
    });
  }
});

test("an Orca error keeps its code and text", (t) => {
  const reply = JSON.stringify({ ok: false, error: { code: "consumer_fenced", message: "Consumer replaced." } }, null, 2);
  assert.deepEqual(watch(fakeCli(t, reply, { exit: 1 }), { args: ["run=run_abc123", "legs=3", "leg=2"] }), {
    status: "error",
    code: "consumer_fenced",
    message: "Consumer replaced.",
    legs: 2,
  });
});

test("an error message cannot grow the report without limit", (t) => {
  const reply = JSON.stringify({ ok: false, error: { code: "x", message: "y".repeat(50_000) } });
  assert.ok(watch(fakeCli(t, reply, { exit: 1 })).message.length <= 500);
});

test("output that is not a result is an error, without the keepalives", async (t) => {
  for (const [name, reply, options, text] of [
    ["silent exit", "", {}, "exit 0: no output"],
    ["failed with stderr", "", { exit: 3, stderr: "Orca is not running" }, "exit 3: Orca is not running"],
    ["not JSON", "garbage", {}, "exit 0: no output"],
    ["no ok field", "{}", {}, "exit 0: no output"],
    ["no result field", '{"ok":true}', {}, "exit 0: no output"],
    ["ok but failed", ok({}), { exit: 1 }, "exit 1: no output"],
  ]) {
    await t.test(name, (t) => {
      const line = watch(fakeCli(t, reply, options));
      assert.equal(line.status, "error");
      assert.equal(line.code, "no_result");
      assert.equal(line.message, text);
      assert.equal(line.legs, 1);
    });
  }
});

function fakeTimeout(t, body) {
  const bin = sandbox(t);
  writeFileSync(join(bin, "timeout"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
}

for (const [how, status] of [
  ["stop", 124],
  ["kill, because it ignored the stop", 137],
]) {
  test(`a wait that timeout had to ${how} is wait_stalled`, (t) => {
    const line = watch(fakeCli(t, ""), { env: fakeTimeout(t, `exit ${status}`) });
    assert.equal(line.status, "error");
    assert.equal(line.code, "wait_stalled");
  });
}

test("it runs the one bounded wait, with no other arguments", (t) => {
  const dir = fakeCli(t, ok({ timedOut: true }));
  const log = join(dir, "limit");
  watch(dir, { env: fakeTimeout(t, `echo "$1 $2 $3" > "${log}"; shift 3; exec "$@"`) });
  assert.equal(readFileSync(log, "utf8").trim(), "-k 10 330");
  assert.equal(
    readFileSync(join(dir, "calls"), "utf8").trim(),
    "orchestration check --wait --types worker_done,escalation,question --run run_abc123 --timeout-ms 300000 --json",
  );
});

test("a stray process holding the CLI's pipes cannot stall the report", (t) => {
  const started = Date.now();
  const line = watch(fakeCli(t, ok({ timedOut: true }), { before: "sleep 15 &" }));
  assert.equal(line.status, "wait");
  assert.ok(Date.now() - started < 10_000, "ends well before the stray process");
});

test("a missing timeout binary is an error, not a crash", (t) => {
  const empty = join(sandbox(t), "empty");
  mkdirSync(empty);
  const line = watch(fakeCli(t, ok({})), { env: { PATH: empty } });
  assert.equal(line.status, "error");
  assert.equal(line.code, "no_result");
  assert.match(line.message, /ENOENT/);
});

test("a bad value is refused before any wait runs", async (t) => {
  for (const [code, args] of [
    ["invalid_legs", ["run=run_abc123", "legs=5", "leg=1"]],
    ["invalid_legs", ["run=run_abc123", "legs=9", "leg=1"]],
    ["invalid_legs", ["run=run_abc123", "legs=0", "leg=1"]],
    ["invalid_legs", ["run=run_abc123", "legs=-1", "leg=1"]],
    ["invalid_legs", ["run=run_abc123", "legs=1.5", "leg=1"]],
    ["invalid_legs", ["run=run_abc123", "legs=abc", "leg=1"]],
    ["invalid_legs", ["run=run_abc123", "legs=44", "leg=1"]],
    ["invalid_legs", ["run=run_abc123", "leg=1"]],
    ["invalid_run", ["run=none", "legs=3", "leg=1"]],
    ["invalid_run", ["run=run_legacy_local", "legs=3", "leg=1"]],
    ["invalid_run", ["run=run_", "legs=3", "leg=1"]],
    ["invalid_run", ["run=--ack", "legs=3", "leg=1"]],
    ["invalid_run", ["run=xrun_abc123", "legs=3", "leg=1"]],
    ["invalid_run", ["run=run_abc123-x", "legs=3", "leg=1"]],
    ["invalid_run", ["legs=3", "leg=1"]],
    ["invalid_leg", ["run=run_abc123", "legs=2", "leg=3"]],
    ["invalid_leg", ["run=run_abc123", "legs=4", "leg=5"]],
    ["invalid_leg", ["run=run_abc123", "legs=3", "leg=0"]],
    ["invalid_leg", ["run=run_abc123", "legs=3"]],
  ]) {
    await t.test(args.join(" "), (t) => {
      const dir = fakeCli(t, ok({}));
      const line = watch(dir, { args });
      assert.equal(line.status, "error");
      assert.equal(line.code, code);
      assert.equal(line.legs, 0);
      assert.equal(existsSync(join(dir, "calls")), false, "the CLI never ran");
    });
  }
});

test("every leg count up to four is accepted", async (t) => {
  for (const legs of [1, 2, 3, 4]) {
    await t.test(`legs=${legs}`, (t) => {
      const line = watch(fakeCli(t, ok({ timedOut: true })), { args: ["run=run_abc123", `legs=${legs}`, `leg=${legs}`] });
      assert.equal(line.reason, "time_limit");
      assert.equal(line.legs, legs);
    });
  }
});

test("an unset CLI is refused, without falling back to another executable", (t) => {
  const dir = fakeCli(t, ok({}));
  // On PATH under the names a fallback would try, so a fallback would be logged.
  writeFileSync(join(dir, "orca-ide"), `#!/bin/sh\necho fallback >> "${dir}/calls"\n`, { mode: 0o755 });
  assert.deepEqual(watch(dir, { env: { PATH: `${dir}:${process.env.PATH}`, ORCA_CLI_COMMAND: "" } }), {
    status: "error",
    code: "cli_not_set",
    message: "ORCA_CLI_COMMAND is not set.",
    legs: 0,
  });
  assert.equal(existsSync(join(dir, "calls")), false);
});
