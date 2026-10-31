// Static checks on the committed wiring. `claude plugin validate` ignores the
// repo-root .claude directory, so nothing else guards these files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { git, hooksDir, repoRoot } from "./lib/sandbox.mjs";

const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const settings = JSON.parse(read(".claude/settings.json"));
const scripts = ["rtk-rewrite.sh", "trail-context.sh", "trail-sync.sh", "trail-env.sh"];
const commands = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));

test("the settings file registers hooks and nothing else", () => {
  assert.deepEqual(Object.keys(settings), ["hooks"]);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["PostToolUse", "PreToolUse", "UserPromptSubmit"]);
});

test("no hook can start Trail's self-heal", () => {
  assert.equal(settings.hooks.SessionStart, undefined);
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(hooksDir, script), "utf8");
    const code = source.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    assert.doesNotMatch(code, /\bsession-start\b|\bhook\.cjs\b|trail-hooks|graft-hooks/, script);
    assert.doesNotMatch(code, /"\$trail" (?!ask\b|build\b|\])/, `${script} may only call trail ask and trail build`);
    assert.doesNotMatch(code, /\btrail (init|mcp|upgrade|note)\b|\brtk init\b|\bnpx\b|\bnpm\b/, script);
  }
});

test("every hook is a bounded command through a committed script that cannot block", () => {
  for (const hook of commands) {
    assert.equal(hook.type, "command");
    assert.equal(hook.async, undefined);
    assert.match(hook.command, /^sh "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/[a-z-]+\.sh" 2>\/dev\/null \|\| exit 0$/);
    assert.ok(hook.timeout > 0 && hook.timeout <= 30, `timeout ${hook.timeout}`);
    const script = hook.command.match(/hooks\/([a-z-]+\.sh)/)[1];
    assert.ok(fs.existsSync(path.join(hooksDir, script)), script);
  }
});

test("hook scripts parse under sh and bash and hold no eval or unpinned download", () => {
  for (const script of scripts) {
    const file = path.join(hooksDir, script);
    for (const shell of ["sh", "bash"]) {
      assert.equal(spawnSync(shell, ["-n", file]).status, 0, `${shell} -n ${script}`);
    }
    const code = fs.readFileSync(file, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    assert.doesNotMatch(code, /\beval\b|\bbash -c\b|\bsh -c\b|\bcurl\b|\bwget\b/, script);
  }
});

test(".gitignore keeps the main worktree's lines and covers local state", () => {
  const lines = read(".gitignore").split("\n");
  for (const line of [
    "node_modules/",
    "# graft's local graph cache — regenerable, not committed (run `graft build`).",
    "/graft/",
    "/.claude/worktrees/",
    "/.claude/settings.local.json",
    "/.trail/",
  ]) {
    assert.ok(lines.includes(line), line);
  }
  for (const ignored of ["graft/x", ".claude/worktrees/x/y", ".claude/settings.local.json", ".trail/learnings/x.md"]) {
    assert.equal(spawnSync("git", ["check-ignore", "-q", "--no-index", ignored], { cwd: repoRoot }).status, 0, ignored);
  }
  for (const tracked of [".claude/settings.json", ".claude/hooks/rtk-rewrite.sh"]) {
    assert.notEqual(spawnSync("git", ["check-ignore", "-q", "--no-index", tracked], { cwd: repoRoot }).status, 0, tracked);
  }
});

test("no version is pinned and the hooks are not part of the shipped plugin", () => {
  for (const file of [".claude-plugin/marketplace.json", "plugins/proxmox/.claude-plugin/plugin.json"]) {
    assert.doesNotMatch(read(file), /"version"/, file);
  }
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.deepEqual(marketplace.plugins.map((plugin) => plugin.source), ["./plugins/proxmox"]);
  const shipped = git(repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "plugins");
  assert.doesNotMatch(shipped, /rtk|trail-|\.claude\/hooks|tests\/project-hooks/);
  assert.equal(fs.existsSync(path.join(repoRoot, "plugins/proxmox/hooks")), false);
});

test("the Korean guide answers every question it must", () => {
  const guide = read("docs/project-tools.md");
  assert.match(guide, /[가-힣]/);
  for (const needed of ["RTK_DISABLED=1", "TRAIL_NO_HOOKS=1", "disableAllHooks", "trail init", "rtk init"]) {
    assert.ok(guide.includes(needed), needed);
  }
});
