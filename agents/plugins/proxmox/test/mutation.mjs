// Proves the tests still bite. Each mutant breaks one guarantee in a throwaway copy of the
// repository, and npm test has to fail there. A mutant that no longer applies counts as a failure,
// so a refactor cannot quietly disarm this check.
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
const SMOKE = "test/smoke/live.mjs";
const GATE_TESTS = ["test/gate.test.mjs"];
const SMOKE_TESTS = ["test/live-smoke.test.mjs"];
const REFUSE_STABLE = `    refs/heads/stable)
      echo "pre-push: stable moves only through CI. Push to main; see docs/stable-gate.md." >&2
      exit 1
      ;;
`;

const MUTANTS = [
  { id: "M1", breaks: "requests go out as POST", file: "server/pve.mjs", from: 'method: "GET"', to: 'method: "POST"' },
  { id: "M2", breaks: "the client gains post()", file: "server/pve.mjs", from: GET_ONLY, to: POST_METHOD + GET_ONLY },
  { id: "M3", breaks: "tools stop being read-only", file: "server/tools.mjs", from: "readOnlyHint: true", to: "readOnlyHint: false" },
  { id: "M4", breaks: "the CA pin is dropped", file: "server/pve.mjs", from: "          ca,\n", to: "          rejectUnauthorized: false,\n" },
  { id: "G1", breaks: "promote stops waiting for check and the smoke", file: CI, from: "    needs: [check, live-smoke]\n", to: "" },
  { id: "G2", breaks: "promote runs before the owner turns the gate on", file: CI, from: "vars.STABLE_GATE_ENABLED == 'true' && ", to: "" },
  { id: "G3", breaks: "promote forces stable", file: PROMOTE, from: 'git push origin "$sha', to: 'git push --force origin "$sha' },
  { id: "G4", breaks: "promote creates stable", file: PROMOTE, from: "if [[ -z $stable ]]; then", to: 'if [[ -z $stable ]]; then git push origin "$sha:refs/heads/stable"; exit 0; fi; if false; then' },
  { id: "G5", breaks: "promote acts on a stale run", file: PROMOTE, from: 'if [[ $sha != "$main" ]]; then', to: "if false; then" },
  { id: "G6", breaks: "rollback can move stable forward", file: ROLLBACK, from: 'if ! git merge-base --is-ancestor "$sha" "$stable"; then', to: "if false; then" },
  { id: "G7", breaks: "rollback accepts a commit off main", file: ROLLBACK, from: 'if ! git merge-base --is-ancestor "$sha" "$main"; then', to: "if false; then" },
  { id: "G8", breaks: "rollback accepts a commit that failed CI", file: ROLLBACK, from: "if [[ $passed -lt 1 ]]; then", to: "if false; then" },
  { id: "G9", breaks: "rollback drops its lease", file: ROLLBACK, from: '--force-with-lease="refs/heads/stable:$stable"', to: "--force" },
  { id: "G10", breaks: "the hook lets stable through", file: HOOK, from: REFUSE_STABLE, to: "" },
  { id: "G11", breaks: "the hook checks the working tree", file: HOOK, from: 'git archive "$target" | tar -x -C "$work"', to: 'cp -R . "$work"' },
  { id: "G12", breaks: "the hook hands GIT_DIR to the checks", file: HOOK, from: 'unset "${git_vars[@]}"\n', to: "" },
  { id: "G13", breaks: "a failed check no longer stops promote", file: CI, from: "      && needs.check.result == 'success'\n", to: "", tests: GATE_TESTS },
  { id: "G14", breaks: "a failed smoke no longer stops promote", file: CI, from: "needs.live-smoke.result == 'success'", to: "needs.live-smoke.result != 'cancelled'", tests: GATE_TESTS },
  { id: "G15", breaks: "the weekly run promotes", file: CI, from: " && github.event_name != 'schedule'", to: "", tests: GATE_TESTS },
  { id: "G16", breaks: "a cancelled run still promotes", file: CI, from: "!cancelled() && ", to: "always() && ", tests: GATE_TESTS },
  { id: "G17", breaks: "pull requests reach the runner", file: CI, from: "github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && !inputs.skip_smoke", to: "!inputs.skip_smoke", tests: GATE_TESTS },
  { id: "G18", breaks: "the smoke waits for a runner nobody has turned on", file: CI, from: "if: vars.LIVE_SMOKE_ENABLED == 'true' && ", to: "if: ", tests: GATE_TESTS },
  { id: "L1", breaks: "the smoke prints the text of a tool error", file: SMOKE, from: '?.[0] ?? "tool error"', to: "?.[0] ?? text", tests: SMOKE_TESTS },
  { id: "L2", breaks: "the smoke accepts privileges beyond .Audit", file: SMOKE, from: "expect(excess === 0,", to: "expect(true,", tests: SMOKE_TESTS },
  { id: "L3", breaks: "the smoke accepts a token with no privileges", file: SMOKE, from: "expect(held.size > 0,", to: "expect(true,", tests: SMOKE_TESTS },
  { id: "L4", breaks: "an outage reads as a plugin failure", file: SMOKE, from: "answered: !NO_ANSWER.has(code)", to: "answered: true", tests: SMOKE_TESTS },
  { id: "L5", breaks: "a certificate failure reads as an outage", file: SMOKE, from: "answered: !NO_ANSWER.has(code)", to: "answered: false", tests: SMOKE_TESTS },
  { id: "L6", breaks: "the weekly run ignores certificates about to expire", file: SMOKE, from: 'process.env.GITHUB_EVENT_NAME === "schedule" ? EXPIRY_WARNING_DAYS : 0', to: "0", tests: SMOKE_TESTS },
  { id: "L7", breaks: "a server's stderr reaches the log", file: SMOKE, from: 'stderr: "ignore",', to: 'stderr: "inherit",', tests: SMOKE_TESTS },
];

// A developer's shell can hold a real token, and deliberately broken code has no use for one.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PVE_")));

function copyRepository(root, name) {
  const dir = join(root, name);
  cpSync(REPO, dir, { recursive: true, filter: (source) => !NOT_COPIED.has(basename(source)) });
  symlinkSync(join(REPO, PLUGIN, "node_modules"), join(dir, PLUGIN, "node_modules"));
  return join(dir, PLUGIN);
}

// CI runs this on every Node version, so a mutant that names its test file spares each leg a full
// run. Failing there is failing npm test.
function runTests(cwd, files) {
  const [command, args] = files ? [process.execPath, ["--test", ...files]] : ["npm", ["test"]];
  const { status, stdout, stderr } = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return { status, output: `${stdout}${stderr}` };
}

function parses(path) {
  if (path.endsWith(".yml")) return true; // The tests read workflows as text, so any text will do.
  const [command, ...args] = path.endsWith(".mjs") ? [process.execPath, "--check"] : ["bash", "-n"];
  return spawnSync(command, [...args, path]).status === 0;
}

// Returns why the mutant does not count, or nothing when the tests caught it.
function problemWith({ file, from, to, tests }, plugin) {
  const path = join(plugin, file);
  const source = readFileSync(path, "utf8");
  if (source.split(from).length !== 2) return `expected exactly one match in ${file}: update this mutant`;
  writeFileSync(path, source.replace(from, () => to));

  // Code that does not parse fails every test, which would say nothing about the tests.
  if (!parses(path)) return "the mutated code does not parse";

  const { status } = runTests(plugin, tests);
  if (status === 0) return "survived: npm test still passes";
  if (status === null) return `no verdict: npm test did not finish within ${TEST_TIMEOUT_MS} ms`;
  return null;
}

const root = mkdtempSync(join(tmpdir(), "proxmox-mutation-"));
let failures = 0;
try {
  const control = runTests(copyRepository(root, "control"));
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
