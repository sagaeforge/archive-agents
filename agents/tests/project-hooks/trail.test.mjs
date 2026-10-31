// The Trail wrapper on its own, with a stub Trail and with the real one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { copyRepo, fakeHome, git, hasRealTrail, hookTest as test, restrictedPath, runHook, snapshot, snapshotDiff, tempDir, writeFile } from "./lib/sandbox.mjs";

const context = "trail-context.sh";
const prompt = (text) => ({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: text });
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

test("every Trail call runs with telemetry, fetches, look-back, and its home off", () => {
  const box = setup({ map: false });
  runHook(context, prompt(question), box);
  const env = fs.readFileSync(path.join(box.home, "trail.env"), "utf8").split("\n");
  for (const line of [
    "DO_NOT_TRACK=1",
    "TRAIL_NO_FETCH=1",
    "TRAIL_NO_LOOK_BACK=1",
    "GRAFT_NO_IGNORE=1",
    "TRAIL_HOME=/dev/null/trail",
    "DOTENV_PATH=/dev/null",
    "GIT_CONFIG_COUNT=2",
    "GIT_CONFIG_KEY_0=core.fsmonitor",
    "GIT_CONFIG_VALUE_0=false",
    "GIT_CONFIG_KEY_1=core.hooksPath",
    "GIT_CONFIG_VALUE_1=/dev/null",
  ]) {
    assert.ok(env.includes(line), line);
  }
});

test("the off switch stops the hook before Trail runs", () => {
  const box = setup({ map: false });
  runHook(context, prompt(question), { ...box, env: { TRAIL_NO_HOOKS: "1" } });
  assert.deepEqual(trailCalls(box.home), []);
});

test("a checkout with .trail/ stands the hook down before Trail runs", () => {
  const box = setup({ map: false, reply: answer({ coverageStrong: 1 }) });
  fs.mkdirSync(path.join(box.project, ".trail"));
  const asked = runHook(context, prompt(question), box);
  assert.deepEqual({ rc: asked.rc, stdout: asked.stdout }, { rc: 0, stdout: "" });
  assert.deepEqual(trailCalls(box.home), []);
});

const broken = {
  missing: undefined,
  "exits 2": `#!/bin/sh\nexit 2\n`,
  "dies on a signal": `#!/bin/sh\nkill -SEGV $$\n`,
  "prints garbage": `#!/bin/sh\necho '{"hits": [oops'\n`,
  "prints to stderr only": `#!/bin/sh\necho boom >&2\nexit 1\n`,
};

test("a missing or broken Trail leaves the prompt alone", () => {
  for (const [name, trail] of Object.entries(broken)) {
    for (const map of [true, false]) {
      const box = setup({ trail, map });
      const first = runHook(context, prompt(question), box);
      assert.deepEqual({ rc: first.rc, stdout: first.stdout }, { rc: 0, stdout: "" }, name);
    }
  }
});

test("a hanging Trail is cut off inside the hook's timeout", () => {
  const box = setup({ trail: `#!/bin/sh\nexec sleep 40\n`, map: false });
  const asked = runHook(context, prompt(question), box);
  assert.deepEqual({ rc: asked.rc, stdout: asked.stdout }, { rc: 0, stdout: "" });
  assert.ok(asked.ms < 11500, `prompt hook took ${asked.ms} ms against a 12 s limit`);
});

test("malformed input is ignored", () => {
  const box = setup({ reply: answer({ coverageStrong: 1 }) });
  for (const input of ["", "not json", "{", "[]", "null", "{}", '{"prompt":7}', '{"prompt":null}']) {
    const { rc, stdout } = runHook(context, input, box);
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, input);
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

test("the real Trail gives context and refreshes its map without touching home", realOnly, () => {
  const project = copyRepo(path.join(tempDir("trail-real"), "repo"));
  const home = fakeHome({ trail: "real" });
  const before = snapshot(home);
  const { rc, stdout } = runHook(context, prompt("how does createClient fail over between hosts"), { home, project });
  assert.equal(rc, 0);
  assert.match(stdout, /^\[trail\] code pointers for this prompt:\n- .*createClient.*pve\.mjs:L\d+/);
  writeFile(path.join(project, "plugins/proxmox/server/probe.mjs"), "export function trailRefreshProbe() { return 42; }\n");
  assert.match(runHook(context, prompt("where is trailRefreshProbe defined here"), { home, project }).stdout, /trailRefreshProbe/);
  assert.deepEqual(snapshotDiff(before, snapshot(home)), []);
  assert.equal(fs.existsSync(path.join(project, ".trail")), false);
});

function refreshFixture() {
  const project = path.join(tempDir("trail-refresh"), "repo");
  fs.mkdirSync(project);
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "sandbox@example.invalid");
  git(project, "config", "user.name", "sandbox");
  writeFile(path.join(project, ".gitignore"), "/graft/\n/.graft/\n");
  writeFile(path.join(project, "rootprobe.mjs"), "export function rootLevelProbe() { return 1; }\nexport function rootLevelStays() { return 2; }\n");
  writeFile(path.join(project, "symbolless.mjs"), "// nothing here\n");
  writeFile(path.join(project, "gainssymbols.mjs"), "// nothing here yet\n");
  writeFile(path.join(project, "src/keep.mjs"), "export function keepProbeAlpha() { return 1; }\nexport function keepCaller() { return keepProbeAlpha(); }\n");
  writeFile(path.join(project, "src/gone.mjs"), "export function goneProbeBeta() { return 1; }\n");
  writeFile(path.join(project, "src/moved.mjs"), "export function movedProbeGamma() { return 1; }\n");
  writeFile(path.join(project, "src/same.mjs"), "export function sameLengthAlpha() { return 1; }\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "init");
  return project;
}

const refreshChanges = {
  "a renamed symbol": (project) => writeFile(path.join(project, "src/keep.mjs"), "export function keepProbeOmega() { return 1; }\nexport function keepCaller() { return keepProbeOmega(); }\n"),
  "an edit that keeps the file's size": (project) => writeFile(path.join(project, "src/same.mjs"), "export function sameLengthOmega() { return 1; }\n"),
  "a new file in a new folder": (project) => writeFile(path.join(project, "lib/deep/newfile.mjs"), "export function brandNewDelta() { return 1; }\n"),
  "a deleted file": (project) => fs.rmSync(path.join(project, "src/gone.mjs")),
  "a renamed file": (project) => fs.renameSync(path.join(project, "src/moved.mjs"), path.join(project, "src/renamed.mjs")),
  "a change to a file with a root-level card": (project) => writeFile(path.join(project, "rootprobe.mjs"), "export function rootLevelChanged() { return 1; }\nexport function rootLevelStays() { return 2; }\n"),
  "a deleted file with a root-level card": (project) => fs.rmSync(path.join(project, "symbolless.mjs")),
  // Only a build rewrites this card, so the two paths differ here unless cards stay out.
  "a first symbol in a file with a root-level card": (project) => writeFile(path.join(project, "gainssymbols.mjs"), "export function gainedProbe() { return 1; }\n"),
};

const refreshQuestions = [
  "where is keepProbeOmega defined here",
  "where is keepProbeAlpha defined here",
  "what calls keepProbeOmega in this repo",
  "where is sameLengthOmega defined here",
  "where is sameLengthAlpha defined here",
  "where is brandNewDelta defined here",
  "where is goneProbeBeta defined here",
  "where is movedProbeGamma defined here",
  "where is rootLevelChanged defined here",
  "where is rootLevelProbe defined here",
  "which extracted symbols are in this file",
];

test("a build after each edit changes nothing the prompt hook prints", realOnly, () => {
  const home = fakeHome({ trail: "real" });
  const built = refreshFixture();
  const refreshed = refreshFixture();
  const ask = (project, text) => runHook(context, prompt(text), { home, project }).stdout;
  for (const project of [built, refreshed]) assert.notEqual(ask(project, refreshQuestions[1]), "");
  for (const [name, change] of Object.entries(refreshChanges)) {
    change(built);
    change(refreshed);
    // What the hook after Write and Edit ran before it was removed.
    const asBuilt = likeTheHook(home, built, "build", built);
    assert.equal(asBuilt.status, 0, asBuilt.stderr);
    for (const text of refreshQuestions) assert.equal(ask(refreshed, text), ask(built, text), `${name}: ${text}`);
  }
  assert.match(ask(refreshed, "where is brandNewDelta defined here"), /brandNewDelta · function lib\/deep\/newfile\.mjs:L1/);
  assert.doesNotMatch(ask(refreshed, "where is goneProbeBeta defined here"), /goneProbeBeta/);
  assert.match(ask(refreshed, "what calls keepProbeOmega in this repo"), /keepCaller src\/keep\.mjs:L2/);
});

test("a stale card cannot reach the prompt: only the code map prints", realOnly, () => {
  const home = fakeHome({ trail: "real" });
  const project = refreshFixture();
  const text = "which extracted symbols are in this file";
  runHook(context, prompt(question), { home, project });
  assert.ok(fs.existsSync(path.join(project, "graft/symbolless.md")));
  // The check can fail: Trail itself answers with the card, which is not a code pointer.
  const raw = byHand(home, project, "ask", text, project, "--json");
  assert.ok(JSON.parse(raw.stdout).hits.some((hit) => hit.kind === "concept" && hit.pointer === "symbolless"), raw.stdout);
  assert.equal(runHook(context, prompt(text), { home, project }).stdout, "");
  fs.rmSync(path.join(project, "symbolless.mjs"));
  assert.equal(runHook(context, prompt(text), { home, project }).stdout, "");
});

test("hits that are not code pointers print nothing, not a bare header", () => {
  const concept = { kind: "concept", title: "notes", pointer: "notes" };
  const alone = setup({ reply: JSON.stringify({ hits: [concept], coverage: 1, coverageStrong: 1 }) });
  assert.equal(runHook(context, prompt(question), alone).stdout, "");
  const mixed = setup({ reply: JSON.stringify({ hits: [concept, { kind: "symbol", title: "createClient", pointer: "a.mjs:L1-L2" }], coverageStrong: 1 }) });
  assert.equal(runHook(context, prompt(question), mixed).stdout, "[trail] code pointers for this prompt:\n- createClient a.mjs:L1-L2\n");
});

const lookup = "how does createClient fail over between hosts";
const note = ["note", "--title", "Proxmox client host order", "--anyway", "-m", "createClient in plugins/proxmox/server/pve.mjs tries hosts in order."];

const quietTrail = { DO_NOT_TRACK: "1", TRAIL_NO_FETCH: "1", TRAIL_NO_LOOK_BACK: "1" };

const runTrail = (home, cwd, env, args) =>
  spawnSync(path.join(home, ".local/share/trail-code/0.28.1/node_modules/.bin/trail"), args, {
    cwd,
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH, ...quietTrail, ...env },
  });

// Trail as a person runs it, outside the hooks and without their environment.
const byHand = (home, cwd, ...args) => runTrail(home, cwd, {}, args);

// Trail with the settings trail-env.sh exports.
const likeTheHook = (home, cwd, ...args) => runTrail(home, cwd, { GRAFT_NO_IGNORE: "1", TRAIL_HOME: "/dev/null/trail", DOTENV_PATH: "/dev/null" }, args);

test("a personal note changes nothing the hook does, even in a brand-new worktree", realOnly, () => {
  const dir = tempDir("trail-note");
  const project = copyRepo(path.join(dir, "repo"));
  const home = fakeHome({ trail: "real" });
  const made = byHand(home, project, ...note, "--personal");
  assert.equal(made.status, 0, made.stderr);
  assert.ok(fs.existsSync(path.join(home, ".trail/repos")), "the note went to Trail's home");

  const fresh = path.join(dir, "fresh");
  git(project, "worktree", "add", "-q", "-b", "fresh", fresh);
  const before = snapshot(home);
  const { rc, stdout } = runHook(context, prompt(lookup), { home, project: fresh });
  assert.equal(rc, 0);
  assert.match(stdout, /createClient/);
  assert.deepEqual(snapshotDiff(before, snapshot(home)), []);
  // Trail writes this file just before it starts the detached _trail-branches.
  assert.equal(fs.existsSync(path.join(fresh, "graft/.cache/trail-branches.json")), false);

  // The same lookup without the hook's environment, so these checks can fail.
  const control = path.join(dir, "control");
  git(project, "worktree", "add", "-q", "-b", "control", control);
  assert.equal(byHand(home, control, "build", control).status, 0);
  assert.equal(byHand(home, control, "ask", lookup, control, "--json").status, 0);
  assert.deepEqual(snapshotDiff(before, snapshot(home)), ["changed .trail/repos/known.json"]);
  assert.equal(fs.existsSync(path.join(control, "graft/.cache/trail-branches.json")), true);
});

test("a repo note stands the hooks down, they touch nothing, and removing .trail/ brings them back", realOnly, () => {
  const dir = tempDir("trail-repo-note");
  const project = copyRepo(path.join(dir, "repo"));
  const home = fakeHome({ trail: "real" });
  assert.notEqual(runHook(context, prompt(lookup), { home, project }).stdout, "");
  const made = byHand(home, project, ...note);
  assert.equal(made.status, 0, made.stderr);
  assert.ok(fs.existsSync(path.join(project, ".trail")), "a repo note lives in the checkout");

  const homeBefore = snapshot(home);
  const projectBefore = snapshot(project);
  for (let i = 0; i < 3; i++) {
    const { rc, stdout } = runHook(context, prompt(lookup), { home, project });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" });
  }
  assert.deepEqual(snapshotDiff(homeBefore, snapshot(home)), []);
  assert.deepEqual(snapshotDiff(projectBefore, snapshot(project)), []);

  // .trail/ is ignored by git, so a new worktree has none and the hooks work there.
  const fresh = path.join(dir, "fresh");
  git(project, "worktree", "add", "-q", "-b", "fresh", fresh);
  assert.match(runHook(context, prompt(lookup), { home, project: fresh }).stdout, /createClient/);
  assert.equal(fs.existsSync(path.join(fresh, ".trail")), false);
  assert.equal(fs.existsSync(path.join(fresh, "graft/.cache/trail-branches.json")), false);
  assert.deepEqual(snapshotDiff(homeBefore, snapshot(home)), []);

  fs.rmSync(path.join(project, ".trail"), { recursive: true });
  assert.match(runHook(context, prompt(lookup), { home, project }).stdout, /createClient/);
  assert.deepEqual(snapshotDiff(homeBefore, snapshot(home)), []);
});

// Files a session can write without a shell, each aimed at a git child of Trail.
const monitor = (canary) => `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = touch ${canary}; true\n`;

function plantRepo(dir, canary) {
  writeFile(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(dir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "refs"), { recursive: true });
  writeFile(path.join(dir, "config"), monitor(canary));
}

const gitRoutes = {
  ".env": (project, canary) => writeFile(path.join(project, ".env"), `GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=core.fsmonitor\nGIT_CONFIG_VALUE_0=touch ${canary}; true\n`),
  ".env with git's other config variable": (project, canary) => writeFile(path.join(project, ".env"), `GIT_CONFIG_PARAMETERS="'core.fsmonitor=touch ${canary}; true'"\n`),
  ".git/config": (project, canary) => fs.appendFileSync(path.join(project, ".git/config"), `[core]\n\tfsmonitor = touch ${canary}; true\n`),
  ".git file pointing at a planted repository": (project, canary) => {
    const planted = path.join(project, "scratch/gd");
    plantRepo(planted, canary);
    fs.rmSync(path.join(project, ".git"), { recursive: true });
    writeFile(path.join(project, ".git"), `gitdir: ${planted}\n`);
  },
  "nested repo": (project, canary) => {
    plantRepo(path.join(project, "scratch/nested/.git"), canary);
    writeFile(path.join(project, ".graft/config.json"), `{"followNestedRepos":true}\n`);
  },
};

for (const [route, plant] of Object.entries(gitRoutes)) {
  test(`${route}: a project file cannot run a command through Trail's git`, realOnly, () => {
    const dir = tempDir("trail-route");
    const project = copyRepo(path.join(dir, "repo"));
    const home = fakeHome({ trail: "real" });
    const canary = path.join(dir, "fired");
    plant(project, canary);

    // The check can fail: Trail as a person runs it does fire the command.
    assert.equal(byHand(home, project, "build", project).status, 0);
    assert.equal(fs.existsSync(canary), true, "the route must work without the hook's environment");
    fs.rmSync(canary);
    fs.rmSync(path.join(project, "graft"), { recursive: true, force: true });

    const asked = runHook(context, prompt(lookup), { home, project });
    assert.deepEqual({ rc: asked.rc, fired: fs.existsSync(canary) }, { rc: 0, fired: false });
    assert.match(asked.stdout, /createClient/, "the map still builds and answers");
  });
}

test("a project .env cannot move Trail's output into a global folder", realOnly, () => {
  const dir = tempDir("trail-graft-dir");
  const project = copyRepo(path.join(dir, "repo"));
  const home = fakeHome({ trail: "real" });
  fs.mkdirSync(path.join(home, ".claude"));
  writeFile(path.join(project, ".env"), `GRAFT_DIR=${home}/.claude/planted\n`);

  const before = snapshot(home);
  assert.match(runHook(context, prompt(lookup), { home, project }).stdout, /createClient/);
  assert.deepEqual(snapshotDiff(before, snapshot(home)), []);
  assert.ok(fs.existsSync(path.join(project, "graft/.graph/wiring.json")), "the map stays in the project");

  // The check can fail: Trail as a person runs it writes into the fake ~/.claude.
  assert.equal(byHand(home, project, "build", project).status, 0);
  assert.ok(fs.existsSync(path.join(home, ".claude/planted")), "the route must work without the hook's environment");
});

test("real Trail stays quiet on a Korean prompt with no code terms", realOnly, () => {
  const project = copyRepo(path.join(tempDir("trail-ko"), "repo"));
  const home = fakeHome({ trail: "real" });
  const { rc, stdout } = runHook(context, prompt("읽기 전용 토큰이 어떻게 동작하는지 설명해 주세요"), { home, project });
  assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" });
});
