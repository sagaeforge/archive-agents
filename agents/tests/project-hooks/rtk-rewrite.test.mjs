// The rtk wrapper on its own: what it rewrites, what it leaves raw, and how it fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakeHome, git, hasRealRtk, restrictedPath, runHook, tempDir, writeFile } from "./lib/sandbox.mjs";

const hook = "rtk-rewrite.sh";
const shells = ["sh", "bash", "dash"].filter((shell) => spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0);

const call = (command, extra = {}) => ({
  session_id: "session",
  cwd: "/tmp",
  permission_mode: "bypassPermissions",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command, description: "a test call" },
  tool_use_id: "toolu_1",
  ...extra,
});

// Answers like rtk 1.1.0 for the two calls the wrapper makes, and logs each one.
const stubRtk = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/rtk.log"
[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }
jq -c '{hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: (.tool_input + {command: ("rtk " + .tool_input.command)})}}'
`;

const rtkCalls = (home) => {
  const log = path.join(home, "rtk.log");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
};

const realOnly = { skip: hasRealRtk() ? false : "rtk is not installed" };

const quiet = "RTK_DB_PATH=/dev/null RTK_RECALL=0 RTK_SUPPRESS_HOOK_WARNING=1 RTK_TELEMETRY_DISABLED=1";

test("listed read-only commands become rtk calls that keep the original as a subcommand", () => {
  for (const shell of shells) {
    const home = fakeHome({ rtk: stubRtk });
    for (const command of [
      "git status",
      "grep -rn createClient plugins",
      "grep -n needle a.txt b.txt",
      'grep -rn "two words" plugins',
      "grep -i 'two words' README.md",
      "rg createClient",
      "rg -n 'two words' plugins",
    ]) {
      const { rc, stdout } = runHook(hook, call(command), { home, shell });
      assert.equal(rc, 0, command);
      const output = JSON.parse(stdout).hookSpecificOutput;
      assert.equal(output.updatedInput.command, `true || ${command}; ${quiet} ${home}/.local/bin/rtk ${command}`);
      assert.equal(output.hookEventName, "PreToolUse");
    }
  }
});

test("a rewrite changes only the command and grants nothing", () => {
  const home = fakeHome({ rtk: stubRtk });
  const input = call("git status");
  input.tool_input = { command: "git status", description: "d", timeout: 5000, run_in_background: true };
  const output = JSON.parse(runHook(hook, input, { home }).stdout).hookSpecificOutput;
  const { command, ...rest } = output.updatedInput;
  assert.deepEqual(rest, { description: "d", timeout: 5000, run_in_background: true });
  assert.equal(output.permissionDecision, undefined);
  assert.match(output.additionalContext, /RTK_DISABLED=1 git status/);
});

test("everything else stays raw, starting with what reviewers need in full", () => {
  const home = fakeHome({ rtk: stubRtk });
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
    // grep and rg flags that change the output shape or what is read.
    "grep -c needle a.txt",
    "grep -l needle a.txt",
    "grep -L needle a.txt",
    "grep -o needle a.txt",
    "grep -v needle a.txt",
    "grep -A2 needle a.txt",
    "grep -e needle a.txt",
    "grep -f patterns a.txt",
    "grep --include=x -r needle .",
    "grep needle -",
    "grep -- -n a.txt",
    'grep "-n" a.txt',
    "grep '-n' a.txt",
    "rg --files",
    "rg -l needle",
    "rg --pre cat needle",
    "rg -c needle",
    "rg -r x needle",
    // The isolation guard refuses rtk with git among its operands.
    "grep -rn git .",
    "grep -rn gitignore .",
    "grep -rn GitHub .",
    "grep -n digit a.txt",
    "rg git",
    // Raw escape hatches.
    "RTK_DISABLED=1 grep -rn needle .",
    "RTK_DISABLED=1 git status",
    "command grep -rn needle .",
    "/usr/bin/grep -rn needle .",
    "\\grep -rn needle .",
    "grep -rn needle . | cat",
    "git status | cat",
    "grep -rn needle . > out.txt",
    // Near misses.
    " git status",
    "git status ",
    "grep",
    "rg",
    "grepx foo .",
    "rgrep foo .",
  ]) {
    const { rc, stdout, stderr } = runHook(hook, call(command), { home });
    assert.deepEqual({ rc, stdout, stderr }, { rc: 0, stdout: "", stderr: "" }, command);
  }
  assert.equal(rtkCalls(home), "", "rtk must not even be consulted for these");
});

test("rewriting happens only under bypassPermissions", () => {
  const home = fakeHome({ rtk: stubRtk });
  for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk", "", undefined]) {
    const { rc, stdout } = runHook(hook, call("git status", { permission_mode: mode }), { home });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, String(mode));
  }
  assert.equal(runHook(hook, call("git status", { tool_name: "Monitor" }), { home }).stdout, "");
});

test("the off switch stops the hook before rtk runs", () => {
  const home = fakeHome({ rtk: stubRtk });
  assert.equal(runHook(hook, call("git status"), { home, env: { RTK_DISABLED: "1" } }).stdout, "");
  assert.equal(rtkCalls(home), "");
});

test("crafted command strings stay data", () => {
  const cwd = tempDir("inject");
  const home = fakeHome({ rtk: stubRtk });
  const pwn = path.join(cwd, "pwned");
  const crafted = [
    `grep -rn x .; touch ${pwn}`,
    `grep -rn x . && touch ${pwn}`,
    `grep -rn x . || touch ${pwn}`,
    `grep -rn x . | touch ${pwn}`,
    `grep -rn x . & touch ${pwn}`,
    `grep -rn $(touch ${pwn}) .`,
    `grep -rn \`touch ${pwn}\` .`,
    `grep -rn "$(touch ${pwn})" .`,
    `grep -rn "\`touch ${pwn}\`" .`,
    `grep -rn x .\ntouch ${pwn}`,
    `grep -rn x .\rtouch ${pwn}`,
    `grep -rn x . # ; touch ${pwn}`,
    `grep -rn 'x . ; touch ${pwn}`,
    `grep -rn "x . ; touch ${pwn}`,
    `grep -rn 'x" . ; touch ${pwn} "'`,
    `grep -rn x <(touch ${pwn})`,
    `grep -rn x > ${pwn}`,
    `grep -rn \\\ntouch ${pwn}`,
    `git status; touch ${pwn}`,
    `git status$(touch ${pwn})`,
    `","command":"touch ${pwn}`,
    `\\"; touch ${pwn}; \\"`,
    `${"grep "}${"x".repeat(5000)}$(touch ${pwn})`,
  ];
  for (const shell of shells) {
    for (const command of crafted) {
      const { rc, stdout } = runHook(hook, call(command), { home, cwd, shell });
      assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, command);
      assert.equal(fs.existsSync(pwn), false, command);
    }
  }
  assert.equal(rtkCalls(home), "", "no crafted string may reach rtk");
});

test("a rewritten command parses into exactly the two intended commands", () => {
  const dir = tempDir("parse");
  const stub = `#!/bin/sh\nfor arg in "$@"; do printf '[%s]' "$arg"; done\necho\n`;
  const home = fakeHome({ rtk: stub.replace("for arg", `[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\n[ "$1" = hook ] && exec jq -c '{hookSpecificOutput: {updatedInput: (.tool_input + {command: ("rtk " + .tool_input.command)})}}'\nfor arg`) });
  for (const [command, argv] of [
    ['grep -n "a b c" f.txt', "[grep][-n][a b c][f.txt]"],
    ["grep -n 'a  b' f.txt", "[grep][-n][a  b][f.txt]"],
    ["rg 'x*y' .", "[rg][x*y][.]"],
    ['grep -rn "" .', "[grep][-rn][][.]"],
  ]) {
    const rewritten = JSON.parse(runHook(hook, call(command), { home }).stdout).hookSpecificOutput.updatedInput.command;
    const run = spawnSync("bash", ["-c", rewritten], { cwd: dir, encoding: "utf8", env: { HOME: home, PATH: process.env.PATH } });
    assert.equal(run.stdout.trim(), argv, rewritten);
  }
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
    const { rc, stdout } = runHook(hook, call("git status"), { home });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, name);
  }
});

test("a hanging rtk is cut off well inside the five second hook timeout", () => {
  for (const rtk of [
    `#!/bin/sh\nexec sleep 30\n`,
    `#!/bin/sh\n[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\nexec sleep 30\n`,
  ]) {
    const { rc, stdout, ms } = runHook(hook, call("git status"), { home: fakeHome({ rtk }) });
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
    const { rc, stdout } = runHook(hook, input, { home });
    assert.deepEqual({ rc, stdout }, { rc: 0, stdout: "" }, input.slice(0, 40));
  }
});

test("a machine without jq or timeout stays raw", () => {
  const home = fakeHome({ rtk: stubRtk });
  const tools = ["cat", "tr", "sh"];
  for (const present of [[...tools, "timeout"], [...tools, "jq"], tools]) {
    const { rc, stdout } = runHook(hook, call("git status"), { home, pathValue: restrictedPath(present) });
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
  writeFile(path.join(repo, "long.txt"), `needle ${"k".repeat(300)} tail\n`);
  writeFile(path.join(repo, "node_modules/pkg/index.js"), "needle in a noise directory\n");
  git(repo, "add", "few.txt", "many.txt");
  git(repo, "commit", "-qm", "init");
  return repo;
}

const rewrite = (home, command, cwd) => {
  const { stdout } = runHook(hook, call(command, { cwd }), { home, cwd });
  return JSON.parse(stdout).hookSpecificOutput.updatedInput.command;
};

const sh = (command, cwd, home) => spawnSync("bash", ["-c", command], { cwd, encoding: "utf8", env: { HOME: home, PATH: process.env.PATH } });

test("exit codes match the raw command", realOnly, () => {
  const repo = fixture();
  const outside = tempDir("not-a-repo");
  const home = fakeHome({ rtk: "real" });
  for (const [command, cwd] of [
    ["git status", repo],
    ["git status", outside],
    ["grep -rn needle .", repo],
    ["grep -n nomatch few.txt", repo],
    ["grep -n needle nofile", repo],
    ["rg -n needle few.txt", repo],
    ["rg -n nomatch few.txt", repo],
    ["rg -n needle nofile", repo],
  ]) {
    const raw = sh(command, cwd, home);
    const rewritten = sh(rewrite(home, command, cwd), cwd, home);
    assert.equal(rewritten.status, raw.status, command);
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
  const out = sh(rewrite(home, "git status", repo), repo, home).stdout;
  for (const fact of ["main", "few.txt", "staged.txt", "untracked file.txt", "many.txt -> renamed.txt"]) {
    assert.ok(out.includes(fact), `${fact} missing from:\n${out}`);
  }
  assert.ok(out.length < sh("git status", repo, home).stdout.length);
});

test("grep shows every match or marks the cut, and hides no file", realOnly, () => {
  const repo = fixture();
  const home = fakeHome({ rtk: "real" });
  const command = "grep -rn needle few.txt many.txt long.txt node_modules";
  const raw = sh(command, repo, home).stdout.trimEnd().split("\n");
  const out = sh(rewrite(home, command, repo), repo, home).stdout;
  assert.ok(out.includes(`${raw.length} matches in 4 files:`), out);
  assert.ok(out.includes("+15 more in many.txt"), out);
  assert.ok(out.includes("node_modules/pkg/index.js"), out);
  assert.match(out, /long\.txt:1:needle k+\.\.\./, "a cut line carries a marker");
  const shown = out.split("\n").filter((line) => /^\S+:\d+:/.test(line)).length;
  assert.equal(shown + 15, raw.length);
});

test("a small grep result is left as it was", realOnly, () => {
  const repo = fixture();
  const home = fakeHome({ rtk: "real" });
  const command = "grep -n needle few.txt";
  assert.equal(sh(rewrite(home, command, repo), repo, home).stdout, sh(command, repo, home).stdout);
});

test("rtk stores nothing and gives no install advice", realOnly, () => {
  const repo = fixture();
  const home = fakeHome({ rtk: "real" });
  const out = sh(rewrite(home, "grep -rn needle .", repo), repo, home);
  assert.doesNotMatch(out.stdout + out.stderr, /rtk init/);
  const left = fs.readdirSync(home, { recursive: true }).map(String);
  assert.deepEqual(left.filter((file) => !file.startsWith(".local")), []);
  assert.deepEqual(left.filter((file) => file.includes(".local/share")), []);
});

test("inside a Claude Code worktree git stays raw and searches do not", realOnly, () => {
  const repo = fixture();
  const home = fakeHome({ rtk: "real" });
  const worktree = path.join(repo, ".claude/worktrees/agent-1");
  fs.mkdirSync(worktree, { recursive: true });
  assert.equal(runHook(hook, call("git status", { cwd: worktree }), { home, cwd: worktree }).stdout, "");
  assert.notEqual(runHook(hook, call("grep -rn needle .", { cwd: worktree }), { home, cwd: worktree }).stdout, "");
});
