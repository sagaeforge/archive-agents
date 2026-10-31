// Full headless sessions: the real Claude Code binary and its real hook engine, a
// fake HOME over the real one, loopback-only networking, and a scripted model.
// These prove hook plumbing, not model behaviour.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  copyRepo,
  git,
  pathShape,
  realHome,
  rewrites,
  sealed,
  session,
  sessionCase,
  sessionSkipReason,
  sha256,
  shimCalls,
  snapshot,
  snapshotDiff,
  writeFile,
} from "./lib/sandbox.mjs";

const skip = sessionSkipReason();
const options = { skip: skip ?? false };

const bypass = ["--permission-mode", "bypassPermissions"];
const bash = (command) => ({ tool: "Bash", input: { command, description: "a test call" } });
const write = (file_path, content) => ({ tool: "Write", input: { file_path, content } });
const trailHeader = "[trail] code pointers for this prompt:";
const question = "how does createClient fail over between hosts";
const search = "grep -rn createClient plugins/proxmox/server";

const realSettings = path.join(realHome, ".claude/settings.json");
const realHash = fs.existsSync(realSettings) ? sha256(realSettings) : null;

test.after(() => {
  if (!realHash) return;
  assert.equal(sha256(realSettings), realHash, "the real ~/.claude/settings.json changed during the run");
});

function repoCase(label, stubs) {
  const box = sessionCase(label, stubs);
  box.project = copyRepo(path.join(box.work, "project"));
  return box;
}

let worktreeId = 0;

/** A fresh linked worktree, outside .claude/worktrees unless asked. */
function worktree(box, where) {
  const target = where ?? path.join(box.work, `worktree-${++worktreeId}`);
  git(box.project, "worktree", "add", "-q", "-b", `fresh-${++worktreeId}`, target);
  return target;
}

const plantUserSettings = (box, settings) => writeFile(path.join(box.home, ".claude/settings.json"), JSON.stringify(settings, null, 2));

// Unique per run, so the text cannot already be in the repository under test.
const runId = `${process.pid}-${Date.now()}`;
const canary = (type) => `canary-${runId}-${type}`;
const noteTypes = ["project", "reference", "feedback", "user"];

function plantMemory(box, projectDir) {
  const memory = path.join(box.home, ".claude/projects", projectDir.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  writeFile(path.join(memory, "MEMORY.md"), "- [synthetic](synthetic-project.md)\n");
  for (const type of noteTypes) {
    writeFile(
      path.join(memory, `synthetic-${type}.md`),
      `---\nname: Synthetic ${type} note\ndescription: Synthetic note about createClient in plugins/proxmox/server/pve.mjs\ntype: ${type}\n---\n${canary(type)} createClient in plugins/proxmox/server/pve.mjs.\n\n**Why:** synthetic.\n\n**How to apply:** synthetic.\n`,
    );
  }
}

function filesContaining(dir, text) {
  const hits = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && fs.readFileSync(full).includes(text)) hits.push(full);
    }
  };
  walk(dir);
  return hits;
}

/** The files any session writes under HOME, from a session with no project hooks. */
let controlShapes;
function controlRun() {
  if (controlShapes) return controlShapes;
  const box = sessionCase("control");
  const other = path.join(box.work, "other");
  fs.mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  writeFile(path.join(other, "plugins/note.txt"), "createClient\n");
  plantUserSettings(box, { statusLine: { type: "command", command: "echo user-status-line" } });
  const before = snapshot(box.home);
  session(box, { cwd: other, prompt: question, steps: [bash("git status"), bash("grep -rn createClient plugins"), write(path.join(other, "plugins/new.txt"), "x\n")], args: bypass });
  controlShapes = new Set(snapshotDiff(before, snapshot(box.home)).map(pathShape));
  return controlShapes;
}

test("a fresh worktree gets both hooks and writes nothing global", options, (t) => {
  const box = repoCase("fresh");
  const statusLine = { type: "command", command: "echo user-status-line" };
  plantUserSettings(box, { statusLine });
  const userSettings = path.join(box.home, ".claude/settings.json");
  const userHash = sha256(userSettings);
  const cwd = worktree(box);
  plantMemory(box, box.project);
  plantMemory(box, cwd);

  const before = snapshot(box.home);
  const probe = path.join(cwd, "plugins/proxmox/server/probe.mjs");
  const first = session(box, {
    cwd,
    prompt: question,
    steps: [bash("git status"), bash(search), write(probe, "export function sessionSyncProbe() { return 42; }\n")],
    args: bypass,
  });
  const second = session(box, { cwd, prompt: "where is sessionSyncProbe defined", steps: [], args: bypass });
  const after = snapshot(box.home);

  assert.equal(first.rc, 0, first.stderr);
  assert.equal(first.final.subtype, "success");

  // Both hooks fired, through the real engine.
  const [status, grep] = rewrites(first);
  assert.match(status, /^true \|\| git status; .*\/\.local\/bin\/rtk git status$/);
  assert.match(grep, /^true \|\| grep -rn createClient plugins\/proxmox\/server; .*rtk grep -rn createClient plugins\/proxmox\/server$/);
  assert.ok(first.results[0].text.startsWith("* fresh-"), first.results[0].text);
  assert.doesNotMatch(first.results[0].text, /On branch/);
  assert.ok(first.apiText.includes(trailHeader), "Trail context reached the model request");
  assert.match(first.apiText, /- createClient · function plugins\/proxmox\/server\/pve\.mjs:L\d+/);
  assert.ok(first.apiText.includes("rtk may have shortened this output"), "the model is told");

  // The edit fired PostToolUse, which rebuilt the map the next session reads.
  assert.ok(first.hooks.some((hook) => hook.hook_name === "PostToolUse:Write" && hook.exit_code === 0));
  assert.match(second.apiText, /- sessionSyncProbe · function plugins\/proxmox\/server\/probe\.mjs/);

  // No global write: the only home changes are ones any session makes.
  const diff = snapshotDiff(before, after);
  t.diagnostic(`fake home changes: ${JSON.stringify(diff)}`);
  const extra = diff.map(pathShape).filter((shape) => !controlRun().has(shape));
  assert.deepEqual(extra, [], "home writes a hookless session does not make");
  for (const forbidden of [".claude/helpers", ".claude/skills", ".claude/RTK.md", ".trail", ".graft", ".gemini", ".codex", ".config/rtk", ".local/share/rtk", ".zshrc"]) {
    assert.deepEqual(diff.filter((entry) => entry.includes(` ${forbidden}`)), [], forbidden);
  }

  // No statusLine, no default reapply.
  assert.equal(sha256(userSettings), userHash);
  assert.deepEqual(JSON.parse(fs.readFileSync(userSettings, "utf8")), { statusLine });
  assert.equal(fs.existsSync(path.join(cwd, ".claude/settings.local.json")), false);
  assert.equal(fs.existsSync(path.join(box.project, ".claude/settings.local.json")), false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(cwd, ".claude/settings.json"), "utf8"))), ["hooks"]);
  for (const dir of [cwd, box.project]) assert.equal(fs.existsSync(path.join(dir, ".trail")), false);

  // The worktree stays clean apart from what the session itself wrote.
  assert.equal(git(cwd, "status", "--short"), "?? plugins/proxmox/server/probe.mjs\n");

  // Hooks ran no fetch, no upgrade, and no install. Each tool is logged by a shim.
  const calls = shimCalls(box);
  t.diagnostic(`logged tool calls: ${JSON.stringify([...new Set(calls)])}`);
  const hookGit = calls.filter((call) => /^git (fetch|pull|push|remote|ls-remote|clone|gc|maintenance)\b/.test(call));
  assert.deepEqual(hookGit, []);
  assert.deepEqual(calls.filter((call) => !call.startsWith("git ")), []);

  // Memory was not copied.
  for (const type of noteTypes) {
    for (const dir of [cwd, box.project]) assert.deepEqual(filesContaining(dir, canary(type)), []);
  }
});

test("the project settings file alone is enough for both hooks", options, () => {
  const box = repoCase("project-only");
  const cwd = worktree(box);
  const run = session(box, { cwd, prompt: question, steps: [bash("git status")], args: bypass, settingSources: "project" });
  assert.equal(run.rc, 0, run.stderr);
  assert.equal(rewrites(run).length, 1);
  assert.ok(run.apiText.includes(trailHeader));
});

test("the memory canary check can fail: trail init itself copies the notes", options, () => {
  const box = repoCase("memory-control");
  plantMemory(box, box.project);
  const trail = path.join(realHome, ".local/share/trail-code/0.28.1/node_modules/.bin/trail");
  const run = sealed(box, box.project, [trail, "init", "--yes", "--no-statusline", "--no-global", "--no-agents"], {
    env: { DO_NOT_TRACK: "1", TRAIL_NO_FETCH: "1", TRAIL_NO_LOOK_BACK: "1" },
  });
  assert.equal(run.error, undefined);
  assert.notDeepEqual(filesContaining(box.project, canary("project")), [], "control must copy, or the check proves nothing");
  assert.ok(fs.existsSync(path.join(box.project, ".trail/learnings")));
});

test("a worktree under .claude/worktrees keeps git raw and still gets both hooks", options, () => {
  const box = repoCase("nested");
  const cwd = worktree(box, path.join(box.project, ".claude/worktrees/fresh"));
  const run = session(box, { cwd, prompt: question, steps: [bash("git status"), bash(search)], args: bypass });
  assert.equal(run.rc, 0, run.stderr);
  assert.equal(rewrites(run).length, 1);
  assert.match(rewrites(run)[0], /rtk grep -rn createClient/);
  assert.match(run.results[0].text, /On branch/);
  assert.ok(run.apiText.includes(trailHeader));
  assert.equal(git(cwd, "status", "--short"), "");
});

test("a session in another project gets neither hook", options, () => {
  const box = repoCase("other");
  const other = path.join(box.work, "other");
  fs.mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  writeFile(path.join(other, "src/a.mjs"), "export function createClient() {}\n");
  const probe = path.join(other, "src/b.mjs");
  const run = session(box, { cwd: other, prompt: question, steps: [bash("git status"), bash("grep -rn createClient src"), write(probe, "x\n")], args: bypass });
  assert.equal(run.rc, 0, run.stderr);
  assert.deepEqual(rewrites(run), []);
  assert.deepEqual(run.hooks, []);
  assert.equal(run.apiText.includes(trailHeader), false);
  assert.match(run.results[0].text, /On branch/);
  assert.equal(fs.existsSync(path.join(other, "graft")), false);
});

test("claude plugin validate passes with the wiring in place", options, (t) => {
  const box = repoCase("validate");
  session(box, { cwd: box.project, steps: [] });
  const claude = path.join(box.dir, "claude-bin");
  for (const target of [".", "plugins/proxmox"]) {
    const run = sealed(box, box.project, [claude, "plugin", "validate", target], { env: { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
    t.diagnostic(`${target}: ${run.stdout.trim()}`);
    assert.equal(run.status, 0, run.stdout + run.stderr);
  }
});

test("the plugin a machine installs carries none of this wiring", options, () => {
  const box = repoCase("install");
  session(box, { cwd: box.project, steps: [] });
  const claude = path.join(box.dir, "claude-bin");
  const env = { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const added = sealed(box, box.project, [claude, "plugin", "marketplace", "add", box.project], { env });
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const installed = sealed(box, box.project, [claude, "plugin", "install", "proxmox@sagae"], { env });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const cache = path.join(box.home, ".claude/plugins/cache");
  const files = fs.readdirSync(cache, { recursive: true }).map(String);
  assert.ok(files.some((file) => file.endsWith("server/pve.mjs")), "the plugin itself was installed");
  assert.deepEqual(files.filter((file) => /rtk-rewrite|trail-|\.claude\/|project-hooks|project-tools/.test(file)), []);
});

test("a session started in a subdirectory gets no project hooks, as the guide says", options, () => {
  const box = repoCase("subdirectory");
  const run = session(box, { cwd: path.join(box.project, "plugins/proxmox"), prompt: question, steps: [bash("git status")], args: bypass });
  assert.equal(run.rc, 0, run.stderr);
  assert.deepEqual(rewrites(run), []);
  assert.equal(run.apiText.includes(trailHeader), false);
});

test("outside bypassPermissions commands run raw and need no new approval", options, () => {
  const box = repoCase("default-mode");
  const cwd = worktree(box);
  const run = session(box, { cwd, prompt: question, steps: [bash("git status"), bash(search)], args: ["--permission-mode", "default"] });
  assert.equal(run.rc, 0, run.stderr);
  assert.deepEqual(rewrites(run), []);
  assert.deepEqual(run.denials, []);
  assert.match(run.results[0].text, /On branch/);
  assert.match(run.results[1].text, /createClient/);
  assert.ok(run.apiText.includes(trailHeader), "Trail context does not depend on the mode");
});

const rule = (kind, command) => ({ permissions: { [kind]: [`Bash(${command})`] } });

const ruleSources = {
  "project settings": (box, cwd, settings) => {
    const file = path.join(cwd, ".claude/settings.json");
    writeFile(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...settings }));
  },
  "local settings": (box, cwd, settings) => writeFile(path.join(cwd, ".claude/settings.local.json"), JSON.stringify(settings)),
  "user settings": (box, cwd, settings) => plantUserSettings(box, settings),
  "--settings": (box, cwd, settings) => ({ args: ["--settings", JSON.stringify(settings)] }),
  "managed settings": (box, cwd, settings) => {
    const managedDir = path.join(box.dir, "managed");
    writeFile(path.join(managedDir, "managed-settings.json"), JSON.stringify(settings));
    return { managedDir };
  },
};

for (const [source, apply] of Object.entries(ruleSources)) {
  for (const kind of ["deny", "ask"]) {
    for (const [label, command, pattern] of [
      ["a search", search, "grep:*"],
      ["git status", "git status", "git status:*"],
    ]) {
      test(`${kind} rule from ${source} still stops ${label}`, options, () => {
        const box = repoCase(`rule-${kind}`);
        const cwd = worktree(box);
        const extra = apply(box, cwd, rule(kind, pattern)) ?? {};
        const run = session(box, { cwd, steps: [bash(command)], args: [...bypass, ...(extra.args ?? [])], managedDir: extra.managedDir });
        assert.equal(run.rc, 0, run.stderr);
        assert.equal(run.denials.length, 1, `${run.results[0]?.text}\n${run.stderr}`);
        assert.equal(run.results[0].isError, true);
        assert.doesNotMatch(run.results[0].text, /pve\.mjs:\d+|^\* fresh/);
      });
    }
  }
}

for (const kind of ["--disallowedTools"]) {
  for (const [label, command, pattern] of [
    ["a search", search, "Bash(grep:*)"],
    ["git status", "git status", "Bash(git status:*)"],
  ]) {
    test(`a ${kind} rule stops ${label} after it is rewritten`, options, () => {
      const box = repoCase("rule-flag");
      const cwd = worktree(box);
      const run = session(box, { cwd, steps: [bash(command)], args: [...bypass, kind, pattern] });
      assert.equal(rewrites(run).length, 1, "rtk had rewritten it, and the rule still fired");
      assert.equal(run.denials.length, 1, run.results[0]?.text);
      assert.equal(run.results[0].isError, true);
    });
  }
}

test("the rule checks can fail: a bare rtk rewrite slips past the same rule", options, () => {
  const box = repoCase("rule-control");
  const cwd = worktree(box);
  const hook = path.join(cwd, ".claude/hooks/rtk-rewrite.sh");
  const source = fs.readFileSync(hook, "utf8");
  const bare = source.replace('"true || $cmd; $quiet $rtk $cmd"', '"$quiet $rtk $cmd"');
  assert.notEqual(bare, source);
  fs.writeFileSync(hook, bare);
  const run = session(box, { cwd, steps: [bash(search)], args: [...bypass, "--disallowedTools", "Bash(grep:*)"] });
  assert.equal(rewrites(run).length, 1);
  assert.deepEqual(run.denials, [], "without the original as a subcommand the rule does not fire");
  assert.match(run.results[0].text, /createClient/);
});

test("a rule on an unrelated command leaves rewriting alone", options, () => {
  const box = repoCase("rule-unrelated");
  const cwd = worktree(box);
  const run = session(box, { cwd, steps: [bash(search)], args: [...bypass, "--disallowedTools", "Bash(git push:*)"] });
  assert.equal(rewrites(run).length, 1);
  assert.deepEqual(run.denials, []);
  assert.match(run.results[0].text, /createClient/);
});

test("the session itself adds no permission rule", options, () => {
  const box = repoCase("no-rules");
  const cwd = worktree(box);
  session(box, { cwd, prompt: question, steps: [bash("git status")], args: bypass });
  const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude/settings.json"), "utf8"));
  assert.equal(settings.permissions, undefined);
  assert.equal(fs.existsSync(path.join(box.project, ".claude/settings.local.json")), false);
});

const stubs = {
  "rtk exits 2": { rtkStub: `#!/bin/sh\necho 'unrecognized subcommand' >&2\nexit 2\n` },
  "rtk answers garbage": { rtkStub: `#!/bin/sh\n[ "$1" = --version ] && { echo 'rtk 1.1.0'; exit 0; }\necho nonsense\n` },
  "rtk is missing": { rtkStub: null, noRtk: true },
  "trail exits 2": { trailStub: `#!/bin/sh\nexit 2\n` },
  "trail answers garbage": { trailStub: `#!/bin/sh\necho '{"hits": [oops'\n` },
  "trail is missing": { trailStub: null, noTrail: true },
};

for (const [name, stub] of Object.entries(stubs)) {
  test(`the session and the command proceed when ${name}`, options, () => {
    const box = repoCase("fail-open", {
      rtkStub: stub.noRtk ? `#!/bin/sh\nexit 127\n` : stub.rtkStub,
      trailStub: stub.noTrail ? `#!/bin/sh\nexit 127\n` : stub.trailStub,
    });
    if (stub.noRtk) fs.rmSync(path.join(box.home, ".local/bin/rtk"));
    if (stub.noTrail) fs.rmSync(path.join(box.home, ".local/share/trail-code"), { recursive: true });
    const cwd = worktree(box);
    const marker = path.join(cwd, "after-the-hooks.txt");
    const run = session(box, { cwd, prompt: question, steps: [bash("echo plain"), bash("git status"), write(marker, "x\n")], args: bypass });
    assert.equal(run.rc, 0, run.stderr);
    assert.equal(run.final.subtype, "success");
    assert.deepEqual(run.denials, []);
    assert.equal(run.results[0].text, "plain");
    assert.match(run.results[1].text, /On branch|^\* fresh/);
    assert.ok(fs.existsSync(marker));
    if (!/rtk/.test(name)) assert.equal(run.apiText.includes(trailHeader), false);
    if (/rtk/.test(name)) assert.deepEqual(rewrites(run), []);
  });
}

test("slow tools delay the session only up to the hook limits", options, () => {
  const hang = `#!/bin/sh\nexec sleep 60\n`;
  const box = repoCase("slow", { rtkStub: hang, trailStub: hang });
  const cwd = worktree(box);
  const run = session(box, { cwd, prompt: question, steps: [bash("git status"), write(path.join(cwd, "a.txt"), "x\n")], args: bypass, timeout: 60000 });
  assert.equal(run.rc, 0, run.stderr);
  assert.equal(run.final.subtype, "success");
  assert.match(run.results[0].text, /On branch/);
  assert.ok(run.ms < 40000, `took ${run.ms} ms`);
});

test("a missing jq leaves the session raw and silent", options, () => {
  const box = repoCase("no-jq");
  const cwd = worktree(box);
  const run = session(box, { cwd, prompt: question, steps: [bash("git status")], args: bypass, hideJq: true });
  assert.equal(run.rc, 0, run.stderr);
  assert.deepEqual(rewrites(run), []);
  assert.match(run.results[0].text, /On branch/);
  assert.equal(run.apiText.includes(trailHeader), false);
});

test("a worktree-isolated subagent runs rewritten searches, and raw git, without refusal", options, () => {
  const box = repoCase("isolated");
  const run = session(box, {
    cwd: box.project,
    steps: [{ tool: "Agent", input: { description: "iso", prompt: "SUBAGENT-MARKER go", subagent_type: "general-purpose", isolation: "worktree" } }],
    substeps: [bash(search), bash("git status"), bash("grep -rn gitignore README.md"), bash("rg createClient plugins/proxmox/server")],
    args: bypass,
  });
  assert.equal(run.rc, 0, run.stderr);
  assert.equal(rewrites(run).length, 2, "grep and rg rewritten, the git forms left alone");
  const texts = run.results.map((result) => result.text);
  assert.ok(texts.some((text) => /On branch/.test(text)), "raw git status");
  for (const result of run.results) assert.equal(result.isError, false, result.text);
  assert.doesNotMatch(texts.join("\n"), /Refusing to run|cannot be shown not to be git/);
});

test("a raw escape in a real session is not rewritten", options, () => {
  const box = repoCase("escape");
  const cwd = worktree(box);
  const run = session(box, { cwd, steps: [bash(`RTK_DISABLED=1 ${search}`), bash(`${search} | cat`)], args: bypass });
  assert.deepEqual(rewrites(run), []);
  assert.doesNotMatch(run.results[0].text, /matches in/);
});

test("an off switch in local settings reaches the hooks", options, () => {
  const box = repoCase("off-switch");
  const cwd = worktree(box);
  writeFile(path.join(cwd, ".claude/settings.local.json"), JSON.stringify({ env: { RTK_DISABLED: "1", TRAIL_NO_HOOKS: "1" } }));
  const run = session(box, { cwd, prompt: question, steps: [bash("git status")], args: bypass });
  assert.equal(run.rc, 0, run.stderr);
  assert.deepEqual(rewrites(run), []);
  assert.equal(run.apiText.includes(trailHeader), false);
});

test("disableAllHooks in local settings turns every project hook off", options, () => {
  const box = repoCase("disable-all");
  const cwd = worktree(box);
  writeFile(path.join(cwd, ".claude/settings.local.json"), JSON.stringify({ disableAllHooks: true }));
  const run = session(box, { cwd, prompt: question, steps: [bash("git status")], args: bypass });
  assert.equal(run.rc, 0, run.stderr);
  assert.deepEqual(rewrites(run), []);
  assert.equal(run.apiText.includes(trailHeader), false);
});

test("the rewritten command also runs under zsh, the shell on this machine", { ...options, skip: options.skip || (fs.existsSync("/usr/bin/zsh") ? false : "zsh is not installed") }, () => {
  const box = repoCase("zsh");
  const cwd = worktree(box);
  const run = session(box, { cwd, steps: [bash("git status"), bash(search), bash("grep -n nomatch-at-all README.md")], args: bypass, env: { SHELL: "/usr/bin/zsh" } });
  assert.equal(run.rc, 0, run.stderr);
  assert.equal(rewrites(run).length, 3);
  assert.ok(run.results[0].text.startsWith("* fresh-"), run.results[0].text);
  assert.match(run.results[1].text, /createClient/);
  assert.match(run.results[2].text, /exit code 1/i, "a rewritten command keeps its exit code");
});

test("a user hook that answers {} beside the project hook does not disturb it", options, () => {
  const box = repoCase("sibling");
  const cwd = worktree(box);
  plantUserSettings(box, { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "cat >/dev/null; echo '{}'" }] }] } });
  const run = session(box, { cwd, steps: [bash("git status")], args: bypass });
  assert.equal(run.rc, 0, run.stderr);
  assert.equal(rewrites(run).length, 1);
  assert.ok(run.results[0].text.startsWith("* fresh-"), run.results[0].text);
});
