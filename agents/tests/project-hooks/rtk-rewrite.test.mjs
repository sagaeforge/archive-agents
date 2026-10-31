// The rtk wrapper on its own: what it rewrites, what it leaves raw, and how it fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakeHome, git, hasRealRtk, restrictedPath, runHook, tempDir, writeFile } from "./lib/sandbox.mjs";

const hook = "rtk-rewrite.sh";
const shells = ["sh", "bash", "dash"].filter((shell) => spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0);

// The hook acts only at the project root, so a call starts there unless a test moves it.
const project = tempDir("rtk-project");

const call = (command, extra = {}) => ({
  session_id: "session",
  cwd: project,
  permission_mode: "bypassPermissions",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command, description: "a test call" },
  tool_use_id: "toolu_1",
  ...extra,
});

const fire = (input, options) => runHook(hook, input, { project, ...options });

// Answers like rtk 1.1.0 for the two calls the wrapper makes.
const gates = `[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }
[ "$1" = hook ] && exec jq -c '{hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: (.tool_input + {command: ("rtk " + .tool_input.command)})}}'
`;

// The same, and logs each call.
const stubRtk = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/rtk.log"
${gates}`;

const rtkCalls = (home) => {
  const log = path.join(home, "rtk.log");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
};

const realOnly = { skip: hasRealRtk() ? false : "rtk is not installed" };

const quiet = "RTK_DB_PATH=/dev/null RTK_RECALL=0 RTK_SUPPRESS_HOOK_WARNING=1 RTK_TELEMETRY_DISABLED=1";
const expected = (home) => `${quiet} timeout -k 1 5 ${home}/.local/bin/rtk git status || git status`;

test("a plain git status becomes an rtk call with the original as its fallback", () => {
  for (const shell of shells) {
    const home = fakeHome({ rtk: stubRtk });
    const { rc, stdout } = fire(call("git status"), { home, shell });
    assert.equal(rc, 0);
    const output = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(output.updatedInput.command, expected(home));
    assert.equal(output.hookEventName, "PreToolUse");
  }
});

test("a rewrite changes only the command and grants nothing", () => {
  const home = fakeHome({ rtk: stubRtk });
  const input = call("git status");
  input.tool_input = { command: "git status", description: "d", timeout: 5000, run_in_background: true };
  const output = JSON.parse(fire(input, { home }).stdout).hookSpecificOutput;
  const { command, ...rest } = output.updatedInput;
  assert.deepEqual(rest, { description: "d", timeout: 5000, run_in_background: true });
  assert.equal(output.permissionDecision, undefined);
  assert.match(output.additionalContext, /RTK_DISABLED=1 git status/);
});

test("everything else stays raw, starting with what reviewers need in full", () => {
  const home = fakeHome({ rtk: stubRtk });
  const tooLong = Array(495).fill("/dev/null").join(" ");
  for (const command of [
    // Named by the acceptance criteria.
    "orca-ide status",
    "$ORCA_CLI_COMMAND status",
    "gh pr view 1 --json title",
    "gh api repos/a/b --jq .name",
    "claude plugin validate .",
    "claude plugin validate plugins/proxmox",
    "npm test",
    "(cd plugins/proxmox && npm test)",
    "git diff",
    "git diff --stat",
    "git diff HEAD~1",
    "git rev-parse HEAD",
    "git ls-files",
    "git cat-file -p HEAD",
    "git merge-base main HEAD",
    "git for-each-ref",
    "git log",
    "git log -1",
    "git show HEAD",
    "git branch",
    "git worktree list",
    // Mutating or networked.
    "git push origin main",
    "git commit -m x",
    "git status && git push",
    "curl -s https://example.com",
    "ssh host true",
    "npx vitest",
    // Lossy in rtk, or with no saving.
    "ls",
    "ls -la",
    "tree",
    "find .",
    "cat README.md",
    "head -5 README.md",
    "wc -l README.md",
    // git status forms whose output scripts parse.
    "git status --porcelain",
    "git status -s",
    "git status src",
    `git status ${tooLong}`,
    // Searches, in every shape rtk mishandled. See the comment in the hook.
    "grep -rn createClient plugins",
    "grep -rn createClient .",
    "grep -n needle a.txt b.txt",
    "grep -i 'two words' README.md",
    'grep -rn "two words" plugins',
    "grep -rn createClient *",
    "grep -rn createClient ./*",
    "grep -rn createClient plugins/*",
    "grep -n createClient {README.md,CLAUDE.md}",
    `grep -n API_TOKEN .env ${tooLong}`,
    "grep -c needle a.txt",
    "grep --include=x -r needle .",
    "rg createClient",
    "rg -n 'two words' plugins",
    "rg createClient plugins/*",
    `rg API_TOKEN .env ${tooLong}`,
    "rg --pre cat needle",
    // Raw escape hatches.
    "RTK_DISABLED=1 grep -rn needle .",
    "RTK_DISABLED=1 git status",
    "command git status",
    "/usr/bin/git status",
    "\\git status",
    "git status | cat",
    "git status > out.txt",
    // Near misses.
    " git status",
    "git status ",
    "git  status",
    "git status\n",
    "git status;",
    "gitstatus",
    "git",
  ]) {
    const { rc, stdout, stderr } = fire(call(command), { home });
    assert.deepEqual({ rc, stdout, stderr }, { rc: 0, stdout: "", stderr: "" }, command);
  }
  assert.equal(rtkCalls(home), "", "rtk must not even be consulted for these");
});

test("rewriting happens only under bypassPermissions", () => {
  const home = fakeHome({ rtk: stubRtk });
  for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk", "", undefined]) {
    const { rc, stdout } = fire(call("git status", { permission_mode: mode }), { home });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, String(mode));
  }
  assert.equal(fire(call("git status", { tool_name: "Monitor" }), { home }).stdout, "");
});

test("rewriting happens only at the project root", () => {
  const home = fakeHome({ rtk: stubRtk });
  for (const cwd of [
    path.join(project, "plugins/proxmox"),
    path.join(project, ".claude/worktrees/agent-1"),
    `${project}-sibling`,
    `${project}/`,
    "/tmp",
    "",
    undefined,
  ]) {
    const { rc, stdout } = fire(call("git status", { cwd }), { home });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, String(cwd));
  }
  const noProject = runHook(hook, call("git status"), { home, cwd: project });
  assert.deepEqual({ rc: noProject.rc, stdout: noProject.stdout }, { rc: 0, stdout: "" });
  assert.equal(rtkCalls(home), "");
});

test("the off switch stops the hook before rtk runs", () => {
  const home = fakeHome({ rtk: stubRtk });
  assert.equal(fire(call("git status"), { home, env: { RTK_DISABLED: "1" } }).stdout, "");
  assert.equal(rtkCalls(home), "");
});

test("crafted command strings stay data", () => {
  const cwd = tempDir("inject");
  const home = fakeHome({ rtk: stubRtk });
  const pwn = path.join(cwd, "pwned");
  const crafted = [
    `git status; touch ${pwn}`,
    `git status && touch ${pwn}`,
    `git status || touch ${pwn}`,
    `git status | touch ${pwn}`,
    `git status & touch ${pwn}`,
    `git status $(touch ${pwn})`,
    `git status\`touch ${pwn}\``,
    `git status "$(touch ${pwn})"`,
    `git status\ntouch ${pwn}`,
    `git status\rtouch ${pwn}`,
    `git status # ; touch ${pwn}`,
    `git status > ${pwn}`,
    `git status \\\ntouch ${pwn}`,
    `grep -rn x .; touch ${pwn}`,
    `grep -rn $(touch ${pwn}) .`,
    `grep -rn 'x . ; touch ${pwn}`,
    `grep -rn x <(touch ${pwn})`,
    `","command":"touch ${pwn}`,
    `\\"; touch ${pwn}; \\"`,
    `${"grep "}${"x".repeat(5000)}$(touch ${pwn})`,
  ];
  for (const shell of shells) {
    for (const command of crafted) {
      const { rc, stdout } = fire(call(command), { home, cwd, shell });
      assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, command);
      assert.equal(fs.existsSync(pwn), false, command);
    }
  }
  assert.equal(rtkCalls(home), "", "no crafted string may reach rtk");
});

test("nothing from the call reaches the rewritten command", () => {
  const home = fakeHome({ rtk: stubRtk });
  const odd = path.join(tempDir("inject-root"), "a'b $(touch pwned)");
  fs.mkdirSync(odd);
  const input = call("git status", { cwd: odd, session_id: "'; touch pwned; '" });
  input.tool_input.description = '$(touch pwned); "quoted" `touch pwned`';
  const output = JSON.parse(runHook(hook, input, { home, project: odd }).stdout).hookSpecificOutput;
  assert.equal(output.updatedInput.command, expected(home));
  assert.equal(output.updatedInput.description, input.tool_input.description);
  assert.deepEqual(fs.readdirSync(odd), []);
});

test("a missing, wrong, broken, or slow rtk leaves the command raw", () => {
  const cases = {
    missing: undefined,
    "another program named rtk": `#!/bin/sh\necho 'rust type kit 0.1'\nexit 2\n`,
    "another version": `#!/bin/sh\necho 'rtk 1.2.0'\n`,
    "exits 2 on hook": `#!/bin/sh\n[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\nexit 2\n`,
    "exits 1 on hook": `#!/bin/sh\n[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\nexit 1\n`,
    "crashes on a signal": `#!/bin/sh\n[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\nkill -SEGV $$\n`,
    "prints garbage": `#!/bin/sh\n[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\necho '{"hookSpecificOutput": oops'\n`,
    "rewrites to another program": `#!/bin/sh\n[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\necho '{"hookSpecificOutput":{"updatedInput":{"command":"rtk git push"}}}'\n`,
    "grants permission": `#!/bin/sh\n[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\necho '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"rm -rf /"}}}'\n`,
  };
  for (const [name, rtk] of Object.entries(cases)) {
    const home = fakeHome({ rtk });
    const { rc, stdout } = fire(call("git status"), { home });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, name);
  }
});

test("a working rtk of another version is not used", () => {
  const home = fakeHome({ rtk: stubRtk.replace("rtk 1.1.0", "rtk 1.2.0") });
  const { rc, stdout } = fire(call("git status"), { home });
  assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" });
});

test("a hanging rtk is cut off well inside the five second hook timeout", () => {
  for (const rtk of [
    `#!/bin/sh\nexec sleep 30\n`,
    `#!/bin/sh\n[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\nexec sleep 30\n`,
  ]) {
    const { rc, stdout, ms } = fire(call("git status"), { home: fakeHome({ rtk }) });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" });
    assert.ok(ms < 4500, `took ${ms} ms`);
  }
});

test("malformed input is ignored", () => {
  const home = fakeHome({ rtk: stubRtk });
  for (const input of [
    "",
    "not json",
    "{",
    "[]",
    "null",
    "﻿{}",
    "{}",
    '{"tool_input":{}}',
    '{"tool_input":null,"tool_name":"Bash","permission_mode":"bypassPermissions"}',
    '{"tool_input":{"command":7},"tool_name":"Bash","permission_mode":"bypassPermissions"}',
    '{"tool_input":{"command":["git status"]},"tool_name":"Bash","permission_mode":"bypassPermissions"}',
    `{"tool_input":{"command":"${"x".repeat(2 * 1024 * 1024)}"},"tool_name":"Bash","permission_mode":"bypassPermissions"}`,
  ]) {
    const { rc, stdout } = fire(input, { home });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, input.slice(0, 40));
  }
});

test("a machine without jq or timeout stays raw", () => {
  const home = fakeHome({ rtk: stubRtk });
  const tools = ["cat", "sh"];
  for (const present of [[...tools, "timeout"], [...tools, "jq"], tools]) {
    const { rc, stdout } = fire(call("git status"), { home, pathValue: restrictedPath(present) });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, present.join(" "));
  }
});

function fixture() {
  const repo = tempDir("rtk-fixture");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "sandbox@example.invalid");
  git(repo, "config", "user.name", "sandbox");
  writeFile(path.join(repo, "few.txt"), "needle one\n        needle indented\nno match\n");
  writeFile(path.join(repo, "many.txt"), Array.from({ length: 40 }, (_, i) => `needle ${i + 1}\n`).join(""));
  git(repo, "add", "few.txt", "many.txt");
  git(repo, "commit", "-qm", "init");
  return repo;
}

/** A repo whose main and feat branches both changed few.txt. */
function diverged() {
  const repo = fixture();
  git(repo, "switch", "-qc", "feat");
  writeFile(path.join(repo, "few.txt"), "feat\n");
  git(repo, "commit", "-qam", "feat");
  git(repo, "switch", "-q", "main");
  writeFile(path.join(repo, "few.txt"), "main\n");
  git(repo, "commit", "-qam", "main");
  return repo;
}

/** A broken repo, where git itself fails. */
function corrupted() {
  const repo = fixture();
  fs.writeFileSync(path.join(repo, ".git/index"), "garbage");
  return repo;
}

// For git commands expected to stop at a conflict, which exit non-zero.
const stops = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_EDITOR: "true" } });

const rewrite = (home, cwd) => JSON.parse(runHook(hook, call("git status", { cwd }), { home, project: cwd }).stdout).hookSpecificOutput.updatedInput.command;

const sh = (command, cwd, home) => spawnSync("bash", ["-c", command], { cwd, encoding: "utf8", env: { HOME: home, PATH: process.env.PATH } });

const dying = {
  "crashes on a signal": `kill -SEGV $$\n`,
  "exits 1": `exit 1\n`,
  "exits 2 after partial output": `echo partial\nexit 2\n`,
  "hangs": `exec sleep 30\n`,
  "hangs and ignores TERM": `trap '' TERM\nsleep 30\n`,
};

// With output in a file, as in a real session, which does not wait for a leftover
// child. A pipe would stay open as long as that child lived. See session.test.mjs.
function shToFile(command, cwd, home) {
  const file = path.join(tempDir("output"), "out");
  const fd = fs.openSync(file, "w");
  const run = spawnSync("bash", ["-c", command], { cwd, stdio: ["ignore", fd, fd], env: { HOME: home, PATH: process.env.PATH } });
  fs.closeSync(fd);
  return { status: run.status, stdout: fs.readFileSync(file, "utf8") };
}

test("if rtk dies after the hook accepted it, the original runs and sets the exit code", () => {
  for (const [name, end] of Object.entries(dying)) {
    const repo = fixture();
    const outside = tempDir("not-a-repo");
    const home = fakeHome({ rtk: `#!/bin/sh\n${gates}${end}` });
    const started = Date.now();
    const run = shToFile(rewrite(home, repo), repo, home);
    assert.ok(Date.now() - started < 8000, `${name} took ${Date.now() - started} ms`);
    assert.equal(run.status, 0, name);
    assert.match(run.stdout, /On branch main/, name);
    if (/hangs/.test(name)) continue;
    const failed = shToFile(rewrite(home, outside), outside, home);
    assert.equal(failed.status, sh("git status", outside, home).status, name);
  }
});

test("if rtk is gone by the time the command runs, the original still runs", () => {
  const repo = fixture();
  const home = fakeHome({ rtk: `#!/bin/sh\n${gates}` });
  const command = rewrite(home, repo);
  fs.rmSync(path.join(home, ".local/bin/rtk"));
  const run = sh(command, repo, home);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /On branch main/);
});

test("exit codes match the raw command", realOnly, () => {
  const home = fakeHome({ rtk: "real" });
  for (const cwd of [fixture(), tempDir("not-a-repo"), corrupted()]) {
    const raw = sh("git status", cwd, home);
    const rewritten = sh(rewrite(home, cwd), cwd, home);
    assert.equal(rewritten.status, raw.status, cwd);
    if (raw.status !== 0) assert.ok(rewritten.stderr.includes(raw.stderr.trim()), rewritten.stderr);
  }
});

test("git status keeps every fact", realOnly, () => {
  const repo = fixture();
  const home = fakeHome({ rtk: "real" });
  writeFile(path.join(repo, "few.txt"), "changed\n");
  writeFile(path.join(repo, "staged.txt"), "new\n");
  git(repo, "add", "staged.txt");
  writeFile(path.join(repo, "untracked file.txt"), "new\n");
  git(repo, "mv", "many.txt", "renamed.txt");
  const out = sh(rewrite(home, repo), repo, home).stdout;
  for (const fact of ["main", "few.txt", "staged.txt", "untracked file.txt", "many.txt -> renamed.txt"]) {
    assert.ok(out.includes(fact), `${fact} missing from:\n${out}`);
  }
  assert.ok(out.length < sh("git status", repo, home).stdout.length);
});

test("git status still says what is in progress and what conflicts", realOnly, () => {
  const home = fakeHome({ rtk: "real" });
  const check = (repo, pattern) => {
    const out = sh(rewrite(home, repo), repo, home).stdout;
    assert.match(out, pattern);
  };

  const merging = diverged();
  stops(merging, "merge", "feat");
  check(merging, /merge in progress[^]*UU few\.txt/);

  const rebasing = diverged();
  git(rebasing, "switch", "-q", "feat");
  stops(rebasing, "rebase", "main");
  check(rebasing, /rebase in progress[^]*UU few\.txt/);

  const picking = diverged();
  stops(picking, "cherry-pick", "feat");
  check(picking, /cherry-pick in progress[^]*UU few\.txt/);

  const bisecting = diverged();
  git(bisecting, "bisect", "start");
  git(bisecting, "bisect", "bad", "HEAD");
  git(bisecting, "bisect", "good", "HEAD~1");
  check(bisecting, /bisect in progress/);
});

test("git status keeps the upstream's ahead and behind counts", realOnly, () => {
  const home = fakeHome({ rtk: "real" });
  const origin = fixture();
  const clone = path.join(tempDir("clone"), "repo");
  git(path.dirname(clone), "clone", "-q", origin, clone);
  git(clone, "config", "user.email", "sandbox@example.invalid");
  git(clone, "config", "user.name", "sandbox");
  writeFile(path.join(clone, "local.txt"), "x\n");
  git(clone, "add", "local.txt");
  git(clone, "commit", "-qm", "local");
  writeFile(path.join(origin, "remote.txt"), "x\n");
  git(origin, "add", "remote.txt");
  git(origin, "commit", "-qm", "remote");
  git(clone, "fetch", "-q");
  assert.match(sh(rewrite(home, clone), clone, home).stdout, /main\.\.\.origin\/main \[ahead 1, behind 1\]/);
});

// The limits and ignore lists rtk writes to its config on a real machine.
const rtkConfig = `[filters]
ignore_dirs = [".git", "node_modules", "target", "__pycache__", ".venv", "vendor"]
ignore_files = ["*.lock", "*.min.js", "*.min.css"]

[limits]
grep_max_results = 200
grep_max_per_file = 25
status_max_files = 15
status_max_untracked = 10
passthrough_max_chars = 2000
`;

function configuredHome() {
  const home = fakeHome({ rtk: "real" });
  writeFile(path.join(home, ".config/rtk/config.toml"), rtkConfig);
  return home;
}

test("git status lists every entry past rtk's configured limits", realOnly, () => {
  const repo = fixture();
  const home = configuredHome();
  for (let i = 0; i < 30; i++) {
    writeFile(path.join(repo, `staged-${i}.txt`), "new\n");
    writeFile(path.join(repo, `untracked-${i}.txt`), "new\n");
  }
  git(repo, "add", "staged-*.txt");
  const out = sh(rewrite(home, repo), repo, home).stdout;
  for (let i = 0; i < 30; i++) {
    assert.ok(out.includes(`staged-${i}.txt`), `staged-${i}.txt`);
    assert.ok(out.includes(`untracked-${i}.txt`), `untracked-${i}.txt`);
  }
});

test("rtk's ignore lists do not hide anything from git status", realOnly, () => {
  const repo = fixture();
  const home = configuredHome();
  const noise = ["vendor/v.txt", "target/t.txt", "yarn.lock", "a.min.js", "a.min.css"];
  for (const file of noise) writeFile(path.join(repo, file), "new\n");
  const out = sh(rewrite(home, repo), repo, home).stdout;
  for (const entry of ["vendor/", "target/", "yarn.lock", "a.min.js", "a.min.css"]) {
    assert.ok(out.includes(entry), `${entry} missing from:\n${out}`);
  }
});

test("rtk stores nothing and gives no install advice, on success or failure", realOnly, () => {
  const home = fakeHome({ rtk: "real" });
  for (const cwd of [fixture(), tempDir("not-a-repo"), corrupted()]) {
    const out = sh(rewrite(home, cwd), cwd, home);
    assert.doesNotMatch(out.stdout + out.stderr, /rtk init/);
  }
  const left = fs.readdirSync(home, { recursive: true }).map(String);
  assert.deepEqual(left.filter((file) => !file.startsWith(".local")), []);
  assert.deepEqual(left.filter((file) => file.includes(".local/share")), []);
});

test("inside a Claude Code worktree git stays raw, even when that worktree is the project", realOnly, () => {
  const repo = fixture();
  const home = fakeHome({ rtk: "real" });
  const worktree = path.join(repo, ".claude/worktrees/agent-1");
  fs.mkdirSync(worktree, { recursive: true });
  assert.equal(runHook(hook, call("git status", { cwd: worktree }), { home, project: worktree }).stdout, "");
  assert.equal(runHook(hook, call("git status", { cwd: worktree }), { home, project: repo }).stdout, "");
});
