// Repository rules that only a person would otherwise notice breaking. These sit in npm test so
// they run before a push as well as in CI. `claude plugin validate` even suggests adding a version.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path) => readFileSync(join(REPO, path), "utf8");

const MANIFESTS = [
  ".claude-plugin/marketplace.json",
  ...readdirSync(join(REPO, "plugins")).map((plugin) => `plugins/${plugin}/.claude-plugin/plugin.json`),
];
const WORKFLOWS = readdirSync(join(REPO, ".github/workflows"))
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => `.github/workflows/${file}`);

// Every match in every workflow. Each caller also needs at least one, or its rule checked nothing.
function inWorkflows(pattern) {
  const found = WORKFLOWS.flatMap((file) => [...read(file).matchAll(pattern)].map((match) => match[1]));
  assert.notEqual(found.length, 0, `nothing in ${WORKFLOWS} matches ${pattern}`);
  return found;
}

function versionKeys(value, path = "") {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === "version" ? [`${path}.version`] : []),
    ...versionKeys(child, `${path}.${key}`),
  ]);
}

test("no manifest sets a version, which would silently stop updates", () => {
  assert.ok(MANIFESTS.includes("plugins/proxmox/.claude-plugin/plugin.json"));
  for (const manifest of MANIFESTS) {
    assert.deepEqual(versionKeys(JSON.parse(read(manifest))), [], manifest);
  }
});

// By what an action reference looks like and not by the key before it, because YAML has several ways
// to spell that key: `- uses : x`, `- "uses": x`, `- { uses: x }`.
test("every action is pinned to a full commit SHA", () => {
  const references = inWorkflows(/([\w.-]+\/[\w./-]+@[^\s"',}]+)/g).filter((reference) => !reference.startsWith("anthropic-ai/"));
  assert.notEqual(references.length, 0);
  for (const action of references) {
    assert.match(action, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  }
});

test("CI runs one exact version of the Claude Code CLI", () => {
  for (const cli of inWorkflows(/(@anthropic-ai\/claude-code\S*)/g)) {
    assert.match(cli, /^@anthropic-ai\/claude-code@\d+\.\d+\.\d+$/);
  }
});

test("CI installs dependencies without running their scripts", () => {
  for (const install of inWorkflows(/(\bnpm (?:ci|install|i)\b.*)/g)) {
    assert.match(install, /^npm ci\b.* --ignore-scripts(?:\s|$)/);
  }
});

test("every workflow gives its token read access by default", () => {
  for (const workflow of WORKFLOWS) {
    assert.match(read(workflow), /^permissions:\n {2}contents: read\n(?! )/m, workflow);
  }
});

test("only the two jobs that write ask for more than the default", () => {
  for (const workflow of WORKFLOWS) assert.doesNotMatch(read(workflow), /\b(?:write|read)-all\b/, workflow);

  const grants = WORKFLOWS.flatMap((file) =>
    [...read(file).matchAll(/^ {4}permissions:\n((?: {6}.+\n)+)/gm)].map(([, block]) => block.replace(/ *#.*/g, "").replace(/\s+/g, " ").trim()),
  );
  assert.deepEqual(grants.sort(), ["actions: read contents: write", "contents: write"]);
});

test("the check job keeps no credentials, and uses the Node of its matrix leg", () => {
  const ci = read(".github/workflows/ci.yml");
  const check = ci.slice(ci.indexOf("  check:\n"), ci.indexOf("  live-smoke:\n"));
  assert.match(check, /^ {10}persist-credentials: false\b/m);
  assert.match(check, /^ {10}node-version: \$\{\{ matrix\.node \}\}$/m);
});

test("the Node versions in engines, the CI matrix and .nvmrc agree", () => {
  const [, matrix] = read(".github/workflows/ci.yml").match(/^\s+node: \[([\d, ]+)\]$/m);
  const versions = matrix.split(",").map(Number);

  const { engines } = JSON.parse(read("plugins/proxmox/package.json"));
  assert.equal(engines.node, `>=${Math.min(...versions)}`);
  assert.ok(versions.includes(Number(read(".nvmrc"))), ".nvmrc is not a version CI tests");
});

test("the mutation check's control has room for the whole suite, inside the job's own limit", () => {
  const source = read("plugins/proxmox/test/mutation.mjs");
  const limit = (name) => Number(source.match(new RegExp(`^const ${name} = ([\\d_]+);$`, "m"))[1].replaceAll("_", ""));
  const [, jobMinutes] = read(".github/workflows/ci.yml").match(/^  check:\n.*\n +timeout-minutes: (\d+)$/m);
  assert.ok(limit("CONTROL_TIMEOUT_MS") >= 3 * limit("TEST_TIMEOUT_MS"), "npm test alone is near a mutant's limit");
  assert.ok(limit("CONTROL_TIMEOUT_MS") < Number(jobMinutes) * 60_000, "the job would end before the control's own message");
  assert.match(source, /runTests\(copyRepository\(root, "control"\), null, CONTROL_TIMEOUT_MS\)/);
});

test("the mutation check runs on one leg of CI, the Node version in .nvmrc", () => {
  const [, condition] = read(".github/workflows/ci.yml").match(/^ +- if: (.+)\n +run: node test\/mutation\.mjs$/m);
  assert.equal(condition, `github.event_name != 'schedule' && matrix.node == ${Number(read(".nvmrc"))}`);
});
