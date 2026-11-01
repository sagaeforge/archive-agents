// The rtk wrapper on its own: what it rewrites, what it leaves raw, and how it fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fakeHome, git, hasRealRtk, hookTest as test, plantPromisor, restrictedPath, runHook, tempDir, writeFile } from "./lib/sandbox.mjs";

const hook = "rtk-rewrite.sh";
const shells = ["sh", "bash", "dash"].filter((shell) => spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0);

// The hook acts only at the root of a repository, so a call starts there unless a
// test moves it.
const project = tempDir("rtk-project");
git(project, "init", "-q", "-b", "main");

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

const quiet = "RTK_DB_PATH=/dev/null/rtk.db RTK_RECALL=0 RTK_SUPPRESS_HOOK_WARNING=1 RTK_TELEMETRY_DISABLED=1";
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
  git(odd, "init", "-q");
  const input = call("git status", { cwd: odd, session_id: "'; touch pwned; '" });
  input.tool_input.description = '$(touch pwned); "quoted" `touch pwned`';
  const output = JSON.parse(runHook(hook, input, { home, project: odd }).stdout).hookSpecificOutput;
  assert.equal(output.updatedInput.command, expected(home));
  assert.equal(output.updatedInput.description, input.tool_input.description);
  assert.deepEqual(fs.readdirSync(odd), [".git"]);
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
    `#!/bin/sh\ntrap '' TERM\nexec sleep 30\n`,
    `#!/bin/sh\n[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\ntrap '' TERM\nexec sleep 30\n`,
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
  const tools = ["cat", "git", "sh"];
  for (const present of [[...tools, "timeout"], [...tools, "jq"], tools]) {
    const { rc, stdout } = fire(call("git status"), { home, pathValue: restrictedPath(present) });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, present.join(" "));
  }
});

test("a missing, failing, or hanging git leaves the command raw", () => {
  const home = fakeHome({ rtk: stubRtk });
  const tools = ["cat", "jq", "sh", "sleep", "timeout"];
  const { rc, stdout } = fire(call("git status"), { home, pathValue: restrictedPath(tools) });
  assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, "no git at all");
  for (const body of ["exit 128\n", "kill -SEGV $$\n", "exec sleep 30\n", "sleep 30\n", "trap '' TERM\nexec sleep 30\n"]) {
    const pathValue = restrictedPath(tools);
    writeFile(path.join(pathValue, "git"), `#!/bin/sh\n${body}`, 0o755);
    const run = fire(call("git status"), { home, pathValue });
    assert.deepEqual({ rc: run.rc, stdout: run.stdout }, { rc: 0, stdout: "" }, body);
    assert.ok(run.ms < 4500, `${body} took ${run.ms} ms`);
  }
  assert.equal(rtkCalls(home), "", "rtk is not consulted when the state is unknown");
});

test("outside a repository nothing is rewritten", () => {
  const home = fakeHome({ rtk: stubRtk });
  const outside = tempDir("not-a-repo");
  const dangling = tempDir("gone-worktree");
  writeFile(path.join(dangling, ".git"), "gitdir: /nowhere/at/all\n");
  for (const cwd of [outside, dangling]) {
    const { rc, stdout } = runHook(hook, call("git status", { cwd }), { home, project: cwd });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, cwd);
  }
  assert.equal(rtkCalls(home), "");
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

const answer = (home, cwd) => runHook(hook, call("git status", { cwd }), { home, project: cwd }).stdout;

const rewrite = (home, cwd) => JSON.parse(answer(home, cwd)).hookSpecificOutput.updatedInput.command;

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
    const command = rewrite(home, repo);
    const started = Date.now();
    const run = shToFile(command, repo, home);
    assert.ok(Date.now() - started < 8000, `${name} took ${Date.now() - started} ms`);
    assert.equal(run.status, 0, name);
    assert.match(run.stdout, /On branch main/, name);
    if (/hangs/.test(name)) continue;
    const failed = shToFile(command, outside, home);
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
  const command = rewrite(home, fixture());
  for (const cwd of [fixture(), tempDir("not-a-repo"), corrupted()]) {
    const raw = sh("git status", cwd, home);
    const rewritten = sh(command, cwd, home);
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

/** A repo whose feat branch adds a clean commit after the one that conflicts with main. */
function rangeToPick() {
  const repo = diverged();
  git(repo, "switch", "-q", "feat");
  writeFile(path.join(repo, "later.txt"), "later\n");
  git(repo, "add", "later.txt");
  git(repo, "commit", "-qm", "later");
  git(repo, "switch", "-q", "main");
  return repo;
}

/** A repo where reverting an older commit and then the newest stops on the older one. */
function rangeToRevert() {
  const repo = fixture();
  writeFile(path.join(repo, "few.txt"), "first\n");
  git(repo, "commit", "-qam", "first");
  const first = git(repo, "rev-parse", "HEAD").trim();
  writeFile(path.join(repo, "few.txt"), "second\n");
  git(repo, "commit", "-qam", "second");
  writeFile(path.join(repo, "many.txt"), "third\n");
  git(repo, "commit", "-qam", "third");
  return { repo, first };
}

const resolveConflict = (repo) => {
  writeFile(path.join(repo, "few.txt"), "resolved\n");
  git(repo, "add", "few.txt");
};

const stoppedSequences = {
  "a range cherry-pick resolved with git commit": () => {
    const repo = rangeToPick();
    stops(repo, "cherry-pick", "feat~1", "feat");
    resolveConflict(repo);
    git(repo, "commit", "-qm", "resolved");
    return { repo, line: /Cherry-pick currently in progress\./ };
  },
  "a range cherry-pick thrown away with git reset --hard": () => {
    const repo = rangeToPick();
    stops(repo, "cherry-pick", "feat~1", "feat");
    git(repo, "reset", "-q", "--hard");
    return { repo, line: /Cherry-pick currently in progress\./ };
  },
  "a range revert resolved with git commit": () => {
    const { repo, first } = rangeToRevert();
    stops(repo, "revert", "--no-edit", first, "HEAD");
    resolveConflict(repo);
    git(repo, "commit", "-qm", "resolved");
    return { repo, line: /Revert currently in progress\./ };
  },
};

test("a stopped sequence stays raw, where rtk would report a clean tree", realOnly, () => {
  const home = fakeHome({ rtk: "real" });
  for (const [name, stop] of Object.entries(stoppedSequences)) {
    const { repo, line } = stop();
    assert.match(sh("git status", repo, home).stdout, line, `${name}: git must report the sequence`);
    // The check can fail: this is what the agent would read after a rewrite.
    const rtk = sh(expected(home), repo, home).stdout;
    assert.match(rtk, /clean/, name);
    assert.doesNotMatch(rtk, /in progress/, name);
    assert.equal(answer(home, repo), "", name);
  }
});

test("the rewrite comes back once a sequence ends", realOnly, () => {
  const home = fakeHome({ rtk: "real" });
  const { repo } = stoppedSequences["a range cherry-pick resolved with git commit"]();
  assert.equal(answer(home, repo), "");
  git(repo, "cherry-pick", "--quit");
  assert.equal(rewrite(home, repo), expected(home));
});

function patchOfFeat(repo) {
  const patch = path.join(tempDir("patch"), "feat.patch");
  fs.writeFileSync(patch, git(repo, "format-patch", "-1", "feat", "--stdout"));
  return patch;
}

const bisect = (repo) => {
  git(repo, "bisect", "start");
  git(repo, "bisect", "bad", "HEAD");
  git(repo, "bisect", "good", "HEAD~1");
};

// Each starts on main, or on a detached copy of it in a linked worktree.
const operations = {
  "merge with conflicts": (repo) => stops(repo, "merge", "feat"),
  "rebase with conflicts": (repo) => stops(repo, "rebase", "feat"),
  "single cherry-pick": (repo) => stops(repo, "cherry-pick", "feat"),
  "am with conflicts": (repo) => stops(repo, "am", patchOfFeat(repo)),
  "bisect alone": bisect,
  "bisect under a cherry-pick": (repo) => {
    bisect(repo);
    stops(repo, "cherry-pick", "feat");
  },
  "single revert": (repo) => {
    writeFile(path.join(repo, "few.txt"), "newer\n");
    git(repo, "commit", "-qam", "newer");
    stops(repo, "revert", "--no-edit", "HEAD~1");
  },
  "rebase stopped on an edit": (repo) => {
    const run = spawnSync("git", ["rebase", "-i", "HEAD~1"], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i s/^pick/edit/" } });
    assert.equal(run.status, 0, run.stderr);
  },
};

test("any operation in progress stays raw, in a checkout and in a linked worktree", () => {
  const home = fakeHome({ rtk: stubRtk });
  for (const [name, start] of Object.entries(operations)) {
    const checkout = diverged();
    start(checkout);
    assert.equal(answer(home, checkout), "", name);

    const main = diverged();
    const linked = path.join(tempDir("linked"), "worktree");
    git(main, "worktree", "add", "-q", "--detach", linked, "main");
    assert.notEqual(answer(home, linked), "", `${name}: a linked worktree rewrites before it starts`);
    start(linked);
    assert.equal(answer(home, linked), "", `${name} in a linked worktree`);
    assert.notEqual(answer(home, main), "", `${name}: the main checkout has nothing in progress`);
  }
});

test("the state check asks about the project, wherever the hook process runs", () => {
  const home = fakeHome({ rtk: stubRtk });
  const busy = diverged();
  stops(busy, "merge", "feat");
  const idle = fixture();
  assert.equal(runHook(hook, call("git status", { cwd: busy }), { home, project: busy, cwd: idle }).stdout, "");
  assert.notEqual(runHook(hook, call("git status", { cwd: idle }), { home, project: idle, cwd: busy }).stdout, "");
});

test("a merge with nothing left to resolve stays raw too", () => {
  const home = fakeHome({ rtk: stubRtk });
  const repo = fixture();
  git(repo, "switch", "-qc", "feat");
  writeFile(path.join(repo, "added.txt"), "added\n");
  git(repo, "add", "added.txt");
  git(repo, "commit", "-qm", "added");
  git(repo, "switch", "-q", "main");
  git(repo, "merge", "-q", "--no-commit", "--no-ff", "feat");
  assert.equal(answer(home, repo), "");
});

test("conflicts with no operation behind them still show", realOnly, () => {
  const home = fakeHome({ rtk: "real" });
  const repo = fixture();
  writeFile(path.join(repo, "few.txt"), "stashed\n");
  git(repo, "stash", "push", "-q");
  writeFile(path.join(repo, "few.txt"), "committed\n");
  git(repo, "commit", "-qam", "committed");
  stops(repo, "stash", "pop");
  assert.match(sh(rewrite(home, repo), repo, home).stdout, /UU few\.txt/);
});

test("the state check runs nothing the repository configured", () => {
  const home = fakeHome({ rtk: stubRtk });
  const repo = fixture();
  const fired = path.join(repo, "fired");
  fs.appendFileSync(path.join(repo, ".git/config"), `[core]\n\tfsmonitor = touch ${fired}; true\n\thooksPath = hooks\n`);
  for (const name of ["post-index-change", "post-checkout", "reference-transaction"]) {
    writeFile(path.join(repo, "hooks", name), `#!/bin/sh\ntouch ${fired}\n`, 0o755);
  }
  assert.equal(rewrite(home, repo), expected(home));
  assert.equal(fs.existsSync(fired), false);
});

test("the state check starts no lazy fetch, which runs what a promisor remote names", () => {
  for (const viaUrl of [false, true]) {
    const home = fakeHome({ rtk: stubRtk });
    const repo = fixture();
    const fired = path.join(repo, ".git/fired");
    plantPromisor(repo, fired, { viaUrl });

    // The check can fail: the same listing without the hook's setting does fire it.
    spawnSync("git", ["ls-files", "--others", "--deleted", "--exclude-standard", "--directory", "--no-empty-directory"], { cwd: repo });
    assert.equal(fs.existsSync(fired), true, "the route must work without the hook's setting");
    fs.rmSync(fired);

    assert.equal(rewrite(home, repo), expected(home));
    assert.equal(fs.existsSync(fired), false);
  }
});

test("the state check reads no file through a filter, which git status would run", () => {
  const home = fakeHome({ rtk: stubRtk });
  const repo = fixture();
  const fired = path.join(repo, "fired");
  writeFile(path.join(repo, ".gitattributes"), "* filter=canary\n");
  fs.appendFileSync(path.join(repo, ".git/config"), `[filter "canary"]\n\tclean = touch ${fired}; cat\n`);
  git(repo, "add", ".gitattributes");
  git(repo, "commit", "-qm", "attributes");
  fs.rmSync(fired, { force: true });
  // A new modification time, with the same bytes, is what sends git to the filter.
  fs.utimesSync(path.join(repo, "few.txt"), new Date(), new Date(Date.now() + 5000));
  assert.equal(rewrite(home, repo), expected(home));
  assert.equal(fs.existsSync(fired), false);
  // The check can fail: git status does run it, so the hook must not use git status here.
  git(repo, "status", "--porcelain");
  assert.equal(fs.existsSync(fired), true);
});

test("status.showUntrackedFiles away from its default stays raw, where rtk would report clean", realOnly, () => {
  const home = fakeHome({ rtk: "real" });
  const repo = fixture();
  writeFile(path.join(repo, "new.txt"), "untracked\n");
  assert.equal(rewrite(home, repo), expected(home));
  git(repo, "config", "status.showUntrackedFiles", "no");
  // The check can fail: this is what the agent would read after a rewrite.
  assert.match(sh(expected(home), repo, home).stdout, /clean — nothing to commit/);
  assert.match(sh("git status", repo, home).stdout, /use -u to show untracked files/);
  for (const value of ["no", "false", "off", "0", "all", "true", "NO"]) {
    git(repo, "config", "status.showUntrackedFiles", value);
    assert.equal(answer(home, repo), "", value);
  }
  git(repo, "config", "status.showUntrackedFiles", "normal");
  assert.equal(rewrite(home, repo), expected(home));
});

test("an empty status.showUntrackedFiles stays raw, since git reads it as false", realOnly, () => {
  const home = fakeHome({ rtk: "real" });
  const repo = fixture();
  writeFile(path.join(repo, "new.txt"), "untracked\n");
  git(repo, "config", "status.showUntrackedFiles", "");
  // The check can fail: this is what the agent would read after a rewrite.
  assert.match(sh(expected(home), repo, home).stdout, /clean — nothing to commit/);
  assert.match(sh("git status", repo, home).stdout, /use -u to show untracked files/);
  assert.equal(answer(home, repo), "");
});

test("a git config that fails or hangs stays raw, since no answer is not unset", () => {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  for (const [name, broken] of [["fails", "exit 128"], ["dies", "kill -9 $$"], ["hangs", "exec sleep 30"]]) {
    const dir = tempDir("git-stub");
    writeFile(path.join(dir, "git"), `#!/bin/sh\ncase " $* " in *" config --get "*) ${broken} ;; esac\nexec ${realGit} "$@"\n`, 0o755);
    const home = fakeHome({ rtk: stubRtk });
    const repo = fixture();
    const { rc, stdout, ms } = runHook(hook, call("git status", { cwd: repo }), { home, project: repo, pathValue: `${dir}:${process.env.PATH}` });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, name);
    assert.ok(ms < 4500, `${name} took ${ms} ms`);
  }
});

test("a value from any git config file counts, and the last one wins, as in git", () => {
  const home = fakeHome({ rtk: stubRtk });
  const repo = fixture();
  writeFile(path.join(home, ".gitconfig"), "[status]\n\tshowUntrackedFiles = no\n");
  assert.equal(answer(home, repo), "", "from the user's own config");
  git(repo, "config", "status.showUntrackedFiles", "normal");
  assert.equal(rewrite(home, repo), expected(home), "the repository's setting wins");
});

const asRoot = process.getuid?.() === 0;
const unreadable = { skip: asRoot ? "root reads everything" : (hasRealRtk() ? false : "rtk is not installed") };

// Each leaves git unable to see part of the tree, which it says on stderr and exits 0.
const blindSpots = {
  "an untracked folder git cannot open": (repo) => {
    writeFile(path.join(repo, "private/secret.txt"), "x\n");
    return [path.join(repo, "private"), 0o000];
  },
  "a tracked folder git cannot open": (repo) => {
    writeFile(path.join(repo, "plugins/deep/a.txt"), "x\n");
    git(repo, "add", "plugins");
    git(repo, "commit", "-qm", "plugins");
    return [path.join(repo, "plugins"), 0o000];
  },
  "a tracked folder git can list but not enter": (repo) => {
    writeFile(path.join(repo, "plugins/deep/a.txt"), "x\n");
    git(repo, "add", "plugins");
    git(repo, "commit", "-qm", "plugins");
    return [path.join(repo, "plugins/deep"), 0o444];
  },
};

for (const [name, plant] of Object.entries(blindSpots)) {
  test(`${name} stays raw, where rtk would report clean`, unreadable, () => {
    const home = fakeHome({ rtk: "real" });
    const repo = fixture();
    const [folder, mode] = plant(repo);
    assert.equal(rewrite(home, repo), expected(home), "readable, it is rewritten");
    fs.chmodSync(folder, mode);
    try {
      // The check can fail: rtk drops the warning and reads as a clean tree.
      assert.match(sh(expected(home), repo, home).stdout, /clean — nothing to commit/);
      assert.match(sh("git status", repo, home).stderr, /Permission denied/);
      assert.equal(answer(home, repo), "");
    } finally {
      fs.chmodSync(folder, 0o755);
    }
    assert.equal(rewrite(home, repo), expected(home), "and readable again, it comes back");
  });
}

test("a root file named like git's detached line stays raw, where rtk would lose the branch", realOnly, () => {
  const home = fakeHome({ rtk: "real" });
  const origin = fixture();
  const clone = path.join(tempDir("spoof"), "repo");
  git(path.dirname(clone), "clone", "-q", origin, clone);
  git(clone, "config", "user.email", "sandbox@example.invalid");
  git(clone, "config", "user.name", "sandbox");
  writeFile(path.join(clone, "local.txt"), "x\n");
  git(clone, "add", "local.txt");
  git(clone, "commit", "-qm", "local");
  assert.match(sh(rewrite(home, clone), clone, home).stdout, /main\.\.\.origin\/main \[ahead 1\]/);

  const named = path.join(clone, "HEAD detached at v9.9.9");
  const indented = path.join(clone, " HEAD detached at v9.9.9");
  const plant = {
    file: () => (writeFile(named, ""), named),
    directory: () => (writeFile(path.join(named, "x"), ""), named),
    "dangling link": () => (fs.symlinkSync("/nowhere/at/all", named), named),
    "leading space": () => (writeFile(indented, ""), indented),
  };
  for (const [name, make] of Object.entries(plant)) {
    const spoof = make();
    // The check can fail: this is what the agent would read after a rewrite.
    const rtk = sh(expected(home), clone, home).stdout;
    assert.match(rtk, /^\* HEAD detached at v9\.9\.9/m, name);
    assert.doesNotMatch(rtk, /ahead 1/, name);
    assert.match(sh("git status", clone, home).stdout, /On branch main/, name);
    assert.equal(answer(home, clone), "", name);
    fs.rmSync(spoof, { recursive: true });
  }
  assert.equal(rewrite(home, clone), expected(home));

  // One level down git prints the directory first, so rtk does not take the bait, and
  // a name that only begins the same way is not the line rtk looks for.
  writeFile(path.join(clone, "sub/HEAD detached at v9.9.9"), "");
  writeFile(path.join(clone, "HEADER.md"), "");
  writeFile(path.join(clone, "HEAD detached"), "");
  assert.equal(rewrite(home, clone), expected(home));
  assert.match(sh(expected(home), clone, home).stdout, /\[ahead 1\]/);
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
  const command = rewrite(home, fixture());
  for (const cwd of [fixture(), tempDir("not-a-repo"), corrupted()]) {
    const out = sh(command, cwd, home);
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
