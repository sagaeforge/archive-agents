// Proves the tests still bite. Each mutant breaks one guarantee in a throwaway copy of the
// repository, and the test file that owns that guarantee has to fail there. A mutant that no longer
// applies counts as a failure, so a refactor cannot quietly disarm this check.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const PLUGIN = "plugins/proxmox";
// npm test can read anything in the repository, so a copy leaves out only git data, installed
// packages and the other checkouts under .claude/worktrees.
const NOT_COPIED = new Set([".git", "node_modules", "worktrees"]);
const TEST_TIMEOUT_MS = 120_000;
// The control runs the whole suite, which takes well over a minute even here, so one mutant's limit
// would fail this step on a slower runner with nothing wrong. check's own timeout still bounds it.
const CONTROL_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const GET_ONLY = "    // GET only: this client deliberately has no way to issue a mutating request.\n";
const POST_METHOD = `    async post(path) {
      return transport(hosts[preferred], path, getToken());
    },
`;

// Paths are relative to the plugin, so these reach back up to the repository root.
const CI = "../../.github/workflows/ci.yml";
const PROMOTE = "../../.github/scripts/promote.sh";
const ROLLBACK = "../../.github/scripts/rollback.sh";
const HOOK = "../../.githooks/pre-push";
const SCAN = "../../.github/scripts/gitleaks.sh";
const BOOTSTRAP = "scripts/bootstrap-token.sh";
const SMOKE = "test/smoke/live.mjs";
const DOCTOR = "scripts/doctor-checks.mjs";
// Most test files are slow only as a whole, so a mutant names the tests that own its guarantee. A
// pattern that stops matching runs nothing, which reads as a survivor, so a renamed test cannot
// quietly disarm a mutant.
const named = (pattern, file) => [`--test-name-pattern=${pattern}`, file];
const READ_ONLY_TESTS = ["test/readonly.test.mjs"];
const LAUNCH_TESTS = ["test/launch.test.mjs"];
const TOKEN_TESTS = ["test/token-guard.test.mjs"];
const BOOTSTRAP_PROOF_TESTS = named("no proof|no token in it", "test/bootstrap-token.test.mjs");
const BOOTSTRAP_SIGNAL_TESTS = named("on the way out", "test/bootstrap-token.test.mjs");
const DOCTOR_GATE_TESTS = named("stable", "test/doctor.test.mjs");
const GATE = "test/gate.test.mjs";
const FLOW_TESTS = named("^CI flow", GATE);
const PROMOTE_TESTS = named("^promote ", GATE);
const ROLLBACK_TESTS = named("^rollback ", GATE);
const HOOK_TESTS = named("^the hook ", GATE);
const SMOKE_TEST_FILE = "test/live-smoke.test.mjs";
const SCAN_TESTS = ["test/gitleaks.test.mjs"];
const RULE_TESTS = ["test/repo-rules.test.mjs"];
const DOC_TESTS = ["test/docs.test.mjs"];
const REFUSE_STABLE = `    refs/heads/stable)
      echo "pre-push: stable moves only through CI. Push to main; see docs/stable-gate.md." >&2
      exit 1
      ;;
`;

const MUTANTS = [
  { id: "M1", breaks: "requests go out as POST", file: "server/pve.mjs", from: 'method: "GET"', to: 'method: "POST"', tests: READ_ONLY_TESTS },
  { id: "M2", breaks: "the client gains post()", file: "server/pve.mjs", from: GET_ONLY, to: POST_METHOD + GET_ONLY, tests: READ_ONLY_TESTS },
  { id: "M3", breaks: "tools stop being read-only", file: "server/tools.mjs", from: "readOnlyHint: true", to: "readOnlyHint: false", tests: READ_ONLY_TESTS },
  { id: "M4", breaks: "the CA pin is dropped", file: "server/pve.mjs", from: "          ca,\n", to: "          rejectUnauthorized: false,\n", tests: READ_ONLY_TESTS },
  { id: "M5", breaks: ".mcp.json turns certificate checks off", file: ".mcp.json", from: '"env": {\n', to: '"env": {\n        "NODE_TLS_REJECT_UNAUTHORIZED": "0",\n', tests: LAUNCH_TESTS },
  { id: "M6", breaks: "a default host is dropped", file: "server/pve.mjs", from: '"192.0.2.1,192.0.2.1,192.0.2.1"', to: '"192.0.2.1,192.0.2.1"', tests: READ_ONLY_TESTS },
  { id: "M7", breaks: "the list of hosts stops being split", file: "server/pve.mjs", from: '.split(",")', to: '.split(";")', tests: READ_ONLY_TESTS },
  { id: "M8", breaks: "the node pattern lets encoded segments through", file: "server/tools.mjs", from: "regex(/^[\\w.-]+$/)", to: "regex(/^[\\w.%-]+$/)", tests: READ_ONLY_TESTS },
  { id: "T1", breaks: "the call log is off by default", file: ".mcp.json", from: ',\n      "env": {\n        "PVE_LOG_FILE": "${CLAUDE_PLUGIN_DATA}/calls.jsonl"\n      }', to: "", tests: LAUNCH_TESTS },
  { id: "T2", breaks: "the log grows without limit", file: "server/log.mjs", from: "    if (stat?.size >= MAX_LOG_BYTES) moveAside();\n", to: "", tests: LAUNCH_TESTS },
  { id: "T3", breaks: "the log file is readable by others", file: "server/log.mjs", from: "{ mode: 0o600 }", to: "{ mode: 0o644 }", tests: LAUNCH_TESTS },
  { id: "T4", breaks: "a token in a path reaches the log", file: "server/log.mjs", from: "path.length > MAX_PATH_LENGTH || holdsToken(path)", to: "path.length > MAX_PATH_LENGTH", tests: TOKEN_TESTS },
  { id: "T5", breaks: "the token reaches a tool's error", file: "server/pve.mjs", from: 'detail: `${host}: ${code === "TLS_VERIFY" ? err.code : err.message || err.code}`', to: "detail: `${host}: ${token}`", tests: TOKEN_TESTS },
  { id: "T6", breaks: "the server prints to stdout", file: "server/log.mjs", from: "process.stderr.write(line)", to: "process.stdout.write(line)", tests: TOKEN_TESTS },
  { id: "T12", breaks: "a whole token with no UUID in it reaches the log", file: "server/log.mjs", from: "const TOKEN_SHAPED = /=|", to: "const TOKEN_SHAPED = /", tests: TOKEN_TESTS },
  { id: "T13", breaks: "an unknown node is named back to the caller", file: "server/tools.mjs", from: "`That is not a node of this cluster.", to: '`"${node}" is not a node of this cluster.', tests: TOKEN_TESTS },
  { id: "T14", breaks: "the token in a reason PVE gives reaches the reply", file: "server/pve.mjs", from: "safeReason(failureReason(res), token)", to: "failureReason(res)", tests: TOKEN_TESTS },
  { id: "T15", breaks: "an encoded token in a reason PVE gives reaches the reply", file: "server/pve.mjs", from: "const { forms, settled } = decodedForms(reason);", to: "const { forms, settled } = { forms: [reason], settled: true };", tests: TOKEN_TESTS },
  { id: "T16", breaks: "a token in other letter case in a reason PVE gives reaches the reply", file: "server/pve.mjs", from: "form.toLowerCase().includes(needle)", to: "form.includes(needle)", tests: TOKEN_TESTS },
  { id: "T17", breaks: "a reason nested past the decoding bound reaches the reply", file: "server/pve.mjs", from: "!settled || forms.some(", to: "forms.some(", tests: TOKEN_TESTS },
  { id: "T7", breaks: "an encoded token reaches the log", file: "server/log.mjs", from: "text = decodeURIComponent(text)", to: "text = text", tests: TOKEN_TESTS },
  { id: "T8", breaks: "a long path breaks the bound on the log", file: "server/log.mjs", from: "path.length > MAX_PATH_LENGTH || ", to: "", tests: TOKEN_TESTS },
  { id: "T9", breaks: "a FIFO at the log path hangs the server", file: "server/log.mjs", from: "    if (stat && !stat.isFile()) return; // Opening a FIFO nobody reads would block the whole server.\n", to: "", tests: named("not a file", "test/errors.test.mjs") },
  { id: "T10", breaks: "a lost race for the rename costs the line", file: "server/log.mjs", from: 'if (err.code !== "ENOENT") throw err;', to: "throw err;", tests: LAUNCH_TESTS },
  { id: "T11", breaks: "a log that cannot move aside grows without limit", file: "server/log.mjs", from: 'if (err.code !== "ENOENT") throw err;', to: "", tests: LAUNCH_TESTS },
  { id: "D1", breaks: "a machine on main passes with the gate in use", file: DOCTOR, from: "if (state.remote?.hasStable && ref !== STABLE) {", to: "if (false) {", tests: DOCTOR_GATE_TESTS },
  { id: "D2", breaks: "the registration hint loses #stable", file: DOCTOR, from: "return hasStable ? `${REGISTER}#${STABLE}` : REGISTER;", to: "return REGISTER;", tests: DOCTOR_GATE_TESTS },
  { id: "D3", breaks: "the hint names a stable branch that does not exist", file: DOCTOR, from: "return hasStable ? `${REGISTER}#${STABLE}` : REGISTER;", to: "return `${REGISTER}#${STABLE}`;", tests: DOCTOR_GATE_TESTS },
  { id: "B1", breaks: "a reply with no token counts as proof, and another machine's token goes", file: BOOTSTRAP, from: 'if [[ ! $secret =~ ^[0-9A-Za-z-]+$ ]]; then\n  die "$SSH_HOST', to: 'ISSUED_ID=$NEW_ID\nif [[ ! $secret =~ ^[0-9A-Za-z-]+$ ]]; then\n  die "$SSH_HOST', tests: BOOTSTRAP_PROOF_TESTS },
  { id: "B2", breaks: "a signal can cut the cleanup short", file: BOOTSTRAP, from: 'die() {\n  HOLD_SIGNALS=true\n', to: "die() {\n", tests: BOOTSTRAP_SIGNAL_TESTS },
  { id: "W1", breaks: "a wait that ignores TERM outlives its limit", file: "../../.claude/hooks/team-watcher-wait.mjs", from: '    "-k",\n    String(KILL_AFTER_SECONDS),\n', to: "", tests: ["../../.claude/hooks/team-watcher-wait.test.mjs"] },
  { id: "R1", breaks: "CI gains a second leg, and the mutation check runs on both", file: CI, from: "        node: [26]\n", to: "        node: [26, 28]\n", tests: RULE_TESTS },
  { id: "R2", breaks: "CI installs an action by tag", file: CI, from: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: ${{ matrix.node }}", to: "actions/setup-node@v7\n        with:\n          node-version: ${{ matrix.node }}", tests: RULE_TESTS },
  { id: "R3", breaks: "CI stops scanning for secrets", file: CI, from: "      - run: .github/scripts/gitleaks.sh\n", to: "", tests: RULE_TESTS },
  { id: "R4", breaks: "check gets more time instead of staying fast", file: CI, from: "    timeout-minutes: 15\n", to: "    timeout-minutes: 45\n", tests: RULE_TESTS },
  { id: "K1", breaks: "a runbook command gets a comment back", file: "../../docs/stable-gate.md", from: "claude plugin marketplace remove sagae\n", to: "claude plugin marketplace remove sagae   # note\n", tests: DOC_TESTS },
  { id: "K2", breaks: "the emergency inbox read loses --run", file: "../../docs/team-operations.md", from: "orca-ide orchestration check --run <run_id> --json\n", to: "orca-ide orchestration check --json\n", tests: DOC_TESTS },
  { id: "M9", breaks: "a response stops being read as UTF-8", file: "server/pve.mjs", from: 'Buffer.concat(chunks).toString("utf8")', to: 'Buffer.concat(chunks).toString("latin1")', tests: named("UTF-8", "test/errors.test.mjs") },
  { id: "G1", breaks: "promote stops waiting for check and the smoke", file: CI, from: "    needs: [check, live-smoke]\n", to: "", tests: named("promote waits", GATE) },
  { id: "G2", breaks: "promote runs before the owner turns the gate on", file: CI, from: "vars.STABLE_GATE_ENABLED == 'true' && ", to: "", tests: FLOW_TESTS },
  { id: "G3", breaks: "promote forces stable", file: PROMOTE, from: 'git push origin "$sha', to: 'git push --force origin "$sha', tests: PROMOTE_TESTS },
  { id: "G4", breaks: "promote creates stable", file: PROMOTE, from: "if [[ -z $stable ]]; then", to: 'if [[ -z $stable ]]; then git push origin "$sha:refs/heads/stable"; exit 0; fi; if false; then', tests: PROMOTE_TESTS },
  { id: "G5", breaks: "promote acts on a stale run", file: PROMOTE, from: 'if [[ $sha != "$main" ]]; then', to: "if false; then", tests: PROMOTE_TESTS },
  { id: "G6", breaks: "rollback can move stable forward", file: ROLLBACK, from: 'if ! git merge-base --is-ancestor "$sha" "$stable"; then', to: "if false; then", tests: ROLLBACK_TESTS },
  { id: "G7", breaks: "rollback accepts a commit off main", file: ROLLBACK, from: 'if ! git merge-base --is-ancestor "$sha" "$main"; then', to: "if false; then", tests: ROLLBACK_TESTS },
  { id: "G8", breaks: "rollback accepts a commit that failed CI", file: ROLLBACK, from: "if [[ ! $passed =~ ^[1-9][0-9]*$ ]]; then", to: "if false; then", tests: ROLLBACK_TESTS },
  { id: "G9", breaks: "rollback drops its lease", file: ROLLBACK, from: '--force-with-lease="refs/heads/stable:$stable"', to: "--force", tests: ROLLBACK_TESTS },
  { id: "G10", breaks: "the hook lets stable through", file: HOOK, from: REFUSE_STABLE, to: "", tests: HOOK_TESTS },
  { id: "G11", breaks: "the hook checks the working tree", file: HOOK, from: 'git archive "$target" | tar -x -C "$work"', to: 'cp -R . "$work"', tests: HOOK_TESTS },
  { id: "G12", breaks: "the hook hands GIT_DIR to the checks", file: HOOK, from: 'unset "${git_vars[@]}"\n', to: "", tests: HOOK_TESTS },
  { id: "G13", breaks: "a failed check no longer stops promote", file: CI, from: "      && needs.check.result == 'success'\n", to: "", tests: FLOW_TESTS },
  { id: "G14", breaks: "a failed smoke no longer stops promote", file: CI, from: "needs.live-smoke.result == 'success'", to: "needs.live-smoke.result != 'cancelled'", tests: FLOW_TESTS },
  { id: "G15", breaks: "the weekly run promotes", file: CI, from: " && github.event_name != 'schedule'", to: "", tests: FLOW_TESTS },
  { id: "G16", breaks: "a cancelled run still promotes", file: CI, from: "!cancelled() && ", to: "always() && ", tests: FLOW_TESTS },
  { id: "G17", breaks: "pull requests reach the runner", file: CI, from: "github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && !inputs.skip_smoke", to: "!inputs.skip_smoke", tests: FLOW_TESTS },
  { id: "G18", breaks: "the smoke waits for a runner nobody has turned on", file: CI, from: "if: vars.LIVE_SMOKE_ENABLED == 'true' && ", to: "if: ", tests: FLOW_TESTS },
  { id: "G19", breaks: "a failing job no longer fails the run", file: CI, from: "    runs-on: ubuntu-latest\n    timeout-minutes: 15\n", to: "    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    continue-on-error: true\n", tests: named("no step or job", GATE) },
  { id: "G20", breaks: "promote moves to the runner next to the token", file: CI, from: "    runs-on: ubuntu-latest\n    timeout-minutes: 5\n", to: "    runs-on: [self-hosted, proxmox]\n    timeout-minutes: 5\n", tests: named("hosted runners", GATE) },
  { id: "G21", breaks: "live-smoke stops running the smoke", file: CI, from: "      - run: node test/smoke/live.mjs\n", to: '      - run: "true"\n', tests: named("live-smoke waits", GATE) },
  { id: "G22", breaks: "live-smoke no longer waits for check", file: CI, from: "    needs: check\n", to: "", tests: named("live-smoke waits", GATE) },
  { id: "G23", breaks: "the hook scans with the working tree's script", file: HOOK, from: '"$work/.github/scripts/gitleaks.sh" "$repo" "$target"', to: '"$repo/.github/scripts/gitleaks.sh"', tests: HOOK_TESTS },
  { id: "G24", breaks: "the hook checks HEAD, not the pushed ref", file: HOOK, from: 'git archive "$target" | tar -x -C "$work"', to: 'git archive HEAD | tar -x -C "$work"', tests: HOOK_TESTS },
  { id: "G25", breaks: "the hook ignores a failing npm test", file: HOOK, from: "npm test\n", to: "npm test || true\n", tests: HOOK_TESTS },
  { id: "G26", breaks: "the hook lets a mirror push through", file: HOOK, from: 'echo "pre-push: a mirror push can delete stable unseen. Push branches by name." >&2\n      exit 1\n', to: "", tests: HOOK_TESTS },
  { id: "G27", breaks: "rollback counts a pull request's run", file: ROLLBACK, from: "--workflow ci.yml --branch main --commit", to: "--workflow ci.yml --commit", tests: ROLLBACK_TESTS },
  { id: "S1", breaks: "the scan skips merge commits", file: SCAN, from: ' --full-history -m"', to: ' --full-history"', tests: SCAN_TESTS },
  { id: "S2", breaks: "the scan stops reading commit messages", file: SCAN, from: 'git -C "$repo" log --format=%B "$revisions" | "$work/gitleaks" stdin "${options[@]}"\n', to: "", tests: SCAN_TESTS },
  { id: "S3", breaks: "the scan stops reading the files at the tip", file: SCAN, from: '"$work/gitleaks" dir "${options[@]}" "$work/tree"\n', to: "", tests: SCAN_TESTS },
  { id: "S4", breaks: "a canary stops being checked", file: SCAN, from: `printf '%s: %s\\n' 'value' "$CANARY_UUID" | must_find "pveum output"\n`, to: "", tests: SCAN_TESTS },
  { id: "S5", breaks: "the scan reads every branch, not the pushed commit", file: SCAN, from: "revisions=${2:---all}", to: "revisions=--all", tests: SCAN_TESTS },
  { id: "L1", breaks: "the smoke prints the text of a tool error", file: SMOKE, from: '/^(?:PVE API \\d{3}|[A-Z_]{2,}(?=:)|All PVE hosts unreachable)/.exec(text)?.[0] ?? "tool error"', to: "text", tests: named("a PVE error shows", SMOKE_TEST_FILE) },
  { id: "L2", breaks: "the smoke accepts privileges beyond .Audit", file: SMOKE, from: "expect(excess === 0,", to: "expect(true,", tests: named("a privilege beyond", SMOKE_TEST_FILE) },
  { id: "L3", breaks: "the smoke accepts a token with no privileges", file: SMOKE, from: "expect(held.size > 0,", to: "expect(true,", tests: named("no privileges at all", SMOKE_TEST_FILE) },
  { id: "L4", breaks: "an outage reads as a plugin failure", file: SMOKE, from: "answered: !NO_ANSWER.has(code)", to: "answered: true", tests: named("reads as INFRA", SMOKE_TEST_FILE) },
  { id: "L5", breaks: "a certificate failure reads as an outage", file: SMOKE, from: "answered: !NO_ANSWER.has(code)", to: "answered: false", tests: named("a certificate that fails", SMOKE_TEST_FILE) },
  { id: "L6", breaks: "the weekly run ignores certificates about to expire", file: SMOKE, from: 'process.env.GITHUB_EVENT_NAME === "schedule" ? EXPIRY_WARNING_DAYS : 0', to: "0", tests: named("the weekly run fails", SMOKE_TEST_FILE) },
  { id: "L7", breaks: "a server's stderr reaches the log", file: SMOKE, from: 'stderr: "ignore",', to: 'stderr: "inherit",', tests: named("what the server writes to stderr", SMOKE_TEST_FILE) },
  { id: "L8", breaks: "the smoke stops asserting SDN entries", file: SMOKE, from: 'expect(sdn.length >= 1, "no SDN entries listed");', to: 'expect(true, "no SDN entries listed");', tests: named("no SDN entries", SMOKE_TEST_FILE) },
  { id: "L9", breaks: "the server loses its SDN filter", file: "server/tools.mjs", from: 'if (type !== "sdn") return pve.get("/cluster/resources", { type });', to: 'return pve.get("/cluster/resources", { type });', tests: named("a healthy cluster", SMOKE_TEST_FILE) },
  { id: "L10", breaks: "a wrong hostname reads as a plugin failure", file: SMOKE, from: '"ENOTFOUND", ', to: "", tests: named("ENOTFOUND", SMOKE_TEST_FILE) },
];

// A developer's shell can hold a real token, and deliberately broken code has no use for one.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PVE_")));

function copyRepository(root, name) {
  const dir = join(root, name);
  cpSync(REPO, dir, { recursive: true, filter: (source) => !NOT_COPIED.has(basename(source)) });
  symlinkSync(join(REPO, PLUGIN, "node_modules"), join(dir, PLUGIN, "node_modules"));
  return join(dir, PLUGIN);
}

function stopGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Nothing is left in the group.
  }
}

// A timeout stops only the command itself. Its own process group lets the test processes under it
// go too, or they would stay behind and spin with their directory gone.
function runTests(cwd, files, timeout = TEST_TIMEOUT_MS) {
  const [command, args] = files ? [process.execPath, ["--test", ...files]] : ["npm", ["test"]];
  const { pid, status, error, stdout, stderr } = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    detached: true,
  });
  if (error) stopGroup(pid);
  // node --test answers the timeout's signal by exiting 1, which is no finding about a mutant.
  return { status: error ? null : status, output: `${stdout}${stderr}` };
}

function parses(path) {
  if (/\.(?:yml|md)$/.test(path)) return true; // The tests read these as text, so any text will do.
  if (path.endsWith(".json")) {
    try {
      JSON.parse(readFileSync(path, "utf8"));
      return true;
    } catch {
      return false;
    }
  }
  const [command, ...args] = path.endsWith(".mjs") ? [process.execPath, "--check"] : ["bash", "-n"];
  return spawnSync(command, [...args, path]).status === 0;
}

// Returns why the mutant does not count, or nothing when the tests caught it.
function problemWith({ file, from, to, tests }, plugin) {
  // The full suite for every mutant is what once took check past its time limit.
  if (!tests?.length) return "names no test file: give it the one that owns this guarantee";

  const path = join(plugin, file);
  const source = readFileSync(path, "utf8");
  if (source.split(from).length !== 2) return `expected exactly one match in ${file}: update this mutant`;
  writeFileSync(path, source.replace(from, () => to));

  // Code that does not parse fails every test, which would say nothing about the tests.
  if (!parses(path)) return "the mutated code does not parse";

  const { status } = runTests(plugin, tests);
  if (status === 0) return `survived: ${tests.join(" ")} still passes`;
  if (status === null) return `no verdict: ${tests.join(" ")} did not finish within ${TEST_TIMEOUT_MS} ms`;
  return null;
}

const root = mkdtempSync(join(tmpdir(), "proxmox-mutation-"));
let failures = 0;
try {
  const control = runTests(copyRepository(root, "control"), null, CONTROL_TIMEOUT_MS);
  if (control.status === null) throw new Error(`the control did not finish within ${CONTROL_TIMEOUT_MS} ms`);
  if (control.status !== 0) {
    console.error(control.output);
    throw new Error("the unmodified tests fail, so no mutant can prove anything");
  }
  console.log("control: tests pass on the unmodified copy");

  for (const mutant of MUTANTS) {
    const problem = problemWith(mutant, copyRepository(root, mutant.id));
    console.log(`${mutant.id} ${mutant.breaks}: ${problem ?? "caught"}`);
    if (problem) failures++;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} of ${MUTANTS.length} mutants were not caught`);
  process.exitCode = 1;
}
