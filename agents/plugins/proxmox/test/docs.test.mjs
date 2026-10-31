// What the runbooks tell people to type. These are read in an emergency and pasted as they stand, so
// the commands get the same care as code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/fake-pve.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path) => readFileSync(join(REPO, path), "utf8");

const DOCS = [
  "README.md",
  "CLAUDE.md",
  "plugins/proxmox/skills/proxmox/SKILL.md",
  ...readdirSync(join(REPO, "docs")).map((file) => `docs/${file}`),
];

// Every line of every fenced shell block, with where it is.
function shellLines() {
  return DOCS.flatMap((path) => {
    let language = null;
    return read(path)
      .split("\n")
      .flatMap((line, index) => {
        const fence = line.trim().match(/^```(\w*)/);
        if (fence) {
          language = language === null ? fence[1] : null;
          return [];
        }
        return ["sh", "bash", "zsh", "console"].includes(language) ? [{ where: `${path}:${index + 1}`, line }] : [];
      });
  });
}

// Whether a line holds a shell comment: a # that starts a word and is not inside quotes.
function hasComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return true;
    }
  }
  return false;
}

test("the comment check finds a comment and leaves the rest alone", () => {
  for (const line of ["# a note", "gh workflow run ci.yml   # a note", "  # indented"]) assert.ok(hasComment(line), line);
  for (const line of ["add owner/repo#stable", "jq '.a # b' file", 'echo "# not one"', "plain"]) assert.ok(!hasComment(line), line);
});

// zsh has interactive_comments off by default. Pasted at a prompt, what follows a # reaches the command
// as arguments: jq takes it for file names and fails, and a comment on a line of its own is run.
test("no command block in the docs holds a comment", () => {
  const lines = shellLines();
  assert.notEqual(lines.length, 0);
  assert.deepEqual(lines.filter(({ line }) => hasComment(line)), []);
});

test("every inbox read in the team guide names its Run", () => {
  const reads = read("docs/team-operations.md").match(/^orca-ide orchestration check .*$/gm);
  assert.equal(reads.length, 2);
  for (const line of reads) assert.match(line, / --run <run_id> /);
  assert.doesNotMatch(read("docs/team-operations.md"), /`check --json`/);
});

test("the failed-install symptom quotes both notes the CLI prints", () => {
  const readme = read("README.md");
  assert.ok(readme.includes("`The packages it lists were not installed, because it needs npm`"));
  assert.ok(readme.includes("`The packages it lists are not installed`"));

  const rehearsal = read("docs/rehearsals.md");
  assert.ok(rehearsal.includes("`The packages it lists`로 시작하는 Note"));
  assert.ok(rehearsal.includes("`were not installed, because it needs npm`"));
});

test("the runbooks revert a merge commit with -m 1 and say how the branch merges", () => {
  const runbook = read("README.md");
  assert.ok(runbook.includes("git revert -m 1 <sha> && git push"));
  assert.ok(runbook.includes("`git merge --no-ff`"));
  assert.ok(read("docs/stable-gate.md").includes("`git revert -m 1 <sha>`"));
});

// Real git, because the runbook's claims are about what git does.
function repository(t) {
  const cwd = tempDir(t);
  const env = {
    PATH: process.env.PATH,
    HOME: cwd,
    GIT_AUTHOR_NAME: "docs",
    GIT_AUTHOR_EMAIL: "docs@example.invalid",
    GIT_COMMITTER_NAME: "docs",
    GIT_COMMITTER_EMAIL: "docs@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const run = (...args) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const git = (...args) => {
    const { status, stdout, stderr } = run(...args);
    assert.equal(status, 0, `git ${args.join(" ")}: ${stderr}`);
    return stdout.trim();
  };
  const commit = (name) => {
    writeFileSync(join(cwd, name), `${name}\n`);
    git("add", "--all");
    git("commit", "--quiet", "--message", name);
  };

  // An integration branch ends in a merge commit of its own, as foundation/integration does.
  git("init", "--quiet", "--initial-branch=main");
  commit("before");
  git("switch", "--quiet", "--create", "integration");
  git("switch", "--quiet", "--create", "goal");
  commit("goal-a");
  git("switch", "--quiet", "integration");
  commit("integration-a");
  git("merge", "--quiet", "--no-ff", "--no-edit", "goal");
  git("switch", "--quiet", "main");
  return { git, run, tree: () => git("rev-parse", "HEAD^{tree}") };
}

test("a merge made with --no-ff goes back to the tree before it with one revert -m 1", (t) => {
  const { git, run, tree } = repository(t);
  const before = tree();
  git("merge", "--quiet", "--no-ff", "--no-edit", "integration");

  assert.equal(git("log", "-1", "--format=%p", "HEAD").split(" ").length, 2);
  assert.notEqual(run("revert", "--no-edit", "HEAD").status, 0);

  git("revert", "--no-edit", "-m", "1", "HEAD");
  assert.equal(tree(), before);
});

test("a fast-forward leaves only the branch's last merge for revert -m 1 to undo", (t) => {
  const { git, tree } = repository(t);
  const before = tree();
  git("merge", "--quiet", "--ff-only", "integration");

  git("revert", "--no-edit", "-m", "1", "HEAD");
  assert.notEqual(tree(), before);
});
