import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "bootstrap-token.sh");
const FAKES = join(ROOT, "test", "fakes");

const USER = "claude-mcp@pve";
const MONTH = "202611";
const EPOCH = 1_800_000_000;
const ID = `m-sagae-windows-${MONTH}`;
const OLD_ID = "m-sagae-windows-202511";
const OLD_SECRET = "old-secret-value";
const SIGNAL_STATUS = { HUP: 129, INT: 130, TERM: 143 };

// Everything a run must not get from the machine running the tests. Named here, not
// read from test/fakes, so a fake that goes missing stops the sandbox from building.
const FAKED = ["curl", "date", "hostname", "injected", "pveum", "record", "ssh", "uname"];

// The only real programs a run can find. ssh, curl, and anything else that could
// reach a node are left out on purpose, because PATH holds nothing beyond this.
const REAL_TOOLS = "bash cat cut dirname grep head ls mkdir mktemp mv python3 rm sed tr".split(" ");
const realToolPaths = execFileSync("sh", ["-c", 'for tool; do command -v "$tool" || exit 1; done', "sh", ...REAL_TOOLS], {
  encoding: "utf8",
})
  .trim()
  .split("\n");

// Every run goes through here. PATH is the sandbox and nothing else, so a fake that
// is missing or cannot execute has no real program to fall through to. The fakes are
// copied and marked executable in case a checkout lost its mode bits.
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const bin = join(dir, "bin");
  const tools = join(dir, "tools");
  const state = join(dir, "state");
  const tokenFile = join(dir, "home", ".config", "proxmox-mcp", "token");
  const removed = new Set();
  mkdirSync(bin);
  mkdirSync(tools);
  // Every node has root@pam, which a run must leave alone.
  mkdirSync(join(state, "tokens", "root@pam"), { recursive: true });
  for (const name of FAKED) {
    copyFileSync(join(FAKES, name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  REAL_TOOLS.forEach((name, i) => symlinkSync(realToolPaths[i], join(tools, name)));

  const read = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8") : "");
  const scriptEnv = (env) => ({
    HOME: join(dir, "home"),
    PVE_TOKEN_FILE: tokenFile,
    FAKE_PVE_STATE: state,
    FAKE_HOSTNAME: "sagae-windows",
    FAKE_YYYYMM: MONTH,
    FAKE_EPOCH: String(EPOCH),
    ...env,
    PATH: `${bin}:${tools}`,
  });

  // Checked before anything starts, so a fake that cannot run, as on a noexec temp
  // directory, stops the test with the reason instead of showing up as other failures.
  // The -x test is needed because bash answers with a non-executable file as a last resort.
  const assertFakesInPlace = () => {
    const lookup = 'for tool; do path=$(command -v "$tool") && [[ -x $path ]] && echo "$path" || echo "no $tool"; done';
    const { stdout } = spawnSync(join(tools, "bash"), ["-c", lookup, "bash", ...FAKED], {
      encoding: "utf8",
      env: scriptEnv(),
    });
    const expected = FAKED.map((name) => (removed.has(name) ? `no ${name}` : join(bin, name)));
    assert.equal(stdout, `${expected.join("\n")}\n`, `The fakes cannot run here (temp directory noexec?). Lookups found:\n${stdout}`);
  };

  // The shell records the script's PID for the fakes, then becomes the script.
  const launch = (args) => ["-c", 'echo "$$" >"$FAKE_PVE_STATE/script.pid"; exec "$0" "$@"', SCRIPT, ...args];

  // Every run's hostile inputs try to run the injected fake. It must never have run.
  const finished = (result) => {
    assert.ok(!existsSync(join(state, "injected")), "a test input ran as a command");
    return result;
  };

  return {
    dir,
    bin,
    tokenFile,
    scriptEnv,
    assertFakesInPlace,
    run(args = [], env = {}) {
      assertFakesInPlace();
      const result = spawnSync(join(tools, "bash"), launch(args), { encoding: "utf8", env: scriptEnv(env) });
      assert.equal(result.error, undefined);
      return finished(result);
    },
    // For tests that serve requests in this process, which a blocking run would starve.
    async runAsync(args = [], env = {}) {
      assertFakesInPlace();
      return new Promise((resolve, reject) => {
        const child = spawn(join(tools, "bash"), launch(args), { env: scriptEnv(env), stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stderr }));
      }).then(finished);
    },
    // Takes a fake away. The check above then requires that nothing answers to its name.
    removeFake(name) {
      rmSync(join(bin, name));
      removed.add(name);
    },
    // Puts a program ahead of the real tools. realTool() is how it reaches the one it hides.
    override(name, body) {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    },
    realTool: (name) => join(tools, name),
    // Puts a token on the fake node and, by default, in the local file.
    seed(id, secret = OLD_SECRET, { local = true } = {}) {
      mkdirSync(join(state, "tokens", USER), { recursive: true });
      writeFileSync(join(state, "tokens", USER, id), secret);
      if (local) {
        mkdirSync(dirname(tokenFile), { recursive: true });
        writeFileSync(tokenFile, `${USER}!${id}=${secret}\n`, { mode: 0o600 });
      }
    },
    nodeTokens: (user = USER) => {
      const dirOfUser = join(state, "tokens", user);
      return existsSync(dirOfUser) ? readdirSync(dirOfUser).sort() : [];
    },
    secretOf: (id) => readFileSync(join(state, "tokens", USER, id), "utf8"),
    // Events in order, as "<event> file=<token held locally at that moment>".
    calls: () =>
      read("calls.log")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replace(" | ", " ")),
    argv: () => read("argv.log"),
    verifyDir: () => read("verify-dir.log"),
    tokenDirEntries: () => (existsSync(dirname(tokenFile)) ? readdirSync(dirname(tokenFile)) : []),
  };
}

// The lifecycle events only, without arguments the order does not depend on.
function steps(s) {
  return s
    .calls()
    .filter((c) => /^(token-add|verify|token-remove) /.test(c))
    .map((c) => c.replace(/^(\S+ \S+) .*( file=\S+)$/, "$1$2"));
}

const full = (id) => `${USER}!${id}`;
const held = (id) => `file=${full(id)}`;

function hasTool(command, versionFlag) {
  return spawnSync(command, [versionFlag], { stdio: "ignore" }).status === 0;
}

test("no name a run looks up can reach anything outside the sandbox", (t) => {
  const s = sandbox(t);
  // Starts nothing, so this stays safe even if PATH regresses. A test cannot widen it either.
  for (const entry of s.scriptEnv({ PATH: "/usr/bin" }).PATH.split(":")) assert.ok(entry.startsWith(s.dir), entry);

  for (const name of FAKED) s.removeFake(name);
  s.assertFakesInPlace();
});

test("a hostile input that runs as a command fails the test", (t) => {
  const s = sandbox(t);
  s.override("hostname", "injected\necho sagae-windows");

  assert.throws(() => s.run(), /a test input ran as a command/);
});

test("a fake that cannot execute stops the test before the script starts", async (t) => {
  const s = sandbox(t);
  chmodSync(join(s.bin, "ssh"), 0o644);

  assert.throws(() => s.run(), /The fakes cannot run here/);
  await assert.rejects(s.runAsync(), /The fakes cannot run here/);
  assert.deepEqual(s.calls(), []);
  assert.equal(s.argv(), "");
});

test("a first run issues a machine token and stores it privately", (t) => {
  const s = sandbox(t);
  const result = s.run();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.nodeTokens(), [ID]);
  assert.deepEqual(s.nodeTokens("root@pam"), []);
  assert.equal(readFileSync(s.tokenFile, "utf8"), `${USER}!${ID}=${s.secretOf(ID)}\n`);
  assert.equal(statSync(s.tokenFile).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(s.tokenFile)).mode & 0o777, 0o700);
  assert.deepEqual(s.tokenDirEntries(), ["token"]);
  assert.deepEqual(steps(s), [`token-add ${full(ID)} file=none`, `verify ${full(ID)} file=none`]);
});

test("an empty token file counts as missing", (t) => {
  const s = sandbox(t);
  mkdirSync(dirname(s.tokenFile), { recursive: true });
  writeFileSync(s.tokenFile, "");

  assert.equal(s.run().status, 0);
  assert.equal(readFileSync(s.tokenFile, "utf8"), `${USER}!${ID}=${s.secretOf(ID)}\n`);
});

test("a token is read-only, privilege-separated, and expires in 365 days", (t) => {
  const s = sandbox(t);
  s.run();

  const calls = s.calls();
  const add = calls.find((c) => c.startsWith("token-add "));
  assert.match(add, /--privsep 1 /);
  assert.match(add, new RegExp(`--expire ${EPOCH + 365 * 86400} `));
  assert.ok(calls.includes(`user-add ${USER} file=none`));
  assert.ok(calls.includes(`acl-users ${USER} / PVEAuditor file=none`));
  assert.ok(calls.includes(`acl-tokens ${full(ID)} / PVEAuditor file=none`));
  assert.ok(calls.indexOf(`acl-tokens ${full(ID)} / PVEAuditor file=none`) > calls.indexOf(add));
});

test("a user that already exists is not added again", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);

  assert.equal(s.run(["--rotate"]).status, 0);
  assert.ok(!s.calls().some((c) => c.startsWith("user-add")));
});

test("the token ID comes from the normalized short hostname", (t) => {
  for (const [hostname, id] of [
    ["SAGAE-Windows", ID],
    ["sagae_windows", ID],
    ["sagae-windows.corp.example", ID],
    ["-Sagae__Windows-", ID],
    ["123box", `m-123box-${MONTH}`],
  ]) {
    const s = sandbox(t);
    assert.equal(s.run([], { FAKE_HOSTNAME: hostname }).status, 0);
    assert.deepEqual(s.nodeTokens(), [id]);
  }
});

test("uname names the machine when hostname is unavailable", (t) => {
  const s = sandbox(t);
  s.removeFake("hostname");

  assert.equal(s.run([], { FAKE_UNAME: "Build-Box.corp.example" }).status, 0);
  assert.deepEqual(s.nodeTokens(), [`m-build-box-${MONTH}`]);
});

test("a hostname with no usable characters needs --name", (t) => {
  const s = sandbox(t);
  const result = s.run([], { FAKE_HOSTNAME: "___" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--name/);
  assert.deepEqual(s.calls(), []);
});

test("re-running without arguments makes no remote call", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  const before = statSync(s.tokenFile).mtimeMs;

  const result = s.run();

  assert.equal(result.status, 0);
  assert.match(result.stdout, /nothing to do/);
  assert.deepEqual(s.calls(), []);
  assert.equal(s.argv(), "");
  assert.equal(statSync(s.tokenFile).mtimeMs, before);
});

test("options other than --rotate do not trigger remote calls on an existing file", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);

  assert.equal(s.run(["--keep-old", "--host", "pve-node", "--name", "m-other-202611"]).status, 0);
  assert.deepEqual(s.calls(), []);
});

test("rotation issues, verifies, swaps the file, then deletes, in that order", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  const { ino } = statSync(s.tokenFile);

  const result = s.run(["--rotate"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.notEqual(statSync(s.tokenFile).ino, ino, "the file must be renamed into place, not rewritten");
  assert.deepEqual(steps(s), [
    `token-add ${full(ID)} ${held(OLD_ID)}`,
    `verify ${full(ID)} ${held(OLD_ID)}`,
    `token-remove ${full(OLD_ID)} ${held(ID)}`,
  ]);
  assert.deepEqual(s.nodeTokens(), [ID]);
  assert.equal(readFileSync(s.tokenFile, "utf8"), `${USER}!${ID}=${s.secretOf(ID)}\n`);
  assert.equal(statSync(s.tokenFile).mode & 0o777, 0o600);
  assert.deepEqual(s.tokenDirEntries(), ["token"]);
});

test("the candidate token waits in a private temp file during verification", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  s.run(["--rotate"]);

  const temp = s
    .verifyDir()
    .split("\n")
    .filter((line) => /\btoken\.\S+$/.test(line));
  assert.equal(temp.length, 1, s.verifyDir());
  assert.match(temp[0], /^-rw------- /);
});

test("--rotate on a machine without a token file issues one and deletes nothing", (t) => {
  const s = sandbox(t);
  const result = s.run(["--rotate"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(steps(s), [`token-add ${full(ID)} file=none`, `verify ${full(ID)} file=none`]);
});

test("--keep-old leaves the old token on the node", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);

  const result = s.run(["--rotate", "--keep-old"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.nodeTokens(), [ID, OLD_ID].sort());
  assert.ok(!s.calls().some((c) => c.startsWith("token-remove")));
  assert.match(readFileSync(s.tokenFile, "utf8"), new RegExp(`^${USER}!${ID}=`));
});

test("rotation off the shared token needs --keep-old and never deletes it", (t) => {
  const s = sandbox(t);
  s.seed("mcp");
  const before = readFileSync(s.tokenFile, "utf8");

  const refused = s.run(["--rotate"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the shared "mcp" token/);
  assert.match(refused.stderr, /--keep-old/);
  assert.deepEqual(s.calls(), []);
  assert.equal(readFileSync(s.tokenFile, "utf8"), before);

  assert.equal(s.run(["--rotate", "--keep-old"]).status, 0);
  assert.deepEqual(s.nodeTokens(), [ID, "mcp"].sort());
  assert.match(readFileSync(s.tokenFile, "utf8"), new RegExp(`^${USER}!${ID}=`));
});

test("only the token named in the local file is deleted", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  s.seed("m-other-machine-202611", "other-secret-value", { local: false });
  s.seed("ci-runner-202611", "runner-secret-value", { local: false });

  assert.equal(s.run(["--rotate"]).status, 0);
  assert.deepEqual(s.nodeTokens(), ["ci-runner-202611", ID, "m-other-machine-202611"].sort());
});

test("--name cannot take over or delete another machine's token", (t) => {
  const s = sandbox(t);
  const other = "m-other-machine-202611";
  s.seed(OLD_ID);
  s.seed(other, "other-secret-value", { local: false });
  const before = readFileSync(s.tokenFile, "utf8");

  const result = s.run(["--rotate", "--name", other]);

  assert.equal(result.status, 1);
  assert.deepEqual(s.nodeTokens(), [OLD_ID, other].sort());
  assert.equal(readFileSync(s.tokenFile, "utf8"), before);
  assert.ok(!s.calls().some((c) => c.startsWith("token-remove")));
});

test("an ID not named after this machine is never deleted", (t) => {
  for (const other of [
    "m-other-machine-202611",
    "m-sagae-windows-laptop-202611",
    "x-m-sagae-windows-202611",
    "ci-runner-202611",
    "custom-name",
    "m-sagae-windows",
    "m-sagae-windows-2026",
    "m-sagae-windows-202611-x",
  ]) {
    const s = sandbox(t);
    s.seed(other);
    const before = readFileSync(s.tokenFile, "utf8");

    const refused = s.run(["--rotate"]);

    assert.equal(refused.status, 1, other);
    assert.ok(refused.stderr.includes(other), refused.stderr);
    assert.match(refused.stderr, /--keep-old/);
    assert.deepEqual(s.calls(), [], other);
    assert.equal(readFileSync(s.tokenFile, "utf8"), before);

    assert.equal(s.run(["--rotate", "--keep-old"]).status, 0);
    assert.deepEqual(s.nodeTokens(), [ID, other].sort());
    assert.match(readFileSync(s.tokenFile, "utf8"), new RegExp(`^${USER}!${ID}=`));
  }
});

test("an ID is compared with the normalized hostname", (t) => {
  const s = sandbox(t);
  s.seed(`${OLD_ID}-3`);

  assert.equal(s.run(["--rotate"], { FAKE_HOSTNAME: "SAGAE_Windows.corp.example" }).status, 0);
  assert.deepEqual(s.nodeTokens(), [ID]);
});

test("a hostname with no usable characters owns no token", (t) => {
  const s = sandbox(t);
  s.seed(`m--${MONTH}`);

  const result = s.run(["--rotate", "--name", "m-laptop-202611"], { FAKE_HOSTNAME: "___" });

  assert.equal(result.status, 1);
  assert.deepEqual(s.calls(), []);
});

test("a token file the script cannot attribute to its own user is never acted on", (t) => {
  for (const content of [
    `root@pam!${OLD_ID}=${OLD_SECRET}\n`,
    `${OLD_ID}=${OLD_SECRET}\n`,
    `${USER}!bad;injected=${OLD_SECRET}\n`,
    `${USER}!$(injected)=${OLD_SECRET}\n`,
    `${OLD_SECRET}\n`,
    `${USER}!=${OLD_SECRET}\n`,
    `${USER}!${OLD_ID}\n`,
    `${OLD_SECRET}\n${USER}!${OLD_ID}=${OLD_SECRET}\n`,
  ]) {
    const s = sandbox(t);
    s.seed(OLD_ID);
    writeFileSync(s.tokenFile, content);

    const result = s.run(["--rotate"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot read a /);
    assert.match(result.stderr, /--keep-old/);
    assert.ok(!result.stderr.includes(OLD_SECRET));
    assert.deepEqual(s.calls(), [], content);
    assert.equal(readFileSync(s.tokenFile, "utf8"), content);
  }
});

test("--rotate --keep-old replaces a file it cannot read an ID from", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  writeFileSync(s.tokenFile, `${OLD_SECRET}\n`);

  assert.equal(s.run(["--rotate", "--keep-old"]).status, 0);
  assert.deepEqual(s.nodeTokens(), [ID, OLD_ID].sort());
  assert.match(readFileSync(s.tokenFile, "utf8"), new RegExp(`^${USER}!${ID}=`));
});

test("rotating again within a month gets a new ID each time", (t) => {
  const s = sandbox(t);

  const expected = [ID, `${ID}-2`, `${ID}-3`];
  assert.equal(s.run().status, 0);
  assert.equal(s.run(["--rotate"]).status, 0);
  assert.equal(s.run(["--rotate"]).status, 0);

  assert.deepEqual(s.nodeTokens(), [expected[2]]);
  assert.match(readFileSync(s.tokenFile, "utf8"), new RegExp(`^${USER}!${expected[2]}=`));
  assert.deepEqual(
    steps(s).filter((c) => c.startsWith("token-remove")),
    [`token-remove ${full(expected[0])} ${held(expected[1])}`, `token-remove ${full(expected[1])} ${held(expected[2])}`],
  );
});

test("a new month starts the ID over", (t) => {
  const s = sandbox(t);
  s.seed(`${ID}-4`);

  assert.equal(s.run(["--rotate"], { FAKE_YYYYMM: "202612" }).status, 0);
  assert.deepEqual(s.nodeTokens(), ["m-sagae-windows-202612"]);
});

test("--name sets the ID but may not repeat the current one", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);

  const same = s.run(["--rotate", "--name", OLD_ID]);
  assert.equal(same.status, 1);
  assert.deepEqual(s.calls(), []);

  assert.equal(s.run(["--rotate", "--name", "m-laptop-202611"]).status, 0);
  assert.deepEqual(s.nodeTokens(), ["m-laptop-202611"]);
});

test("bad arguments stop before any remote call", (t) => {
  for (const args of [
    ["--name", "mcp"],
    ["--name", "1abc"],
    ["--name", "a"],
    ["--name", "bad id"],
    ["--name", "x;injected"],
    ["--name", "$(injected)"],
    ["--name"],
    ["--host"],
    ["--host", "-oProxyCommand=injected"],
    ["--host", "node;injected"],
    ["pve-node"],
    ["--unknown"],
  ]) {
    const s = sandbox(t);
    const result = s.run(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /^Usage:/m);
    assert.deepEqual(s.calls(), [], args.join(" "));
  }
});

test("--help prints usage without touching anything", (t) => {
  const s = sandbox(t);
  const result = s.run(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage:/);
  assert.deepEqual(s.calls(), []);
  assert.deepEqual(s.tokenDirEntries(), []);
});

test("--host selects the node, and the default is pve-node", (t) => {
  const named = sandbox(t);
  named.run(["--host", "root@pve-node"]);
  assert.ok(named.calls().every((c) => !c.startsWith("ssh ") || c.startsWith("ssh root@pve-node ")));

  const fallback = sandbox(t);
  fallback.run();
  assert.ok(fallback.calls().includes("ssh pve-node file=none"));
});

test("every ssh call refuses to prompt and cannot hang", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  assert.equal(s.run(["--rotate"]).status, 0);

  const calls = s.argv().split("\n").filter((line) => line.startsWith("ssh "));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call, /-o BatchMode=yes /);
    assert.match(call, /-o ConnectTimeout=10 /);
    assert.match(call, /-o ServerAliveInterval=5 -o ServerAliveCountMax=3 /);
  }
});

test("a missing ssh or curl is reported before the node is touched", (t) => {
  for (const tool of ["ssh", "curl"]) {
    const s = sandbox(t);
    s.seed(OLD_ID);
    const before = readFileSync(s.tokenFile, "utf8");
    s.removeFake(tool);

    const result = s.run(["--rotate"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${tool} is required`));
    assert.deepEqual(s.calls(), []);
    assert.deepEqual(s.nodeTokens(), [OLD_ID]);
    assert.equal(readFileSync(s.tokenFile, "utf8"), before);
    assert.deepEqual(s.tokenDirEntries(), ["token"]);
  }
});

test("a failed issue leaves the old token and file untouched", (t) => {
  for (const env of [{ FAKE_SSH_DOWN: "1" }, { FAKE_PVEUM_FAIL: "token-add" }]) {
    const s = sandbox(t);
    s.seed(OLD_ID);
    const content = readFileSync(s.tokenFile);
    const { mtimeMs } = statSync(s.tokenFile);

    const result = s.run(["--rotate"], env);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unchanged/);
    assert.deepEqual(readFileSync(s.tokenFile), content);
    assert.equal(statSync(s.tokenFile).mtimeMs, mtimeMs);
    assert.deepEqual(s.nodeTokens(), [OLD_ID]);
    assert.deepEqual(s.tokenDirEntries(), ["token"]);
    assert.ok(!s.calls().some((c) => c.startsWith("token-remove") || c.startsWith("verify")));
  }
});

test("a failed issue on a new machine leaves no file behind", (t) => {
  const s = sandbox(t);
  const result = s.run([], { FAKE_SSH_DOWN: "1" });

  assert.equal(result.status, 1);
  assert.deepEqual(s.tokenDirEntries(), []);
});

test("an ID that already exists on the node is left alone", (t) => {
  const s = sandbox(t);
  s.seed(ID, OLD_SECRET, { local: false });

  const result = s.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Token already exists/);
  assert.equal(s.secretOf(ID), OLD_SECRET);
  assert.ok(!s.calls().some((c) => c.startsWith("token-remove")));
  assert.deepEqual(s.tokenDirEntries(), []);
});

test("a token whose ACL cannot be set is removed on the node", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  const before = readFileSync(s.tokenFile, "utf8");

  const result = s.run(["--rotate"], { FAKE_PVEUM_FAIL: "acl-tokens" });

  assert.equal(result.status, 1);
  assert.deepEqual(s.nodeTokens(), [OLD_ID]);
  assert.equal(readFileSync(s.tokenFile, "utf8"), before);
  assert.deepEqual(steps(s), [`token-add ${full(ID)} ${held(OLD_ID)}`, `token-remove ${full(ID)} ${held(OLD_ID)}`]);
});

test("a client gone before the reply leaves no token on the node", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  const before = readFileSync(s.tokenFile, "utf8");

  const result = s.run(["--rotate"], { FAKE_SSH_CLIENT_GONE: "1" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unchanged/);
  assert.deepEqual(s.nodeTokens(), [OLD_ID]);
  assert.equal(readFileSync(s.tokenFile, "utf8"), before);
  assert.deepEqual(s.tokenDirEntries(), ["token"]);
});

test("a reply lost after the node finished is reported, because only a reply proves the token is ours", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  const before = readFileSync(s.tokenFile, "utf8");

  const result = s.run(["--rotate"], { FAKE_SSH_LOSE_REPLY: "1" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unchanged/);
  assert.ok(result.stderr.includes(`pveum user token list ${USER}`), result.stderr);
  assert.ok(result.stderr.includes(`pveum user token remove ${USER} ${ID}`), result.stderr);
  assert.match(result.stderr, /--name/);
  assert.deepEqual(s.nodeTokens(), [ID, OLD_ID].sort());
  assert.ok(!s.calls().some((c) => c.startsWith("token-remove")));
  assert.equal(readFileSync(s.tokenFile, "utf8"), before);
  assert.deepEqual(s.tokenDirEntries(), ["token"]);
});

test("an interrupt during the issue waits for the reply, then revokes the token", (t) => {
  for (const [event, signal] of [
    ["ssh", "TERM"],
    ["token-add", "INT"],
    ["acl-tokens", "HUP"],
  ]) {
    const s = sandbox(t);
    s.seed(OLD_ID);
    const before = readFileSync(s.tokenFile, "utf8");

    const result = s.run(["--rotate"], { FAKE_SIGNAL_ON: event, FAKE_SIGNAL: signal });

    assert.equal(result.status, SIGNAL_STATUS[signal], event);
    assert.ok(result.stderr.includes(`revoked unused token ${ID}`), result.stderr);
    assert.deepEqual(s.nodeTokens(), [OLD_ID], event);
    assert.equal(readFileSync(s.tokenFile, "utf8"), before);
    assert.deepEqual(s.tokenDirEntries(), ["token"]);
  }
});

test("failed verification revokes only the new token and keeps the old one", (t) => {
  for (const env of [
    { FAKE_CURL_REJECT: "1" },
    { FAKE_CURL_DOWN: "192.0.2.1,192.0.2.1,192.0.2.1" },
  ]) {
    const s = sandbox(t);
    s.seed(OLD_ID);
    const before = readFileSync(s.tokenFile, "utf8");

    const result = s.run(["--rotate"], env);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed verification/);
    assert.match(result.stderr, /revoked unused token/);
    assert.equal(readFileSync(s.tokenFile, "utf8"), before);
    assert.deepEqual(s.nodeTokens(), [OLD_ID]);
    assert.deepEqual(s.tokenDirEntries(), ["token"]);
    assert.equal(steps(s).at(-1), `token-remove ${full(ID)} ${held(OLD_ID)}`);
  }
});

test("a swap that does not happen revokes the new token and keeps the old one", (t) => {
  for (const body of ["exit 1", 'kill -TERM "$PPID" "$$"']) {
    const s = sandbox(t);
    s.seed(OLD_ID);
    const before = readFileSync(s.tokenFile, "utf8");
    s.override("mv", body);

    const result = s.run(["--rotate"]);

    assert.notEqual(result.status, 0, body);
    assert.ok(result.stderr.includes(`revoked unused token ${ID}`), result.stderr);
    assert.equal(readFileSync(s.tokenFile, "utf8"), before);
    assert.deepEqual(s.nodeTokens(), [OLD_ID]);
    assert.deepEqual(s.tokenDirEntries(), ["token"]);
  }
});

test("an interrupt as the swap completes keeps the new token and names the old one", (t) => {
  // The script alone is signaled, then the script and mv together, as a terminal does.
  for (const targets of ['"$PPID"', '"$PPID" "$$"']) {
    for (const signal of ["INT", "TERM", "HUP"]) {
      const s = sandbox(t);
      s.seed(OLD_ID);
      s.override("mv", `${s.realTool("mv")} "$@"\nkill -${signal} ${targets}`);

      const result = s.run(["--rotate"]);

      assert.equal(result.status, SIGNAL_STATUS[signal], result.stderr);
      assert.doesNotMatch(result.stderr, /revoked/);
      assert.equal(readFileSync(s.tokenFile, "utf8"), `${USER}!${ID}=${s.secretOf(ID)}\n`);
      assert.deepEqual(s.nodeTokens(), [ID, OLD_ID].sort());
      assert.ok(result.stderr.includes(`pveum user token remove ${USER} ${OLD_ID}`), result.stderr);
      assert.deepEqual(s.tokenDirEntries(), ["token"]);
    }
  }
});

test("a revocation that fails names the token to delete by hand", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);

  const result = s.run(["--rotate"], { FAKE_CURL_REJECT: "1", FAKE_PVEUM_FAIL: "token-remove" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`pveum user token remove ${USER} ${ID}`));
  assert.match(readFileSync(s.tokenFile, "utf8"), new RegExp(`^${USER}!${OLD_ID}=`));
});

test("being interrupted before the swap cleans up like a failure", (t) => {
  for (const signal of ["INT", "TERM", "HUP"]) {
    const s = sandbox(t);
    s.seed(OLD_ID);
    const before = readFileSync(s.tokenFile, "utf8");

    const result = s.run(["--rotate"], { FAKE_CURL_SIGNAL: signal });

    assert.notEqual(result.status, 0, signal);
    assert.equal(readFileSync(s.tokenFile, "utf8"), before, signal);
    assert.deepEqual(s.nodeTokens(), [OLD_ID], signal);
    assert.deepEqual(s.tokenDirEntries(), ["token"], signal);
  }
});

test("a second interrupt does not cut the cleanup short", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  const before = readFileSync(s.tokenFile, "utf8");

  const result = s.run(["--rotate"], { FAKE_CURL_REJECT: "1", FAKE_SIGNAL_ON: "token-remove", FAKE_SIGNAL: "TERM" });

  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`revoked unused token ${ID}`), result.stderr);
  assert.deepEqual(s.nodeTokens(), [OLD_ID]);
  assert.equal(readFileSync(s.tokenFile, "utf8"), before);
});

test("a malformed answer from the node never reaches the token file", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);
  const before = readFileSync(s.tokenFile, "utf8");
  const fake = join(s.bin, "pveum");
  writeFileSync(fake, readFileSync(fake, "utf8").replace('"$id" "$value"', '"$id" "not a token"'));

  const result = s.run(["--rotate"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed/);
  assert.equal(readFileSync(s.tokenFile, "utf8"), before);
  assert.deepEqual(s.nodeTokens(), [OLD_ID]);
});

test("a failed delete keeps the new token and names the old one to delete", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);

  const result = s.run(["--rotate"], { FAKE_PVEUM_FAIL: "token-remove" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`pveum user token remove ${USER} ${OLD_ID}`));
  assert.match(readFileSync(s.tokenFile, "utf8"), new RegExp(`^${USER}!${ID}=`));
  assert.deepEqual(s.nodeTokens(), [ID, OLD_ID].sort());
});

test("an interrupt during the old token's delete names it", (t) => {
  for (const env of [{}, { FAKE_PVEUM_FAIL: "token-remove" }]) {
    const s = sandbox(t);
    s.seed(OLD_ID);

    const result = s.run(["--rotate"], { FAKE_SIGNAL_ON: "token-remove", FAKE_SIGNAL: "TERM", ...env });

    assert.equal(result.status, SIGNAL_STATUS.TERM);
    assert.ok(result.stderr.includes(`pveum user token remove ${USER} ${OLD_ID}`), result.stderr);
    assert.match(readFileSync(s.tokenFile, "utf8"), new RegExp(`^${USER}!${ID}=`));
  }
});

test("verification fails over to the next host", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);

  const result = s.run(["--rotate"], { FAKE_CURL_DOWN: "192.0.2.1" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    s.calls().filter((c) => c.startsWith("verify ")),
    [
      `verify ${full(ID)} 192.0.2.1 ${held(OLD_ID)}`,
      `verify ${full(ID)} 192.0.2.1 ${held(OLD_ID)}`,
    ],
  );
});

test("verification honors PVE_HOSTS and PVE_CA_FILE like the server", (t) => {
  const s = sandbox(t);
  const ca = join(ROOT, "certs", "pve-root-ca.pem");

  assert.equal(s.run([], { PVE_HOSTS: "10.x.x.x, 10.x.x.x", PVE_CA_FILE: ca, FAKE_CURL_DOWN: "10.x.x.x" }).status, 0);
  assert.deepEqual(
    s.calls().filter((c) => c.startsWith("verify ")).map((c) => c.split(" ")[2]),
    ["10.x.x.x", "10.x.x.x"],
  );
});

test("verification pins the plugin CA and never disables TLS checks", (t) => {
  const s = sandbox(t);
  s.run();

  const curl = s.argv().split("\n").find((line) => line.startsWith("curl "));
  // curl only honors -q as its first argument, and without it ~/.curlrc can undo --cacert.
  assert.ok(curl.startsWith("curl -q "), curl);
  assert.ok(curl.includes(`--cacert ${join(ROOT, "certs", "pve-root-ca.pem")} `), curl);
  // Without --capath the built-in CA directory stays trusted next to --cacert.
  assert.ok(curl.includes(`--capath ${join(ROOT, "certs")} `), curl);
  assert.match(curl, / --max-time 8 /);
  assert.ok(curl.endsWith(" https://192.0.2.1:8006/api2/json/version"), curl);
  assert.doesNotMatch(curl, /(^|\s)(-k|--insecure)(\s|$)/);
});

test(
  "the real curl sends the token over TLS and refuses an untrusted certificate",
  { skip: hasTool("curl", "--version") && hasTool("openssl", "version") ? false : "needs curl and openssl" },
  async (t) => {
    const s = sandbox(t);
    s.seed(OLD_ID);
    const before = readFileSync(s.tokenFile, "utf8");

    const key = join(s.dir, "node.key");
    const cert = join(s.dir, "node.pem");
    execFileSync(
      "openssl",
      [
        ...["req", "-x509", "-nodes", "-days", "1", "-subj", "/CN=fake-node"],
        ...["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"],
        ...["-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert],
      ],
      { stdio: "ignore" },
    );

    let status = 401;
    const requests = [];
    const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      requests.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.statusCode = status;
      res.end('{"data":{"version":"9.2.2"}}');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());

    // Only the port differs from what the script asked for; the rest is real curl. Real
    // curl is on PATH for this test alone, so it refuses any host but the local server.
    const realCurl = execFileSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).trim();
    s.override(
      "curl",
      `url=\${!#}\n[[ $url == https://127.0.0.1:8006/* ]] || exit 7\n` +
        `exec ${realCurl} "\${@:1:$#-1}" "\${url/:8006/:${server.address().port}}"`,
    );

    // Stays in place for every run below: the pinned CA has to win over the user's curl config.
    writeFileSync(join(s.dir, "home", ".curlrc"), "insecure\n");

    const untrusted = await s.runAsync(["--rotate"], { PVE_HOSTS: "127.0.0.1" });
    assert.equal(untrusted.status, 1, untrusted.stderr);
    assert.match(untrusted.stderr, /failed verification/);
    assert.deepEqual(requests, []);
    assert.equal(readFileSync(s.tokenFile, "utf8"), before);
    assert.deepEqual(s.nodeTokens(), [OLD_ID]);

    // A proxy that cannot answer: the request only succeeds if curl goes around it.
    const reachable = { PVE_HOSTS: "127.0.0.1", PVE_CA_FILE: cert, https_proxy: "http://127.0.0.1:9" };

    const rejected = await s.runAsync(["--rotate"], reachable);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /failed verification/);
    assert.equal(requests.length, 1);
    assert.equal(readFileSync(s.tokenFile, "utf8"), before);
    assert.deepEqual(s.nodeTokens(), [OLD_ID]);

    status = 200;
    const accepted = await s.runAsync(["--rotate"], reachable);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(requests.length, 2);
    assert.equal(requests[1], `GET /api2/json/version PVEAPIToken=${readFileSync(s.tokenFile, "utf8").trim()}`);
    assert.deepEqual(s.nodeTokens(), [ID]);
  },
);

test("the default hosts match the server's", () => {
  const [, hosts] = readFileSync(SCRIPT, "utf8").match(/^DEFAULT_PVE_HOSTS="([^"]+)"$/m);
  assert.ok(readFileSync(join(ROOT, "server", "index.mjs"), "utf8").includes(`"${hosts}"`));
});

test("a missing CA file stops before the node is touched", (t) => {
  const s = sandbox(t);
  const result = s.run([], { PVE_CA_FILE: "/nonexistent/ca.pem" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CA certificate/);
  assert.deepEqual(s.calls(), []);
});

test("secrets never reach an argument list or the output", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);

  const result = s.run(["--rotate"]);
  const secret = s.secretOf(ID);

  assert.equal(result.status, 0, result.stderr);
  for (const value of [secret, OLD_SECRET]) {
    assert.ok(!result.stdout.includes(value));
    assert.ok(!result.stderr.includes(value));
    assert.ok(!s.argv().includes(value));
    assert.ok(!s.calls().join("\n").includes(value));
  }
});

test("a failing run leaks no secret either", (t) => {
  const s = sandbox(t);
  s.seed(OLD_ID);

  const result = s.run(["--rotate"], { FAKE_CURL_REJECT: "1" });

  assert.equal(result.status, 1);
  for (const output of [result.stdout, result.stderr, s.argv()]) {
    assert.doesNotMatch(output, /[0-9a-f]{8}-[0-9a-f]{4}-4000-8000-[0-9a-f]{12}/);
  }
});
