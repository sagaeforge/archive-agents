// The deployment gate, run for real. Every remote here is a bare repository in a temp directory, so
// git's own fast-forward and lease rules are what gets tested. Only claude, npm, gh and the secret
// scan are fakes, and nothing here can reach GitHub.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const PROMOTE = join(REPO, ".github/scripts/promote.sh");
const ROLLBACK = join(REPO, ".github/scripts/rollback.sh");
const HOOKS = join(REPO, ".githooks");

// pre-push runs npm test, and in a linked worktree git exports GIT_DIR to hooks. With that still set,
// `git init` below would land on the real repository.
const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"));
const env = {
  ...Object.fromEntries(inherited),
  GIT_AUTHOR_NAME: "gate",
  GIT_AUTHOR_EMAIL: "gate@example.invalid",
  GIT_COMMITTER_NAME: "gate",
  GIT_COMMITTER_EMAIL: "gate@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const root = mkdtempSync(join(tmpdir(), "proxmox-gate-"));
after(() => rmSync(root, { recursive: true, force: true }));

let fixtures = 0;
let commits = 0;

const run = (command, args, options) => spawnSync(command, args, { encoding: "utf8", env, ...options });

function git(cwd, ...args) {
  const { status, stdout, stderr } = run("git", args, { cwd });
  assert.equal(status, 0, `git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

function repositories() {
  const dir = join(root, String(fixtures++));
  const origin = join(dir, "origin.git");
  const dev = join(dir, "dev");
  mkdirSync(dir);
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(dir, "init", "--quiet", "--initial-branch=main", dev);
  git(dev, "remote", "add", "origin", origin);
  return { dir, origin, dev };
}

function commit(dev, path = "file", content = `${commits++}\n`) {
  const file = join(dev, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  git(dev, "add", "--all");
  git(dev, "commit", "--quiet", "--message", `change ${path}`);
  return git(dev, "rev-parse", "HEAD");
}

const tip = (origin, branch) =>
  run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: origin }).stdout.trim();

// main is one commit ahead of stable, which is where every CI run starts.
function ahead() {
  const repos = repositories();
  const { dev } = repos;
  const released = commit(dev);
  git(dev, "push", "--quiet", "origin", `${released}:refs/heads/stable`);
  const passed = commit(dev);
  git(dev, "push", "--quiet", "origin", `${passed}:refs/heads/main`);
  return { ...repos, released, passed };
}

const promote = (dev, sha) => run(PROMOTE, [sha], { cwd: dev });

test("promote fast-forwards stable to the commit CI passed", () => {
  const { origin, dev, passed } = ahead();
  const { status, stderr } = promote(dev, passed);
  assert.equal(status, 0, stderr);
  assert.equal(tip(origin, "stable"), passed);
});

test("promote never creates stable", () => {
  const { origin, dev } = repositories();
  const passed = commit(dev);
  git(dev, "push", "--quiet", "origin", `${passed}:refs/heads/main`);

  const { status, stdout } = promote(dev, passed);
  assert.notEqual(status, 0);
  assert.match(stdout, /never creates/);
  assert.equal(tip(origin, "stable"), "");
});

test("promote leaves stable alone when main has moved on", () => {
  const { origin, dev, released, passed } = ahead();
  const newer = commit(dev);
  git(dev, "push", "--quiet", "origin", `${newer}:refs/heads/main`);

  const { status, stdout } = promote(dev, passed);
  assert.equal(status, 0);
  assert.match(stdout, /its own run decides/);
  assert.equal(tip(origin, "stable"), released);
});

test("promote does nothing when stable already has the commit", () => {
  const { origin, dev, passed } = ahead();
  git(dev, "push", "--quiet", "origin", `${passed}:refs/heads/stable`);
  const { status, stdout } = promote(dev, passed);
  assert.equal(status, 0);
  assert.match(stdout, /already contains/);
  assert.equal(tip(origin, "stable"), passed);
});

test("promote refuses to rewrite a stable that left main's history", () => {
  const { origin, dev, released, passed } = ahead();
  git(dev, "checkout", "--quiet", "--detach", released);
  const pushedByHand = commit(dev);
  git(dev, "push", "--quiet", "origin", `${pushedByHand}:refs/heads/stable`);

  assert.notEqual(promote(dev, passed).status, 0);
  assert.equal(tip(origin, "stable"), pushedByHand);
});

test("promote warns about workflow changes and leaves stable alone if GitHub refuses them", () => {
  const { origin, dev, released } = ahead();
  const changed = commit(dev, ".github/workflows/ci.yml");
  git(dev, "push", "--quiet", "origin", `${changed}:refs/heads/main`);
  writeFileSync(
    join(origin, "hooks/pre-receive"),
    "#!/bin/sh\necho 'refusing to allow a GitHub App to update workflow without `workflows` permission' >&2\nexit 1\n",
    { mode: 0o755 },
  );

  const { status, stdout } = promote(dev, changed);
  assert.notEqual(status, 0);
  assert.match(stdout, /::warning::.*\.github\/workflows.*docs\/stable-gate\.md/);
  assert.equal(tip(origin, "stable"), released);
});

test("promote does not warn when no workflow changed", () => {
  const { dev, passed } = ahead();
  assert.doesNotMatch(promote(dev, passed).stdout, /::warning::/);
});

// stable is two commits ahead of the last good one, and main with it.
function deployed() {
  const repos = repositories();
  const { dir, dev } = repos;
  const good = commit(dev);
  const middle = commit(dev);
  const bad = commit(dev);
  git(dev, "push", "--quiet", "origin", `${bad}:refs/heads/main`, `${bad}:refs/heads/stable`);

  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >"${bin}/gh.args"\necho "\${GATE_CI_PASSES-1}"\n`, { mode: 0o755 });
  const rollback = (sha, extra = {}) =>
    run(ROLLBACK, [sha], { cwd: dev, env: { ...env, PATH: `${bin}${delimiter}${env.PATH}`, ...extra } });
  return { ...repos, bin, good, middle, bad, rollback };
}

test("rollback moves stable back to a commit that passed CI", () => {
  const { origin, bin, good, rollback } = deployed();
  const { status, stdout, stderr } = rollback(good);
  assert.equal(status, 0, stderr);
  assert.equal(tip(origin, "stable"), good);
  assert.match(stdout, /Revert the cause on main/);
  assert.equal(
    readFileSync(join(bin, "gh.args"), "utf8").trim(),
    `run list --workflow ci.yml --commit ${good} --status success --json databaseId --jq length`,
  );
});

test("rollback refuses a commit CI never passed", () => {
  const { origin, bad, good, rollback } = deployed();
  // Empty is what a confused gh would print, and it must not count as a pass.
  for (const passes of ["0", ""]) {
    const { status, stdout } = rollback(good, { GATE_CI_PASSES: passes });
    assert.notEqual(status, 0, `passes=${passes}`);
    assert.match(stdout, /CI never passed/);
    assert.equal(tip(origin, "stable"), bad);
  }
});

test("rollback never creates stable", () => {
  const { origin, good, rollback } = deployed();
  git(origin, "update-ref", "-d", "refs/heads/stable");
  const { status, stdout } = rollback(good);
  assert.notEqual(status, 0);
  assert.match(stdout, /never creates/);
  assert.equal(tip(origin, "stable"), "");
});

test("rollback refuses anything but a full SHA and does not echo it", () => {
  const { origin, bad, rollback } = deployed();
  for (const input of ["", "main", bad.slice(0, 12), `${bad}\n`, "::set-env name=X::1", bad.toUpperCase()]) {
    const { status, stdout } = rollback(input);
    assert.notEqual(status, 0, input);
    assert.match(stdout, /^::error::Expected a full 40-character commit SHA\.\n$/);
  }
  assert.equal(tip(origin, "stable"), bad);
});

test("rollback cannot be used to skip the gate by moving stable forward", () => {
  const { origin, dev, bad, rollback } = deployed();
  const untested = commit(dev);
  git(dev, "push", "--quiet", "origin", `${untested}:refs/heads/main`);

  const { status, stdout } = rollback(untested);
  assert.notEqual(status, 0);
  assert.match(stdout, /not an earlier commit of stable/);
  assert.equal(tip(origin, "stable"), bad);
});

test("rollback refuses a commit that is not on main, which would stop later promotions", () => {
  const { origin, dev, good, rollback } = deployed();
  git(dev, "checkout", "--quiet", "--detach", good);
  const offMain = commit(dev);
  const onTop = commit(dev);
  git(dev, "push", "--quiet", "--force", "origin", `${onTop}:refs/heads/stable`);

  const { status, stdout } = rollback(offMain);
  assert.notEqual(status, 0);
  assert.match(stdout, /not on main/);
  assert.equal(tip(origin, "stable"), onTop);
});

test("rollback loses to anything that moved stable after it looked", () => {
  const { origin, bin, good, middle, rollback } = deployed();
  const realGit = run("sh", ["-c", "command -v git"]).stdout.trim();
  // Stands in for a promotion landing in the gap between reading stable and pushing.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = push ]; then "${realGit}" -C "${origin}" update-ref refs/heads/stable ${middle}; fi\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );

  assert.notEqual(rollback(good).status, 0);
  assert.equal(tip(origin, "stable"), middle);
});

test("promotion carries on from a rollback once main has the revert", () => {
  const { origin, dev, good, rollback } = deployed();
  assert.equal(rollback(good).status, 0);
  const revert = commit(dev);
  git(dev, "push", "--quiet", "origin", `${revert}:refs/heads/main`);

  assert.equal(promote(dev, revert).status, 0);
  assert.equal(tip(origin, "stable"), revert);
});

const FAKE_TOOL = `#!/bin/sh
tool=$(basename "$0")
echo "$tool $*" >>"$GATE_LOG"
env | grep '^GIT_DIR=' >>"$GATE_LOG"
test ! -e "fail-$tool"
`;
const FAKE_SCAN = `#!/bin/sh
echo gitleaks >>"$GATE_LOG"
test -z "$GATE_FAIL_SCAN"
`;

// A clone that uses the real hook, with main pushed and the checks replaced by the fakes above. A
// file named fail-claude or fail-npm in the commit being checked makes that tool fail.
function hooked() {
  const repos = repositories();
  const { dir, dev } = repos;
  const bin = join(dir, "bin");
  const log = join(dir, "log");
  mkdirSync(bin);
  for (const tool of ["claude", "npm"]) writeFileSync(join(bin, tool), FAKE_TOOL, { mode: 0o755 });
  mkdirSync(join(dev, ".github/scripts"), { recursive: true });
  writeFileSync(join(dev, ".github/scripts/gitleaks.sh"), FAKE_SCAN, { mode: 0o755 });
  commit(dev, "plugins/proxmox/package.json", "{}\n");
  git(dev, "push", "--quiet", "origin", "main");
  git(dev, "config", "core.hooksPath", HOOKS);

  const push = (args, { cwd = dev, ...extra } = {}) =>
    run("git", ["push", "--quiet", "origin", ...args], {
      cwd,
      env: { ...env, PATH: `${bin}${delimiter}${env.PATH}`, GATE_LOG: log, ...extra },
    });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { ...repos, push, calls };
}

test("the hook refuses a push to stable", () => {
  const { origin, push, calls } = hooked();
  const { status, stderr } = push(["main:stable"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /stable moves only through CI/);
  assert.equal(tip(origin, "stable"), "");
  assert.deepEqual(calls(), []);
});

test("the hook refuses to delete stable", () => {
  const { origin, push } = hooked();
  const main = tip(origin, "main");
  git(origin, "update-ref", "refs/heads/stable", main);

  assert.notEqual(push([":stable"]).status, 0);
  assert.equal(tip(origin, "stable"), main);
});

test("the hook refuses a push that names stable alongside main", () => {
  const { origin, dev, push } = hooked();
  const before = tip(origin, "main");
  commit(dev);

  assert.notEqual(push(["main", "main:stable"]).status, 0);
  assert.equal(tip(origin, "main"), before);
  assert.equal(tip(origin, "stable"), "");
});

test("the hook runs every check on a push to main", () => {
  const { origin, dev, push, calls } = hooked();
  const pushed = commit(dev);
  const { status, stderr } = push(["main"]);
  assert.equal(status, 0, stderr);
  assert.equal(tip(origin, "main"), pushed);
  assert.deepEqual(calls(), [
    "claude plugin validate .",
    "claude plugin validate plugins/proxmox",
    "npm ci --ignore-scripts --no-audit --no-fund",
    "npm test",
    "gitleaks",
  ]);
});

test("the hook stops a push to main when any check fails", () => {
  for (const [marker, extra] of [
    ["fail-claude", {}],
    ["plugins/proxmox/fail-npm", {}],
    ["harmless", { GATE_FAIL_SCAN: "1" }],
  ]) {
    const { origin, dev, push } = hooked();
    const before = tip(origin, "main");
    commit(dev, marker);
    assert.notEqual(push(["main"], extra).status, 0, marker);
    assert.equal(tip(origin, "main"), before, marker);
  }
});

test("the hook checks the commit being pushed, not the working tree", () => {
  const { origin, dev, push } = hooked();
  const before = tip(origin, "main");
  commit(dev, "plugins/proxmox/fail-npm");
  // The fix exists only here, so the commit about to be pushed still fails.
  rmSync(join(dev, "plugins/proxmox/fail-npm"));

  assert.notEqual(push(["main"]).status, 0);
  assert.equal(tip(origin, "main"), before);
});

test("the hook ignores breakage that is not part of the commit", () => {
  const { dev, push } = hooked();
  commit(dev);
  writeFileSync(join(dev, "plugins/proxmox/fail-npm"), "uncommitted\n");
  const { status, stderr } = push(["main"]);
  assert.equal(status, 0, stderr);
});

test("the hook leaves other branches to CI", () => {
  const { dev, push, calls } = hooked();
  git(dev, "switch", "--quiet", "--create", "feature");
  commit(dev, "plugins/proxmox/fail-npm");

  assert.equal(push(["feature"]).status, 0);
  assert.deepEqual(calls(), []);
});

test("the hook keeps a linked worktree's GIT_DIR away from the checks", () => {
  const { dir, dev, push, calls } = hooked();
  const worktree = join(dir, "worktree");
  git(dev, "worktree", "add", "--quiet", "-b", "side", worktree);
  commit(worktree);

  const { status, stderr } = push(["side:main"], { cwd: worktree });
  assert.equal(status, 0, stderr);
  assert.notEqual(calls().length, 0);
  assert.deepEqual(calls().filter((line) => line.startsWith("GIT_DIR=")), []);
});

const workflow = (name) => readFileSync(join(REPO, ".github/workflows", name), "utf8");

function job(text, name) {
  const block = text.match(new RegExp(`^ {2}${name}:\\n((?:(?: {4}.*)?\\n)+)`, "m"));
  assert.ok(block, `no ${name} job`);
  return block[1];
}

test("promote needs check to pass and the owner to have turned the gate on", () => {
  const promoteJob = job(workflow("ci.yml"), "promote");
  assert.match(promoteJob, /^ {4}needs: check$/m);
  assert.match(promoteJob, /^ {4}if: vars\.STABLE_GATE_ENABLED == 'true' && github\.ref == 'refs\/heads\/main'$/m);
});

test("promote moves stable to the commit that was tested, not to wherever main is now", () => {
  assert.match(job(workflow("ci.yml"), "promote"), /run: \.github\/scripts\/promote\.sh "\$GITHUB_SHA"$/m);
});

test("only promote and rollback can write, and they share a concurrency group", () => {
  const ci = workflow("ci.yml");
  const rollback = workflow("rollback.yml");
  for (const text of [job(ci, "promote"), job(rollback, "rollback")]) {
    assert.match(text, /^ {6}contents: write$/m);
    assert.match(text, /^ {4}concurrency: promote\b/m);
  }
  assert.doesNotMatch(job(ci, "check"), /write/);
  assert.equal([...`${ci}${rollback}`.matchAll(/: write$/gm)].length, 2);
});

test("rollback runs only when asked, and only from main", () => {
  const rollback = workflow("rollback.yml");
  assert.match(rollback, /^on:\n {2}workflow_dispatch:\n(?: {4}.*\n)+\npermissions:/m);
  assert.match(job(rollback, "rollback"), /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
});

test("the form's value reaches rollback.sh through the environment, never the script text", () => {
  const steps = job(workflow("rollback.yml"), "rollback");
  assert.match(steps, /^ {10}TARGET: \$\{\{ inputs\.sha \}\}$/m);
  assert.equal([...steps.matchAll(/inputs\./g)].length, 1);
});
