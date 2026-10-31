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

test("every action is pinned to a full commit SHA", () => {
  for (const action of inWorkflows(/^[\s-]*uses:\s*["']?([^\s"']+)/gm)) {
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
    assert.match(install, /^npm ci\b.* --ignore-scripts\b/);
  }
});

test("every workflow gives its token read access by default", () => {
  for (const workflow of WORKFLOWS) {
    assert.match(read(workflow), /^permissions:\n {2}contents: read\n(?! )/m, workflow);
  }
});

test("the Node versions in engines, the CI matrix and .nvmrc agree", () => {
  const [, matrix] = read(".github/workflows/ci.yml").match(/^\s+node: \[([\d, ]+)\]$/m);
  const versions = matrix.split(",").map(Number);

  const { engines } = JSON.parse(read("plugins/proxmox/package.json"));
  assert.equal(engines.node, `>=${Math.min(...versions)}`);
  assert.ok(versions.includes(Number(read(".nvmrc"))), ".nvmrc is not a version CI tests");
});

test("the mutation check runs on one leg of CI, the Node version in .nvmrc", () => {
  const [, condition] = read(".github/workflows/ci.yml").match(/^ +- if: (.+)\n +run: node test\/mutation\.mjs$/m);
  assert.equal(condition, `github.event_name != 'schedule' && matrix.node == ${Number(read(".nvmrc"))}`);
});
