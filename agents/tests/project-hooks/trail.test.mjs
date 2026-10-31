// The two Trail wrappers on their own, with a stub Trail and with the real one.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { copyRepo, fakeHome, hasRealTrail, restrictedPath, runHook, snapshot, snapshotDiff, tempDir, writeFile } from "./lib/sandbox.mjs";

const context = "trail-context.sh";
const sync = "trail-sync.sh";
const prompt = (text) => ({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: text });
const edit = (file, tool = "Edit") => ({ session_id: "s", hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: file } });
const question = "where is createClient defined in the plugin";

// Logs each call and its environment, keeps stdin, and answers from a file.
const stubTrail = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/trail.log"
env | sort >> "$HOME/trail.env"
case "$1" in
  ask) cat > "$HOME/trail.stdin"; cat "$HOME/trail.answer" 2>/dev/null ;;
  build) mkdir -p "$2/graft/.graph" && : > "$2/graft/.graph/wiring.json" ;;
esac
`;

const answer = (fields) =>
  JSON.stringify({
    hits: [
      { title: "createClient", pointer: "plugins/proxmox/server/pve.mjs:L67-L93" },
      { title: "loadToken", pointer: "plugins/proxmox/server/pve.mjs:L10-L20" },
    ],
    ...fields,
  });

function setup({ trail = stubTrail, map = true, reply } = {}) {
  const home = fakeHome({ trail });
  const project = tempDir("project");
  if (map) writeFile(path.join(project, "graft/.graph/wiring.json"), "{}");
  if (reply) fs.writeFileSync(path.join(home, "trail.answer"), reply);
  return { home, project };
}

const trailCalls = (home) => {
  const log = path.join(home, "trail.log");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trimEnd().split("\n") : [];
};

const realOnly = { skip: hasRealTrail() ? false : "Trail-Code 0.28.1 is not installed" };

test("a strong match prints code pointers", () => {
  const box = setup({ reply: answer({ coverageStrong: 0.5, coverage: 0.2 }) });
  const { rc, stdout } = runHook(context, prompt(question), box);
  assert.equal(rc, 0);
  assert.equal(
    stdout,
    "[trail] code pointers for this prompt:\n" +
      "- createClient plugins/proxmox/server/pve.mjs:L67-L93\n" +
      "- loadToken plugins/proxmox/server/pve.mjs:L10-L20\n",
  );
  assert.deepEqual(trailCalls(box.home), [`ask - ${box.project} --json -n 3`]);
});

test("the relevance gate matches Trail's own", () => {
  for (const [fields, shown] of [
    [{ coverageStrong: 0.1, coverage: 0 }, true],
    [{ coverageStrong: 0, coverage: 0.5 }, true],
    [{}, true],
    [{ coverageStrong: 0.09, coverage: 0.49 }, false],
    [{ coverageStrong: 0 }, false],
    [{ coverage: 0.1 }, false],
  ]) {
    const box = setup({ reply: answer(fields) });
    assert.equal(runHook(context, prompt(question), box).stdout !== "", shown, JSON.stringify(fields));
  }
  const empty = setup({ reply: '{"hits":[],"coverageStrong":1}' });
  assert.equal(runHook(context, prompt(question), empty).stdout, "");
});

test("short prompts and background notices never reach Trail", () => {
  const box = setup({ reply: answer({ coverageStrong: 1 }) });
  for (const text of ["", "yes", "go ahead", "12 chars ok", "<task-notification>x</task-notification> more words", "  \n<task-notification>x</task-notification> more words"]) {
    assert.equal(runHook(context, prompt(text), box).stdout, "", text);
  }
  assert.deepEqual(trailCalls(box.home), []);
});

test("a fresh checkout builds its map once, before the first answer", () => {
  const box = setup({ map: false, reply: answer({ coverageStrong: 1 }) });
  assert.notEqual(runHook(context, prompt(question), box).stdout, "");
  runHook(context, prompt(question), box);
  assert.deepEqual(trailCalls(box.home), [
    `build ${box.project}`,
    `ask - ${box.project} --json -n 3`,
    `ask - ${box.project} --json -n 3`,
  ]);
});

test("a crafted prompt stays data", () => {
  const box = setup({ reply: answer({ coverageStrong: 1 }) });
  const pwn = path.join(box.project, "pwned");
  for (const text of [
    `$(touch ${pwn}) padding padding`,
    `\`touch ${pwn}\` padding padding`,
    `'; touch ${pwn}; echo ' padding`,
    `"; touch ${pwn}; echo " padding`,
    `-rf --help padding padding ${pwn}`,
    `line one padding\ntouch ${pwn}\n`,
  ]) {
    assert.equal(runHook(context, prompt(text), box).rc, 0, text);
    assert.equal(fs.existsSync(pwn), false, text);
    assert.equal(fs.readFileSync(path.join(box.home, "trail.stdin"), "utf8"), text.replace(/\n+$/, ""));
    for (const call of trailCalls(box.home)) assert.equal(call, `ask - ${box.project} --json -n 3`);
  }
});

test("every Trail call runs with telemetry, fetches, and look-back off", () => {
  const box = setup({ map: false });
  runHook(context, prompt(question), box);
  const env = fs.readFileSync(path.join(box.home, "trail.env"), "utf8").split("\n");
  for (const line of ["DO_NOT_TRACK=1", "TRAIL_NO_FETCH=1", "TRAIL_NO_LOOK_BACK=1", "GRAFT_NO_IGNORE=1"]) {
    assert.ok(env.includes(line), line);
  }
});

test("the off switch stops both hooks before Trail runs", () => {
  const box = setup({ map: false });
  const env = { TRAIL_NO_HOOKS: "1" };
  runHook(context, prompt(question), { ...box, env });
  runHook(sync, edit(path.join(box.project, "a.mjs")), { ...box, env });
  assert.deepEqual(trailCalls(box.home), []);
});

const broken = {
  missing: undefined,
  "exits 2": `#!/bin/sh\nexit 2\n`,
  "dies on a signal": `#!/bin/sh\nkill -SEGV $$\n`,
  "prints garbage": `#!/bin/sh\necho '{"hits": [oops'\n`,
  "prints to stderr only": `#!/bin/sh\necho boom >&2\nexit 1\n`,
};

test("a missing or broken Trail leaves the prompt and the edit alone", () => {
  for (const [name, trail] of Object.entries(broken)) {
    for (const map of [true, false]) {
      const box = setup({ trail, map });
      const first = runHook(context, prompt(question), box);
      assert.deepEqual({ rc: first.rc, stdout: first.stdout }, { rc: 0, stdout: "" }, name);
      const second = runHook(sync, edit(path.join(box.project, "a.mjs")), box);
      assert.deepEqual({ rc: second.rc, stdout: second.stdout }, { rc: 0, stdout: "" }, name);
    }
  }
});

test("a hanging Trail is cut off inside each hook's timeout", () => {
  const box = setup({ trail: `#!/bin/sh\nexec sleep 40\n`, map: false });
  const asked = runHook(context, prompt(question), box);
  assert.deepEqual({ rc: asked.rc, stdout: asked.stdout }, { rc: 0, stdout: "" });
  assert.ok(asked.ms < 11500, `prompt hook took ${asked.ms} ms against a 12 s limit`);
  const synced = runHook(sync, edit(path.join(box.project, "a.mjs")), box);
  assert.equal(synced.rc, 0);
  assert.ok(synced.ms < 14000, `sync hook took ${synced.ms} ms against a 15 s limit`);
});

test("malformed input is ignored", () => {
  const box = setup({ reply: answer({ coverageStrong: 1 }) });
  for (const input of ["", "not json", "{", "[]", "null", "{}", '{"prompt":7}', '{"prompt":null}', '{"tool_input":null}', '{"tool_input":{"file_path":7}}']) {
    for (const script of [context, sync]) {
      const { rc, stdout } = runHook(script, input, box);
      assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, `${script}: ${input}`);
    }
  }
  assert.deepEqual(trailCalls(box.home), []);
});

test("a machine without jq, timeout, or a project directory does nothing", () => {
  const box = setup({ reply: answer({ coverageStrong: 1 }) });
  const tools = ["cat", "dirname", "sh"];
  for (const present of [[...tools, "timeout"], [...tools, "jq"]]) {
    const { rc, stdout } = runHook(context, prompt(question), { ...box, pathValue: restrictedPath(present) });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, present.join(" "));
  }
  const noProject = runHook(context, prompt(question), { home: box.home });
  assert.deepEqual({ rc: noProject.rc, stdout: noProject.stdout }, { rc: 0, stdout: "" });
  assert.deepEqual(trailCalls(box.home), []);
});

test("sync rebuilds for files in the project and for nothing else", () => {
  const box = setup();
  const inside = path.join(box.project, "plugins/a.mjs");
  for (const tool of ["Write", "Edit", "MultiEdit"]) runHook(sync, edit(inside, tool), box);
  assert.deepEqual(trailCalls(box.home), Array(3).fill(`build ${box.project}`));
  for (const file of [
    path.join(box.project, ".claude/worktrees/agent-1/a.mjs"),
    `${box.project}-sibling/a.mjs`,
    "/etc/hosts",
    "relative.mjs",
    "",
  ]) {
    runHook(sync, edit(file), box);
  }
  assert.equal(trailCalls(box.home).length, 3);
});

test("the real Trail gives context and a fresh map without touching home", realOnly, () => {
  const project = copyRepo(path.join(tempDir("trail-real"), "repo"));
  const home = fakeHome({ trail: "real" });
  const before = snapshot(home);
  const { rc, stdout } = runHook(context, prompt("how does createClient fail over between hosts"), { home, project });
  assert.equal(rc, 0);
  assert.match(stdout, /^\[trail\] code pointers for this prompt:\n- .*createClient.*pve\.mjs:L\d+/);
  writeFile(path.join(project, "plugins/proxmox/server/probe.mjs"), "export function trailSyncProbe() { return 42; }\n");
  assert.equal(runHook(sync, edit(path.join(project, "plugins/proxmox/server/probe.mjs")), { home, project }).rc, 0);
  assert.match(runHook(context, prompt("where is trailSyncProbe defined here"), { home, project }).stdout, /trailSyncProbe/);
  assert.deepEqual(snapshotDiff(before, snapshot(home)), []);
  assert.equal(fs.existsSync(path.join(project, ".trail")), false);
});

test("real Trail stays quiet on a Korean prompt with no code terms", realOnly, () => {
  const project = copyRepo(path.join(tempDir("trail-ko"), "repo"));
  const home = fakeHome({ trail: "real" });
  const { rc, stdout } = runHook(context, prompt("읽기 전용 토큰이 어떻게 동작하는지 설명해 주세요"), { home, project });
  assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" });
});
