// PreToolUse guard for the team-watcher subagent. The only Bash command it
// allows is one bounded Orca inbox wait, so the watcher cannot ack, reply,
// release, stop, or retry, whatever its prompt or a message body says.
// Allowing that command here also keeps a background watcher from stalling on
// a permission prompt in the main session.
//
// The agent frontmatter sets onFailure: block, so a crash here denies the call.

import { text } from "node:stream/consumers";

// --run is required. Without it, a session that lost its Run falls through to
// the direct mailbox path, where check marks mail read and never replays it.
// timeout is required too: closing the Orca pane that hosts the WSL relay can
// hang the CLI past --timeout-ms, and a hung command must end in the foreground.
const WAIT_COMMAND =
  /^timeout 330 "\$\{ORCA_CLI_COMMAND:\?ORCA_CLI_COMMAND is not set\}" orchestration check --wait --types "worker_done,escalation,question" --run run_[0-9a-f]+ --timeout-ms 300000 --json$/;
const BASH_TIMEOUT_MS = 600_000;

function denialReason(toolInput) {
  if (!WAIT_COMMAND.test(toolInput.command ?? "")) {
    return "team-watcher may only run the exact wait command from its definition.";
  }
  // A foreground command that reaches its Bash timeout moves to the background
  // and later wakes the finished watcher, so Bash must outlast timeout 330.
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
