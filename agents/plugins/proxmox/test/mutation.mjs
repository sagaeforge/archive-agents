// Proves the read-only tests still bite. Each mutant breaks one guarantee in a throwaway copy of the
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

const MUTANTS = [
  { id: "M1", breaks: "requests go out as POST", file: "server/pve.mjs", from: 'method: "GET"', to: 'method: "POST"' },
  { id: "M2", breaks: "the client gains post()", file: "server/pve.mjs", from: GET_ONLY, to: POST_METHOD + GET_ONLY },
  { id: "M3", breaks: "tools stop being read-only", file: "server/tools.mjs", from: "readOnlyHint: true", to: "readOnlyHint: false" },
  { id: "M4", breaks: "the CA pin is dropped", file: "server/pve.mjs", from: "          ca,\n", to: "          rejectUnauthorized: false,\n" },
];

// A developer's shell can hold a real token, and deliberately broken code has no use for one.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PVE_")));

function copyRepository(root, name) {
  const dir = join(root, name);
  cpSync(REPO, dir, { recursive: true, filter: (source) => !NOT_COPIED.has(basename(source)) });
  symlinkSync(join(REPO, PLUGIN, "node_modules"), join(dir, PLUGIN, "node_modules"));
  return join(dir, PLUGIN);
}

function npmTest(cwd) {
  const { status, stdout, stderr } = spawnSync("npm", ["test"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return { status, output: `${stdout}${stderr}` };
}

// Returns why the mutant does not count, or nothing when the tests caught it.
function problemWith({ file, from, to }, plugin) {
  const path = join(plugin, file);
  const source = readFileSync(path, "utf8");
  if (source.split(from).length !== 2) return `expected exactly one match in ${file}: update this mutant`;
  writeFileSync(path, source.replace(from, () => to));

  // Code that does not parse fails every test, which would say nothing about the tests.
  if (spawnSync(process.execPath, ["--check", path]).status !== 0) return "the mutated code does not parse";

  const { status } = npmTest(plugin);
  if (status === 0) return "survived: npm test still passes";
  if (status === null) return `no verdict: npm test did not finish within ${TEST_TIMEOUT_MS} ms`;
  return null;
}

const root = mkdtempSync(join(tmpdir(), "proxmox-mutation-"));
let failures = 0;
try {
  const control = npmTest(copyRepository(root, "control"));
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
