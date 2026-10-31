// PreToolUse guard for the team-watcher subagent. The only Bash command it
// allows is one run of team-watcher-wait.mjs, so the watcher cannot ack, reply,
// release, stop, or retry, whatever its prompt says. Allowing that command here
// also keeps a background watcher from stalling on a permission prompt in the
// main session.
//
// The agent frontmatter sets onFailure: block, so a crash here denies the call.

import { text } from "node:stream/consumers";

// The values only have to be safe to hand to the shell. The script checks what
// they mean, so a wrong value gets a final report instead of a denial to work
// around.
const VALUE = "[A-Za-z0-9_.+-]{1,64}";
const WAIT_COMMAND = new RegExp(
  `^node "\\$\\(git rev-parse --show-toplevel\\)/\\.claude/hooks/team-watcher-wait\\.mjs" run=${VALUE} legs=${VALUE} leg=${VALUE}$`,
);
const BASH_TIMEOUT_MS = 600_000;

function denialReason(toolInput) {
  if (!WAIT_COMMAND.test(toolInput.command ?? "")) {
    return "team-watcher may only run the exact wait command from its definition.";
  }
  // A foreground command that reaches its Bash timeout moves to the background
  // and later wakes the finished watcher, so Bash must outlast the script's own
  // 330 second limit.
  if (toolInput.timeout !== BASH_TIMEOUT_MS) {
    return `Call Bash with timeout: ${BASH_TIMEOUT_MS}.`;
  }
  if (toolInput.run_in_background || toolInput.dangerouslyDisableSandbox) {
    return "Run the wait in the foreground with no sandbox override.";
  }
  return null;
}

const input = JSON.parse(await text(process.stdin));
const denial = denialReason(input.tool_input ?? {});
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: denial ? "deny" : "allow",
      permissionDecisionReason: denial ?? "Bounded team-watcher inbox wait.",
    },
  }),
);
