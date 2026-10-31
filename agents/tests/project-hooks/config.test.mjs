// Static checks on the committed wiring. `claude plugin validate` ignores the
// repo-root .claude directory, so nothing else guards these files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { copyRepo, git, hooksDir, repoRoot, sealed, sessionCase, sessionSkipReason, tempDir } from "./lib/sandbox.mjs";

const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const settings = JSON.parse(read(".claude/settings.json"));
const scripts = ["rtk-rewrite.sh", "trail-context.sh", "trail-env.sh"];
const commands = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));

test("the settings file registers hooks and nothing else", () => {
  assert.deepEqual(Object.keys(settings), ["hooks"]);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["PreToolUse", "UserPromptSubmit"]);
});

// team-watcher-*.mjs (and their tests) belong to .claude/agents/team-watcher.md, which registers them, not settings.json.
test("every hook on disk is registered, and nothing runs after a Write", () => {
  const onDisk = fs.readdirSync(hooksDir).filter((file) => file !== "trail-env.sh" && !/^team-watcher-[a-z-]+(\.test)?\.mjs$/.test(file)).sort();
  assert.deepEqual(commands.map((hook) => hook.command.match(/hooks\/([a-z-]+\.sh)/)[1]).sort(), onDisk);
  assert.deepEqual(onDisk, ["rtk-rewrite.sh", "trail-context.sh"]);
});

// The one place the hooks may name Trail's own files: to stay away from them.
const standDown = /^\[ ! -e "\$root\/[^"]+" \] \|\| exit 0$|^ *\*[^)]*\) exit 0 ;;$/;

test("no hook can start Trail's self-heal", () => {
  assert.equal(settings.hooks.SessionStart, undefined);
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(hooksDir, script), "utf8");
    const code = source.split("\n").filter((line) => !line.trimStart().startsWith("#") && !standDown.test(line)).join("\n");
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

test("every timeout can also kill what ignores TERM", () => {
  for (const script of scripts) {
    const code = fs.readFileSync(path.join(hooksDir, script), "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#"));
    for (const line of code.filter((text) => /\btimeout\b/.test(text) && !/command -v timeout/.test(text))) {
      assert.match(line, /\btimeout -k 1 \d+ /, `${script}: ${line}`);
    }
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
    "/.graft/",
  ]) {
    assert.ok(lines.includes(line), line);
  }
  for (const ignored of ["graft/x", ".claude/worktrees/x/y", ".claude/settings.local.json", ".trail/learnings/x.md", ".graft/config.json", ".env"]) {
    assert.equal(spawnSync("git", ["check-ignore", "-q", "--no-index", ignored], { cwd: repoRoot }).status, 0, ignored);
  }
  for (const tracked of [".claude/settings.json", ".claude/hooks/rtk-rewrite.sh"]) {
    assert.notEqual(spawnSync("git", ["check-ignore", "-q", "--no-index", tracked], { cwd: repoRoot }).status, 0, tracked);
  }
});

test(".gitignore also ignores a link named graft or .graft", () => {
  const repo = tempDir("ignore");
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), read(".gitignore"));
  git(repo, "add", ".gitignore");
  git(repo, "-c", "user.email=s@example.invalid", "-c", "user.name=s", "commit", "-qm", "init");
  for (const name of ["graft", ".graft"]) fs.symlinkSync("/nowhere/at/all", path.join(repo, name));
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "");
});

test("no version is pinned and the hooks are not part of the shipped plugin", () => {
  for (const file of [".claude-plugin/marketplace.json", "plugins/proxmox/.claude-plugin/plugin.json"]) {
    assert.doesNotMatch(read(file), /"version"/, file);
  }
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.deepEqual(marketplace.plugins.map((plugin) => plugin.source), ["./plugins/proxmox", "./plugins/tower"]);
  const shipped = git(repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "plugins");
  assert.doesNotMatch(shipped, /rtk|trail-|\.claude\/hooks|tests\/project-hooks/);
  assert.equal(fs.existsSync(path.join(repoRoot, "plugins/proxmox/hooks")), false);
});

test("the Korean guide answers every question it must", () => {
  const guide = read("docs/project-tools.md");
  assert.match(guide, /[가-힣]/);
  for (const needed of ["RTK_DISABLED=1", "TRAIL_NO_HOOKS=1", "disableAllHooks", "trail init", "rtk init", "trail note", "`.trail/`", "rm -rf graft .graft .trail", "~/.trail", "|| git status", "진행 중인 작업", "`.env`", "`.claude/hooks/`"]) {
    assert.ok(guide.includes(needed), needed);
  }
});

// Hides the tool for real, inside the seal, because a PATH trick would not reach the
// fixed PATH the hook tests run with. config.test.mjs stays out so this cannot recurse.
for (const tool of ["jq", "timeout"]) {
  test(`on a machine without ${tool} the suite skips instead of failing`, { skip: sessionSkipReason() ?? false }, () => {
    const box = sessionCase(`no-${tool}`);
    const project = copyRepo(path.join(box.work, "project"));
    const files = ["rtk-rewrite", "trail", "session"].map((name) => `tests/project-hooks/${name}.test.mjs`);
    const installed = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    const run = sealed(box, project, [process.execPath, "--test", ...files], { hide: [installed], timeout: 150000 });
    assert.equal(run.status, 0, run.stdout.slice(-3000));
    assert.match(run.stdout, /skipped [1-9]/);
    assert.match(run.stdout, /fail 0/);
  });
}

test("the guide states what could surprise someone once the hooks are on", () => {
  const guide = read("docs/project-tools.md");
  for (const needed of [
    // The map holds source text, out of a Read rule's reach.
    "`graft/.cache`에는 소스 본문의 사본이 있습니다",
    "`Read` deny 규칙은 이 사본을 막지 못합니다",
    // What stands Trail down.
    "`.trail/`이 있으면 Trail 훅이 멈춥니다",
    "`graft/workspace.json`",
    "`.claude/helpers/trail-hooks.cjs`",
    "`.claude/skills/trail/SKILL.md`",
    "`/.trail/hook.cjs`",
    "`.git`이 없어도 Trail 훅이 멈춥니다",
    // A planted parse memo, and what still stands after the fix.
    "`--no-reuse`로 파일을 모두 다시 읽고",
    "직접 실행한 `trail build`는 캐시를 그대로 재사용하므로",
    "잘못된 코드 위치로 출력될 수 있습니다",
    // What the context filter stops, and what it does not.
    "코드처럼 생긴 항목만 넣습니다",
    "식별자 모양으로 쓴 문구는 막지 못합니다",
    // When they take effect.
    "재시작 없이",
    "6초",
    // Where rtk runs at all.
    "`bypassPermissions` 모드의 프로젝트 루트에서 실행한 옵션 없는 `git status`에만 동작하고, `.claude/worktrees/` 안에서는 동작하지 않습니다",
    // What this was verified on, and what it was not.
    "Claude Code 2.1.316",
    "rtk 1.1.0",
    "Trail-Code 0.28.1",
    "실제 모델",
  ]) {
    assert.ok(guide.includes(needed), needed);
  }
});

test("the guide makes no promise the hooks cannot keep", () => {
  const guide = read("docs/project-tools.md");
  assert.doesNotMatch(guide, /프로젝트 파일은 데이터로만 다룹니다/);
  assert.doesNotMatch(guide, /trail-sync|Write, Edit, MultiEdit 후/);
  assert.doesNotMatch(guide, /가짜 훅 출력 줄을 만들 수 없습니다/);
  assert.doesNotMatch(guide, /프로젝트 파일이 Trail을 통해 프로젝트 밖에 쓰거나 명령을 실행하지 못합니다/);
});

test("the guide no longer promises rtk's state line", () => {
  const guide = read("docs/project-tools.md");
  assert.doesNotMatch(guide, /진행 중이라는 사실도 표시/);
});

test("the guide and the hook name no retired rewrite", () => {
  const guide = read("docs/project-tools.md");
  assert.doesNotMatch(guide, /true \|\|/);
  assert.doesNotMatch(guide, /`grep`: |`rg`: |약 25줄/);
  const hook = fs.readFileSync(path.join(hooksDir, "rtk-rewrite.sh"), "utf8");
  const code = hook.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /\bgrep\b|\brg\b/);
});
