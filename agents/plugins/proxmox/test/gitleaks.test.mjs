// The secret scan's flow. The script and git are real, so what git log hands a scanner here is what the
// real gitleaks reads. Only the download is fake: it delivers a stand-in that looks for MARKER in what
// each scan mode can see, which is all a test without a network can do. The real binary's own rules
// are checked by the script's canaries, every time it runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(REPO, ".github/scripts/gitleaks.sh");
const MARKER = "marker-for-a-leak";

const FAKE_GITLEAKS = `#!/bin/bash
mode=$1
shift
printf '%s %s\\n' "$mode" "$*" >>"$SCAN_LOG"
repo=\${!#}
case $mode in
  stdin)
    text=$(cat)
    if [[ -n \${SCAN_MISS:-} && $text == *"$SCAN_MISS"* ]]; then exit 0; fi
    [[ $text == *${MARKER}* || $text == *canary* || $text == value:* || $text == ghp_* ]] && exit 1
    exit 0
    ;;
  git)
    for arg; do [[ $arg == --log-opts=* ]] && opts=\${arg#--log-opts=}; done
    # shellcheck disable=SC2086
    git -C "$repo" log -p -U0 $opts | grep -qa ${MARKER} && exit 1
    exit 0
    ;;
  dir)
    grep -qra ${MARKER} "$repo" && exit 1
    exit 0
    ;;
esac
exit 64
`;
const FAKE_CURL = `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = -o ]; then out=$2; fi
  shift
done
cp "$FAKE_ARCHIVE" "$out"
`;
const FAKE_SHA256SUM = `#!/bin/sh
cat >/dev/null
`;

const root = mkdtempSync(join(tmpdir(), "proxmox-scan-"));
after(() => rmSync(root, { recursive: true, force: true }));

const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(join(root, "gitleaks"), FAKE_GITLEAKS, { mode: 0o755 });
writeFileSync(join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
writeFileSync(join(bin, "sha256sum"), FAKE_SHA256SUM, { mode: 0o755 });
const archive = join(root, "archive.tar.gz");
spawnSync("tar", ["-czf", archive, "-C", root, "gitleaks"]);

const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"));
const env = {
  ...Object.fromEntries(inherited),
  PATH: `${bin}${delimiter}${process.env.PATH}`,
  FAKE_ARCHIVE: archive,
  GIT_AUTHOR_NAME: "scan",
  GIT_AUTHOR_EMAIL: "scan@example.invalid",
  GIT_COMMITTER_NAME: "scan",
  GIT_COMMITTER_EMAIL: "scan@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

let repositories = 0;

// A repository with the real script and rules in it, and one clean commit.
function repository() {
  const dir = join(root, `repo-${repositories++}`);
  mkdirSync(join(dir, ".github/scripts"), { recursive: true });
  const script = join(dir, ".github/scripts/gitleaks.sh");
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);
  copyFileSync(join(REPO, ".gitleaks.toml"), join(dir, ".gitleaks.toml"));
  const log = `${dir}.log`;

  const git = (...args) => {
    const { status, stdout, stderr } = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(status, 0, `git ${args.join(" ")}: ${stderr}`);
    return stdout.trim();
  };
  const commit = (path, content, message = `change ${path}`) => {
    writeFileSync(join(dir, path), content);
    git("add", "--all");
    git("commit", "--quiet", "--message", message);
    return git("rev-parse", "HEAD");
  };
  const scan = (args = [], extra = {}) =>
    spawnSync(script, args, { cwd: dir, env: { ...env, SCAN_LOG: log, ...extra }, encoding: "utf8" });
  const calls = () => readFileSync(log, "utf8").trim().split("\n");

  git("init", "--quiet", "--initial-branch=main");
  commit("file", "base\n");
  return { dir, git, commit, scan, calls };
}

test("a clean repository passes, after every canary has fired", () => {
  const { scan, calls } = repository();
  const { status, stderr } = scan();
  assert.equal(status, 0, stderr);
  assert.equal(calls().filter((call) => call.startsWith("stdin ")).length, 4);
});

test("a secret in an ordinary commit is found", () => {
  const { commit, scan } = repository();
  commit("leak", `${MARKER}\n`);
  assert.notEqual(scan().status, 0);
});

test("a secret that entered through a conflict resolved in a merge commit is found", () => {
  const { dir, git, commit, scan } = repository();
  git("switch", "--quiet", "--create", "side");
  commit("file", "side\n");
  git("switch", "--quiet", "main");
  commit("file", "main\n");
  spawnSync("git", ["merge", "side"], { cwd: dir, env });
  // Gone again at the tip, so that nothing but the merge commit's own diff can show it.
  writeFileSync(join(dir, "file"), `${MARKER}\n`);
  git("add", "--all");
  git("commit", "--quiet", "--no-edit");
  assert.equal(git("rev-list", "--merges", "--count", "HEAD"), "1");
  commit("file", "clean again\n");

  assert.notEqual(scan().status, 0);
});

test("a secret in a file added during a merge is found", () => {
  const { dir, git, commit, scan } = repository();
  git("switch", "--quiet", "--create", "side");
  commit("side", "side\n");
  git("switch", "--quiet", "main");
  commit("main", "main\n");
  git("merge", "--quiet", "--no-commit", "--no-ff", "side");
  writeFileSync(join(dir, "stray"), `${MARKER}\n`);
  git("add", "--all");
  git("commit", "--quiet", "--no-edit");
  git("rm", "--quiet", "stray");
  git("commit", "--quiet", "--message", "remove it");

  assert.notEqual(scan().status, 0);
});

test("a secret in a commit message is found", () => {
  const { commit, scan } = repository();
  commit("file", "clean\n", `oops ${MARKER}`);
  assert.notEqual(scan().status, 0);
});

test("a secret in a file git calls binary is found", () => {
  const { commit, scan } = repository();
  commit("blob", Buffer.from(`\0\0\0${MARKER}\n`));
  assert.notEqual(scan().status, 0);
});

for (const [canary, missed] of [
  ["PVE token", "ci@pve!canary"],
  ["pveum output", "value: "],
  ["default rule", "ghp_"],
]) {
  test(`a rule that stops firing fails the scan: ${canary}`, () => {
    const { scan } = repository();
    const { status, stderr } = scan([], { SCAN_MISS: missed });
    assert.notEqual(status, 0);
    assert.match(stderr, new RegExp(`missed the canary ${canary}, so a clean result would mean nothing`));
  });
}

test("given a commit, the scan reads what that commit can reach and leaves other branches alone", () => {
  const { dir, git, commit, scan } = repository();
  const clean = git("rev-parse", "HEAD");
  git("switch", "--quiet", "--create", "wip");
  commit("leak", `${MARKER}\n`);
  git("switch", "--quiet", "main");

  const { status, stderr } = scan([dir, clean]);
  assert.equal(status, 0, stderr);
  assert.notEqual(scan().status, 0);
});

test("given a commit with a secret, the scan finds it", () => {
  const { dir, git, commit, scan } = repository();
  const leak = commit("leak", `${MARKER}\n`);
  git("rm", "--quiet", "leak");
  git("commit", "--quiet", "--message", "gone");
  assert.notEqual(scan([dir, leak]).status, 0);
});

test("the rules come from next to the script", () => {
  const { dir, scan, calls } = repository();
  scan();
  for (const call of calls()) assert.ok(call.includes(`--config ${dir}/.github/scripts/../../.gitleaks.toml`), call);
});

test("findings stay redacted in every mode, because GitHub keeps the log", () => {
  const { scan, calls } = repository();
  scan();
  assert.deepEqual([...new Set(calls().map((call) => call.split(" ")[0]))].sort(), ["dir", "git", "stdin"]);
  for (const call of calls()) assert.match(call, / --redact /);
});

test("a shallow clone stops the scan, which would pass after reading one commit", () => {
  const { dir, commit, scan } = repository();
  commit("file", "newer\n");
  const clone = `${dir}-shallow`;
  const { status } = spawnSync("git", ["clone", "--quiet", "--depth", "1", `file://${dir}`, clone], { env });
  assert.equal(status, 0);
  assert.notEqual(scan([clone, "HEAD"]).status, 0);
});

test("the download is pinned and checked", () => {
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /^VERSION="\d+\.\d+\.\d+"$/m);
  assert.match(script, /^SHA256="[0-9a-f]{64}"$/m);
  assert.match(script, /sha256sum --check --strict --quiet -$/m);
});
