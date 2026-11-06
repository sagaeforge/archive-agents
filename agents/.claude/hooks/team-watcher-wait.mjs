// One bounded wait on an Orca Run inbox run by the main session as a background
// Bash command. It prints one JSON line: the report, or a request to wait again.
// The model only reads that line, so it counts nothing, judges nothing, and never
// sees a message subject or body.
//
// This also keeps a real event readable. Bash shows the model only a preview of
// output over 30,000 characters, and one batch can pass that: 50 heartbeats and a
// worker_done, or a few long reports. The model never opens the saved output,
// and a Delivery replays until it is acked, so raw output would turn that event
// into the same error on every relaunch.

import { spawn } from "node:child_process";

const RUN = /^run_[0-9a-f]+$/;
const LEGS = /^[1-4]$/;
const EVENT_TYPES = ["worker_done", "escalation", "question"];
const WAIT_MS = 300_000;
// Closing the Orca pane that hosts the WSL relay can hang the CLI past
// --timeout-ms, and a hung wait must end before Bash moves it to the background.
const STALL_SECONDS = 330;
// A CLI that ignores timeout's TERM gets a KILL this long after it, or it would outlive the limit.
const KILL_AFTER_SECONDS = 10;
const TIMED_OUT = 124;
const KILLED = 137;
// A stray process can hold the CLI's pipes open after the CLI itself has exited.
const PIPE_GRACE_MS = 2_000;
const MESSAGE_LIMIT = 500;

const failure = (code, message, legs) => ({
  status: "error",
  code,
  message: message.slice(0, MESSAGE_LIMIT),
  legs,
});

function refusal({ run, legs, leg }) {
  if (!RUN.test(run)) return failure("invalid_run", `run must look like run_087dc1f58ad4, not ${run}.`, 0);
  if (!LEGS.test(legs)) return failure("invalid_legs", `legs must be 1 to 4, not ${legs}.`, 0);
  if (!LEGS.test(leg) || Number(leg) > Number(legs)) {
    return failure("invalid_leg", `leg must be 1 to ${legs}, not ${leg}.`, 0);
  }
  if (!process.env.ORCA_CLI_COMMAND) return failure("cli_not_set", "ORCA_CLI_COMMAND is not set.", 0);
  return null;
}

// --run is required. Without it, a session that lost its Run falls through to the
// direct mailbox path, where check marks mail read and never replays it.
function wait(run) {
  const args = [
    "-k",
    String(KILL_AFTER_SECONDS),
    String(STALL_SECONDS),
    process.env.ORCA_CLI_COMMAND,
    "orchestration",
    "check",
    "--wait",
    "--types",
    EVENT_TYPES.join(","),
    "--run",
    run,
    "--timeout-ms",
    String(WAIT_MS),
    "--json",
  ];
  return new Promise((resolve) => {
    const output = { stdout: "", stderr: "" };
    const finish = (exit) => resolve({ exit, ...output });
    const child = spawn("timeout", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (text) => (output.stdout += text));
    child.stderr.setEncoding("utf8").on("data", (text) => (output.stderr += text));
    child.on("error", (error) => {
      output.stderr = error.message;
      finish(null);
    });
    child.on("close", (exit, signal) => finish(exit ?? signal));
    child.on("exit", (exit, signal) => setTimeout(finish, PIPE_GRACE_MS, exit ?? signal));
  });
}

function parse(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function classify({ exit, stdout, stderr }, leg, legs) {
  if (exit === TIMED_OUT || exit === KILLED) return failure("wait_stalled", `No result after ${STALL_SECONDS} seconds.`, leg);

  const reply = parse(stdout);
  if (reply?.error) return failure(String(reply.error.code), String(reply.error.message), leg);
  if (exit !== 0 || reply?.ok !== true || !reply.result) {
    // Keepalive lines only show that the CLI was running.
    const text = stderr.split("\n").filter((line) => line && !line.includes("_keepalive"));
    return failure("no_result", `exit ${exit}: ${text.join(" ") || "no output"}`, leg);
  }

  const { count = 0, messages = [], deliveryId = null, replayed, timedOut, cancelled } = reply.result;
  if (count > 0) {
    const types = [...new Set(messages.map((message) => message.type))];
    // A batch with no event still replays until it is acked, so waiting again
    // cannot help. It is a checkpoint, never an event.
    const outcome = types.some((type) => EVENT_TYPES.includes(type))
      ? { status: "event" }
      : { status: "checkpoint", reason: "unacked_batch" };
    return { ...outcome, deliveryId, count, types, replayed: replayed === true, legs: leg };
  }
  if (timedOut && leg < legs) return { status: "wait", nextLeg: leg + 1 };
  const reason = timedOut ? "time_limit" : cancelled ? "cancelled" : "empty";
  return { status: "checkpoint", reason, deliveryId: null, count: 0, types: [], replayed: false, legs: leg };
}

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.split("=")));
const line = refusal(args) ?? classify(await wait(args.run), Number(args.leg), Number(args.legs));
// Exit here so a stray process still holding the pipes cannot keep this one alive.
process.stdout.write(`${JSON.stringify(line)}\n`, () => process.exit(0));
