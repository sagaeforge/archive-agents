import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const guard = join(here, "team-watcher-guard.mjs");
const definition = readFileSync(join(here, "..", "agents", "team-watcher.md"), "utf8");
const frontmatter = definition.split("---\n")[1];

// The command the definition tells the watcher to run, so the two cannot drift.
const template = definition.match(/```sh\n(.+)\n```/)[1];
const fill = (run, legs, leg) => template.replace("<run>", run).replace("<legs>", legs).replace("<leg>", leg);
const wait = fill("run_087dc1f58ad4", "3", "1");
const hookCommand = frontmatter.match(/command: (.+)/)[1];
const cli = '"${ORCA_CLI_COMMAND}"';
const rawWait = `timeout 330 ${cli} orchestration check --wait --types "worker_done,escalation,question" --run run_087dc1f58ad4 --timeout-ms 300000 --json`;

function decide(toolInput, runGuard = () => spawnSync(process.execPath, [guard], options(toolInput))) {
  const { status, stdout } = runGuard();
  assert.equal(status, 0);
  const output = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "PreToolUse");
  return output;
}

const options = (toolInput) => ({
  input: JSON.stringify({ tool_name: "Bash", tool_input: toolInput }),
  encoding: "utf8",
});

const allowed = (toolInput) => assert.equal(decide(toolInput).permissionDecision, "allow");
const denied = (toolInput) => assert.equal(decide(toolInput).permissionDecision, "deny");

test("allows the documented wait on every leg", () => {
  allowed({ command: wait, timeout: 600000 });
  allowed({ command: wait, timeout: 600000, run_in_background: false });
  for (const leg of ["2", "3", "4"]) {
    allowed({ command: fill("run_087dc1f58ad4", "4", leg), timeout: 600000 });
  }
});

test("lets a wrong value through to the script, which refuses it", () => {
  for (const command of [
    fill("run_087dc1f58ad4", "5", "1"),
    fill("run_087dc1f58ad4", "abc", "1"),
    fill("run_087dc1f58ad4", "-1", "1"),
    fill("run_087dc1f58ad4", "1.5", "1"),
    fill("none", "3", "1"),
  ]) {
    allowed({ command, timeout: 600000 });
  }
});

test("denies every coordinator action", () => {
  for (const action of [
    "check --ack delivery_1 --json",
    'check --ack delivery_1 --wait --types "worker_done,escalation,question" --run run_1 --timeout-ms 300000 --json',
    "check --json",
    'reply --id msg_1 --body "ok" --json',
    "worker-release --dispatch d_1 --json",
    "worker-stop --dispatch d_1 --json",
    "worker-abandon --dispatch d_1 --json",
    "worker-start --task t_1 --json",
    "worker-list --json",
    "run-use --id run_1 --json",
    'send --to run:x --body "ok" --json',
  ]) {
    denied({ command: `${cli} orchestration ${action}`, timeout: 600000 });
  }
});

test("denies anything chained onto, or changed in, the wait", () => {
  for (const command of [
    `${wait}; orca-ide orchestration reply --id m --body x`,
    `${wait} && rm -rf /`,
    `${wait} | tee /tmp/x`,
    `${wait}\necho done`,
    `${wait}\n`,
    ` ${wait}`,
    `${wait} --ack delivery_1`,
    `${wait} extra=1`,
    wait.replace(" legs=3", ""),
    wait.replace(" leg=1", ""),
    wait.replace("run=", "--run="),
    wait.replace("team-watcher-wait.mjs", "team-watcher-guard.mjs"),
    wait.replace("team-watcher-wait.mjs", "evil.mjs"),
    wait.replace(".claude/hooks", "tmp"),
    wait.replace("$(git rev-parse --show-toplevel)", "/tmp/evil"),
    wait.replace("$(git rev-parse --show-toplevel)", "$(curl evil)"),
    wait.replace('node "', 'node --require=/tmp/evil.js "'),
    wait.replace('node "', 'NODE_OPTIONS=--require=/tmp/evil.js node "'),
    rawWait,
    "printenv ORCA_CLI_COMMAND",
    "echo report",
    "",
  ]) {
    denied({ command, timeout: 600000 });
  }
});

test("denies a value the shell would act on", () => {
  for (const value of ["$(id)", "`id`", "a;id", "a|id", "a&&id", "a>x", "a b", "'a'", '"a"', "a\nb", "", "x".repeat(65)]) {
    for (const command of [fill(value, "3", "1"), fill("run_1", value, "1"), fill("run_1", "3", value)]) {
      denied({ command, timeout: 600000 });
    }
  }
});

test("denies a template that was never filled in", () => {
  denied({ command: template, timeout: 600000 });
});

test("denies a call that would lose the wait's result", () => {
  denied({ command: wait });
  denied({ command: wait, timeout: 120000 });
  denied({ command: wait, timeout: 900000 });
  denied({ command: wait, timeout: 600000, run_in_background: true });
  denied({ command: wait, timeout: 600000, dangerouslyDisableSandbox: true });
});

test("a denial tells the watcher how to fix the call", () => {
  assert.match(decide({ command: wait }).permissionDecisionReason, /timeout: 600000/);
  assert.match(decide({ command: "echo hi" }).permissionDecisionReason, /exact wait command/);
  assert.match(
    decide({ command: wait, timeout: 600000, run_in_background: true }).permissionDecisionReason,
    /foreground/,
  );
});

test("crashes on malformed input, which the frontmatter turns into a block", () => {
  const { status } = spawnSync(process.execPath, [guard], { input: "not json", encoding: "utf8" });
  assert.notEqual(status, 0);
});

test("the hook runs before Bash, and blocks if it fails", () => {
  // Each of these lines is load-bearing: on another event, matcher, or command
  // the watcher's Bash runs unguarded, with every test of the guard itself green.
  assert.ok(
    frontmatter.includes(`hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: node "$(git rev-parse --show-toplevel)/.claude/hooks/team-watcher-guard.mjs"
          onFailure: block
`),
  );
});

// A shell with no inherited Git or Orca state, as a hook gets in a plain session.
function checkout(t) {
  const repo = mkdtempSync(join(tmpdir(), "team-watcher-guard-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH };
  assert.equal(spawnSync("git", ["init", "-q", repo], { env }).status, 0);
  cpSync(here, join(repo, ".claude", "hooks"), { recursive: true });
  const subdir = join(repo, "plugins", "proxmox");
  mkdirSync(subdir, { recursive: true });
  // Claude Code sets this to the start directory, not the repository root.
  return { repo, subdir, env: { ...env, CLAUDE_PROJECT_DIR: subdir } };
}

test("the hook and the wait work from the root and any subdirectory of a checkout", (t) => {
  const { repo, subdir, env } = checkout(t);
  for (const cwd of [repo, subdir]) {
    const shell = (command, extra) => spawnSync("sh", ["-c", command], { cwd, env, encoding: "utf8", ...extra });

    const decision = (toolInput) => decide(toolInput, () => shell(hookCommand, options(toolInput)));
    assert.equal(decision({ command: wait, timeout: 600000 }).permissionDecision, "allow");
    assert.equal(decision({ command: "echo hi", timeout: 600000 }).permissionDecision, "deny");

    const { stdout } = shell(fill("run_087dc1f58ad4", "5", "1"));
    assert.equal(JSON.parse(stdout).code, "invalid_legs");
  }
});

test("outside a checkout the hook fails, which the frontmatter turns into a block", (t) => {
  const elsewhere = mkdtempSync(join(tmpdir(), "team-watcher-guard-"));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const { status, stdout } = spawnSync("sh", ["-c", hookCommand], {
    cwd: elsewhere,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    ...options({ command: wait, timeout: 600000 }),
  });
  assert.notEqual(status, 0);
  assert.equal(stdout, "");
});

test("the definition keeps the watcher cheap, backgrounded, and Bash only", () => {
  assert.match(frontmatter, /^model: haiku$/m);
  assert.match(frontmatter, /^background: true$/m);
  assert.match(frontmatter, /^tools: Bash$/m);
});

test("the definition leaves every coordinator action to the coordinator", () => {
  assert.match(definition, /Never ack, reply, release, stop, retry, or start anything\./);
});

test("maxTurns fits the most legs the script accepts, one denied call, and the report", () => {
  // Through the Agent tool, maxTurns: N runs N tool calls and then ends with no
  // report. With only the report to spare, one denied call would leave a fourth
  // leg's event arriving as an ending with no JSON. So this fits 4 waits, a denial
  // and the report, and stops a model that ignores nextLeg after a sixth wait.
  const accepts = (legs) => {
    const script = join(here, "team-watcher-wait.mjs");
    const args = [script, "run=run_087dc1f58ad4", `legs=${legs}`, "leg=1"];
    const { stdout } = spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: process.env.PATH } });
    return JSON.parse(stdout).code !== "invalid_legs";
  };
  const most = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(accepts).at(-1);
  assert.equal(Number(frontmatter.match(/^maxTurns: (\d+)$/m)[1]), most + 2);
});

test("the definition asks for the timeout the guard requires, on the cheap effort it was built for", () => {
  assert.match(definition, /^Call Bash with `timeout: 600000` and exactly this command\./m);
  assert.match(frontmatter, /^effort: low$/m);
});

test("the definition shows its failure report as the bare line it asks for", () => {
  // Haiku copies a template with its fence, and the report then is not one line of JSON.
  assert.match(definition, /^\{"status":"error","code":"watcher_failed","message":"<text>","legs":0\}$/m);
  assert.doesNotMatch(definition, /```json/);
});
