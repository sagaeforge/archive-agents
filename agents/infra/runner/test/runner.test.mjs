// Tests for the runner provisioning scripts. Nothing here touches Proxmox or
// GitHub: every external tool is test/fake-tool.sh in a directory that is the
// whole of PATH, and the names below do not resolve.
//
// Run from the repository root: node --test infra/runner/test/*.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROVISION = join(RUNNER_DIR, "provision.sh");
const ISSUE_TOKEN = join(RUNNER_DIR, "issue-token.sh");
const NFT_CONF = join(RUNNER_DIR, "nftables.conf");
const FAKE_TOOL = join(RUNNER_DIR, "test", "fake-tool.sh");
const SHELL_FILES = [PROVISION, ISSUE_TOKEN, FAKE_TOOL];

const FAKE_TOOLS = ["curl", "gh", "hostname", "pct", "pveam", "pveum", "pvesh", "sleep", "ssh"];
const REAL_TOOLS = ["awk", "bash", "cat", "date", "dirname", "python3", "sed", "sort", "tail"];

const NODE = "test-node";
const HOST = "root@fake-host.invalid";
const VMID = "205";
const TEMPLATE = "debian-13-standard_13.6-1_amd64.tar.zst";
const TOKEN_ID = "ci-runner-202611";
const REPO = "sagaeforge/sagae-claude-plugins";

const REGISTRATION_TOKEN = "sentinel-registration-token";
const PVE_SECRET = "sentinel-pve-secret";
const AUDIT_ONLY = JSON.stringify({ data: { "/": { "Sys.Audit": 1, "VM.Audit": 1 }, "/vms": { "VM.Audit": 1 } } });

const PROVISION_ARGS = ["--node", NODE, "--vmid", VMID, "--host", HOST, "--template", TEMPLATE];
const ISSUE_ARGS = ["--node", NODE, "--vmid", VMID, "--host", HOST, "--token-id", TOKEN_ID];

function findTool(name) {
  for (const dir of process.env.PATH.split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return null;
}

const sandboxDirs = [];
after(() => {
  for (const dir of sandboxDirs) rmSync(dir, { recursive: true, force: true });
});

function sandbox(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
  sandboxDirs.push(dir);
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  for (const name of FAKE_TOOLS) symlinkSync(FAKE_TOOL, join(bin, name));
  for (const name of REAL_TOOLS) symlinkSync(findTool(name), join(bin, name));

  return {
    run(script, args) {
      return spawnSync(join(bin, "bash"), [script, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: bin,
          FAKE_LOG: log,
          FAKE_HOSTNAME: NODE,
          FAKE_REGISTRATION_TOKEN: REGISTRATION_TOKEN,
          FAKE_PVE_SECRET: PVE_SECRET,
          FAKE_PERMISSIONS: AUDIT_ONLY,
          ...env,
        },
      });
    },
    calls() {
      return readFileSync(log, "utf8")
        .split("\x1e")
        .filter(Boolean)
        .map((record) => {
          const fields = record.split("\x1f");
          const argv = fields.slice(1, -1);
          return { tool: fields[0], argv, stdin: fields.at(-1), text: `${fields[0]} ${argv.join(" ")}` };
        });
    },
  };
}

// The commands a dry run promises to send to the node, in order.
function plannedRemoteCommands(stdout, host) {
  const tag = `[${host}] `;
  return stdout.split("\n").flatMap((line) => {
    const at = line.indexOf(tag);
    if (line.startsWith("#") || at === -1) return [];
    return [line.slice(at + tag.length).replace(/ < \S+$/, "")];
  });
}

function assertInOrder(lines, patterns) {
  let previous = -1;
  for (const pattern of patterns) {
    const index = lines.findIndex((line, i) => i > previous && pattern.test(line));
    assert.notEqual(index, -1, `missing, or out of order: ${pattern}`);
    previous = index;
  }
}

function assertNoLeak(result, calls, secret) {
  assert.ok(!result.stdout.includes(secret), "secret on stdout");
  assert.ok(!result.stderr.includes(secret), "secret on stderr");
  for (const call of calls) assert.ok(!call.text.includes(secret), `secret on the command line of ${call.tool}`);
}

const called = (calls, pattern) => calls.some((call) => pattern.test(call.text));

// Dry run: provision.sh

test("provision --dry-run prints the whole plan and runs nothing", () => {
  const box = sandbox();
  const result = box.run(PROVISION, ["--dry-run", "--node", "pve-node", "--vmid", "101"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(box.calls(), [], "a dry run must not start any tool");

  for (const expected of [
    "[pve-node] pvesh get /cluster/nextid --vmid 101",
    "[pve-node] pveam update",
    "[pve-node] pct create 101 ",
    "--hostname pve-runner-01",
    "--unprivileged 1",
    "--features nesting=1",
    "--onboot 1",
    "--cores 4",
    "--memory 4096",
    "--rootfs local-lvm:32",
    "--net0 name=eth0,bridge=vmbr0,ip=dhcp",
    "[pve-node] pct start 101",
    "useradd --create-home --shell /bin/bash runner",
    "apt-get purge -y sudo openssh-server",
    "sed -i 's#http://#https://#'",
    "sha256sum --check --strict",
    "nft -c -f /etc/nftables.conf",
    "systemctl enable --now nftables",
    `[local] gh api -X POST repos/${REPO}/actions/runners/registration-token --jq .token | [pve-node] pct exec 101 -- runuser -l runner -c`,
    `./config.sh --unattended --replace --url https://github.com/${REPO} --name pve-runner-01 --labels proxmox`,
    "./svc.sh install runner",
    "# Next: infra/runner/issue-token.sh --node pve-node --vmid 101",
  ]) {
    assert.ok(result.stdout.includes(expected), `plan is missing: ${expected}`);
  }
});

test("provision --dry-run applies and checks the firewall before the runner can register", () => {
  const result = sandbox().run(PROVISION, ["--dry-run", "--node", "pve-node", "--vmid", "101"]);
  assertInOrder(result.stdout.split("\n"), [
    /pvesh get \/cluster\/nextid/,
    /pveam download local/,
    /pct create 101/,
    /apt-get install/,
    /sha256sum --check/,
    /cat > \/etc\/nftables\.conf/,
    /nft -c -f/,
    /systemctl enable --now nftables/,
    /pct config 101/,
    /sudo -n true/,
    /dev\/tcp\/192\.168\.0\.10\/22/,
    /dev\/tcp\/192\.168\.0\.10\/8006/,
    /dev\/tcp\/github\.com\/443/,
    /registration-token/,
    /svc\.sh install runner/,
    /actions\/runners --jq/,
  ]);
});

test("provision --dry-run takes the node and VMID from its arguments", () => {
  const result = sandbox().run(PROVISION, ["--dry-run", "--node", "other-node", "--vmid", "777"]);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /epyc-/);
  assert.doesNotMatch(result.stdout, /\b101\b/);
  assert.match(result.stdout, /\[other-node\] pct create 777 /);

  const commands = plannedRemoteCommands(result.stdout, "other-node");
  assert.ok(commands.length > 20);
  const pct = commands.filter((command) => /^pct (create|start|exec|config)/.test(command));
  assert.ok(pct.length > 15);
  for (const command of pct) assert.match(command, /^pct \w+ 777\b/);
});

test("provision --dry-run reports a separate SSH target and a static address", () => {
  const result = sandbox().run(PROVISION, [
    "--dry-run",
    "--node",
    "pve-node",
    "--vmid",
    "101",
    "--host",
    "root@192.0.2.1",
    "--ip",
    "192.0.2.1/24",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[root@192\.168\.0\.11\] pct create 101 /);
  assert.match(result.stdout, /--net0 name=eth0,bridge=vmbr0,ip=192\.168\.0\.50\/24,gw=192\.168\.0\.1/);
  assert.match(result.stdout, /# Next: .*--node pve-node --vmid 101 --host root@192\.168\.0\.11/);
});

test("provision --dry-run probes every node listed in nftables.conf", () => {
  const result = sandbox().run(PROVISION, ["--dry-run", "--node", "pve-node", "--vmid", "101"]);
  for (const ip of parseNft(readFileSync(NFT_CONF, "utf8")).defines.get("PVE_NODES")) {
    assert.ok(result.stdout.includes(`/dev/tcp/${ip}/22`), `${ip}:22`);
    assert.ok(result.stdout.includes(`/dev/tcp/${ip}/8006`), `${ip}:8006`);
  }
});

test("the LXC resolver is one the firewall allows", () => {
  const result = sandbox().run(PROVISION, ["--dry-run", "--node", "pve-node", "--vmid", "101"]);
  const nameserver = /--nameserver (\S+)/.exec(result.stdout)[1];
  assert.ok(parseNft(readFileSync(NFT_CONF, "utf8")).defines.get("DNS_SERVERS").includes(nameserver));
});

test("the runner tarball is pinned to a version and a full SHA-256", () => {
  const script = readFileSync(PROVISION, "utf8");
  assert.match(script, /^RUNNER_VERSION="\d+\.\d+\.\d+"$/m);
  assert.match(script, /^RUNNER_SHA256="[0-9a-f]{64}"$/m);
});

// Dry run: issue-token.sh

test("issue-token --dry-run prints the whole plan and runs nothing", () => {
  const box = sandbox();
  const result = box.run(ISSUE_TOKEN, ["--dry-run", "--node", "pve-node", "--vmid", "101"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(box.calls(), [], "a dry run must not start any tool");

  const yearMonth = new Date().toISOString().slice(0, 7).replace("-", "");
  for (const expected of [
    "[pve-node] pct exec 101 -- getent group runner",
    `[pve-node] pveum user token add claude-mcp@pve ci-runner-${yearMonth} --privsep 1 --expire `,
    `[pve-node] pveum acl modify / --tokens 'claude-mcp@pve!ci-runner-${yearMonth}' --roles PVEAuditor`,
    "--cacert /etc/pve/pve-root-ca.pem --header @- https://localhost:8006/api2/json/version",
    "https://localhost:8006/api2/json/access/permissions | python3 -c",
    "install -d -m 750 -o root -g runner /etc/proxmox-mcp",
    "chown root:runner /etc/proxmox-mcp/token.new",
    "chmod 640 /etc/proxmox-mcp/token.new",
    "mv -f /etc/proxmox-mcp/token.new /etc/proxmox-mcp/token",
    `stat -c '%U:%G %a' /etc/proxmox-mcp/token`,
  ]) {
    assert.ok(result.stdout.includes(expected), `plan is missing: ${expected}`);
  }
});

test("issue-token --dry-run shows a placeholder and installs only after the checks", () => {
  const result = sandbox().run(ISSUE_TOKEN, ["--dry-run", "--node", "pve-node", "--vmid", "101"]);
  const lines = result.stdout.split("\n");

  assert.match(result.stdout, /PVEAPIToken=claude-mcp@pve!ci-runner-\d{6}=<secret>/);
  assertInOrder(lines, [
    /getent group runner/,
    /pveum user token add/,
    /pveum acl modify/,
    /api2\/json\/version/,
    /api2\/json\/access\/permissions/,
    /mv -f \/etc\/proxmox-mcp\/token\.new/,
    /stat -c/,
  ]);
});

test("issue-token --dry-run sets the expiry from --expire-days, 180 by default", () => {
  const expiryOf = (args) => {
    const result = sandbox().run(ISSUE_TOKEN, ["--dry-run", "--node", "n1", "--vmid", "101", ...args]);
    assert.equal(result.status, 0, result.stderr);
    return Number(/--expire (\d+)/.exec(result.stdout)[1]);
  };
  const days = (expire) => (expire - Date.now() / 1000) / 86400;

  assert.ok(Math.abs(days(expiryOf([])) - 180) < 0.01);
  assert.ok(Math.abs(days(expiryOf(["--expire-days", "30"])) - 30) < 0.01);
});

test("issue-token --dry-run takes the node and VMID from its arguments", () => {
  const result = sandbox().run(ISSUE_TOKEN, ["--dry-run", "--node", "other-node", "--vmid", "777"]);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /epyc-/);
  assert.doesNotMatch(result.stdout, /\b101\b/);
  assert.match(result.stdout, /\[other-node\] pct exec 777 -- getent group runner/);
});

// Argument validation

for (const [name, script] of [
  ["provision", PROVISION],
  ["issue-token", ISSUE_TOKEN],
]) {
  for (const [label, args] of [
    ["no --node", ["--vmid", "101"]],
    ["no --vmid", ["--node", "n1"]],
    ["a VMID that is not a number", ["--node", "n1", "--vmid", "abc"]],
    ["a VMID below the PVE range", ["--node", "n1", "--vmid", "99"]],
    ["shell syntax in the node", ["--node", "n1;reboot", "--vmid", "101"]],
    ["an ssh option as the host", ["--node", "n1", "--vmid", "101", "--host", "-oProxyCommand=x"]],
    ["a flag with no value", ["--vmid", "101", "--node"]],
    ["an unknown flag", ["--node", "n1", "--vmid", "101", "--force"]],
  ]) {
    test(`${name} rejects ${label}`, () => {
      const box = sandbox();
      const result = box.run(script, ["--dry-run", ...args]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /^error: /);
      assert.doesNotMatch(result.stdout, /Step/);
      assert.deepEqual(box.calls(), []);
    });
  }
}

for (const [label, script, args] of [
  ["an address that is not dhcp or a CIDR", PROVISION, ["--ip", "nonsense"]],
  ["a template path", PROVISION, ["--template", "../evil.tar.zst"]],
  ["the shared machine token", ISSUE_TOKEN, ["--token-id", "mcp"]],
  ["a per-machine token", ISSUE_TOKEN, ["--token-id", "m-sagae-202611"]],
  ["a token that expires now", ISSUE_TOKEN, ["--expire-days", "0"]],
]) {
  test(`${script === PROVISION ? "provision" : "issue-token"} rejects ${label}`, () => {
    const result = sandbox().run(script, ["--dry-run", "--node", "n1", "--vmid", "101", ...args]);
    assert.equal(result.status, 2);
  });
}

test("--help prints usage and exits 0 for both scripts", () => {
  for (const script of [PROVISION, ISSUE_TOKEN]) {
    const box = sandbox();
    const result = box.run(script, ["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: /);
    assert.deepEqual(box.calls(), []);
  }
});

// Fake run: the real code paths, against fakes

test("a dry run lists exactly what a real provision sends to the node", () => {
  const dry = sandbox().run(PROVISION, ["--dry-run", ...PROVISION_ARGS]);
  const box = sandbox();
  const real = box.run(PROVISION, PROVISION_ARGS);

  assert.equal(real.status, 0, real.stderr);
  const sent = box
    .calls()
    .filter((call) => call.tool === "ssh")
    .map((call) => call.argv.at(-1));
  assert.deepEqual(plannedRemoteCommands(dry.stdout, HOST), sent);
});

test("a dry run lists exactly what a real issue-token sends to the node", () => {
  const withoutExpiry = (command) => command.replace(/--expire \d+/, "--expire N");
  const dry = sandbox().run(ISSUE_TOKEN, ["--dry-run", ...ISSUE_ARGS]);
  const box = sandbox();
  const real = box.run(ISSUE_TOKEN, ISSUE_ARGS);

  assert.equal(real.status, 0, real.stderr);
  const sent = box
    .calls()
    .filter((call) => call.tool === "ssh")
    .map((call) => withoutExpiry(call.argv.at(-1)));
  assert.deepEqual(plannedRemoteCommands(dry.stdout, HOST).map(withoutExpiry), sent);
});

test("provision parses back into the intended words on the node", () => {
  const box = sandbox();
  assert.equal(box.run(PROVISION, PROVISION_ARGS).status, 0);
  const pct = box.calls().filter((call) => call.tool === "pct");
  const find = (text) => pct.find((call) => call.text.includes(text));

  assert.deepEqual(find("create").argv.slice(0, 3), ["create", VMID, `local:vztmpl/${TEMPLATE}`]);

  const firewall = find("cat > /etc/nftables.conf");
  assert.deepEqual(firewall.argv.slice(0, 4), ["exec", VMID, "--", "sh"]);
  assert.equal(firewall.stdin, readFileSync(NFT_CONF, "utf8"));

  assert.deepEqual(find("sudo -n true").argv.slice(3), ["runuser", "-u", "runner", "--", "bash", "-c", "! sudo -n true 2>/dev/null"]);

  assert.equal(
    find("20auto-upgrades").argv.at(-1),
    `printf '%s\\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades`,
  );
});

test("provision picks the newest amd64 template when none is given", () => {
  const box = sandbox();
  const result = box.run(PROVISION, ["--node", NODE, "--vmid", VMID, "--host", HOST]);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(called(box.calls(), /^pveam download local debian-13-standard_13\.6-1_amd64\.tar\.zst$/));
});

test("provision reports the rebuild time when it finishes", () => {
  const result = sandbox().run(PROVISION, PROVISION_ARGS);
  assert.match(result.stdout, new RegExp(`Runner pve-runner-01 is online and idle in LXC ${VMID} on ${NODE}\\. Took \\d+s\\.`));
});

test("the registration token reaches config.sh over stdin only", () => {
  const box = sandbox();
  const result = box.run(PROVISION, PROVISION_ARGS);

  assert.equal(result.status, 0, result.stderr);
  const calls = box.calls();
  assertNoLeak(result, calls, REGISTRATION_TOKEN);

  const receivers = calls.filter((call) => call.stdin.includes(REGISTRATION_TOKEN));
  assert.equal(receivers.length, 1);
  assert.equal(receivers[0].tool, "pct");
  assert.equal(receivers[0].stdin, `${REGISTRATION_TOKEN}\n`);
  assert.match(receivers[0].text, /read -r ACTIONS_RUNNER_INPUT_TOKEN/);
  assert.doesNotMatch(receivers[0].text, /--token/);
});

for (const [label, env, reached] of [
  ["gh has no admin rights", { FAKE_GH_ADMIN: "false" }, /^$/],
  ["the SSH target is another node", { FAKE_HOSTNAME: "other-node" }, /hostname -s/],
]) {
  test(`provision changes nothing when ${label}`, () => {
    const box = sandbox(env);
    const result = box.run(PROVISION, PROVISION_ARGS);

    assert.equal(result.status, 1);
    const calls = box.calls();
    assert.ok(!called(calls, /^pveam|^pct /));
    assert.ok(calls.filter((call) => call.tool === "ssh").every((call) => reached.test(call.text)));
  });
}

test("provision stops before creating anything when the VMID is taken", () => {
  const box = sandbox({ FAKE_FAIL_MATCH: "cluster/nextid" });
  const result = box.run(PROVISION, PROVISION_ARGS);

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`VMID ${VMID} is not free`));
  assert.doesNotMatch(result.stderr, /pct destroy/);
  assert.ok(!called(box.calls(), /^pveam|^pct /));
});

test("provision stops at a bad runner checksum, before the firewall and registration", () => {
  const box = sandbox({ FAKE_FAIL_MATCH: "sha256sum" });
  const result = box.run(PROVISION, PROVISION_ARGS);

  assert.equal(result.status, 1);
  const calls = box.calls();
  assert.ok(!called(calls, /installdependencies/));
  assert.ok(!called(calls, /registration-token/));
});

for (const [label, env] of [
  ["the firewall does not parse", { FAKE_FAIL_MATCH: "nft -c" }],
  ["the firewall does not load", { FAKE_FAIL_MATCH: "enable --now nftables" }],
  ["the firewall table is missing", { FAKE_FAIL_MATCH: "nft list table" }],
  ["the LXC is privileged", { FAKE_PCT_CONFIG: "unprivileged: 0" }],
  ["runner can use sudo", { FAKE_FAIL_MATCH: "sudo -n true" }],
  ["runner can read the firewall", { FAKE_FAIL_MATCH: "nft list ruleset" }],
  ["node SSH is reachable", { FAKE_FAIL_MATCH: "/22" }],
  ["the PVE API is blocked", { FAKE_FAIL_MATCH: "/8006" }],
  ["external 443 is blocked", { FAKE_FAIL_MATCH: "github.com/443" }],
  ["apt fails through the firewall", { FAKE_FAIL_MATCH: "update --error-on=any" }],
]) {
  test(`provision never registers a runner when ${label}`, () => {
    const box = sandbox(env);
    const result = box.run(PROVISION, PROVISION_ARGS);

    assert.equal(result.status, 1, result.stdout);
    assert.ok(!called(box.calls(), /registration-token/));
  });
}

test("provision fails when the runner never comes online, and leaves the LXC alone", () => {
  const box = sandbox({ FAKE_RUNNER_STATE: "offline false" });
  const result = box.run(PROVISION, PROVISION_ARGS);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not online and idle; last state: offline false/);
  assert.match(result.stderr, new RegExp(`pct destroy ${VMID}`));
  assert.ok(!called(box.calls(), /pct (destroy|stop)/), "the hint must not be executed");
});

test("a busy runner does not count as idle", () => {
  const result = sandbox({ FAKE_RUNNER_STATE: "online true" }).run(PROVISION, PROVISION_ARGS);
  assert.equal(result.status, 1);
});

test("issue-token checks the token before installing it and keeps it off every command line", () => {
  const box = sandbox();
  const result = box.run(ISSUE_TOKEN, ISSUE_ARGS);
  const fullToken = `claude-mcp@pve!${TOKEN_ID}=${PVE_SECRET}`;

  assert.equal(result.status, 0, result.stderr);
  const calls = box.calls();
  assertNoLeak(result, calls, PVE_SECRET);

  assertInOrder(
    calls.filter((call) => call.tool !== "ssh").map((call) => call.text),
    [
      /^pct exec 205 -- getent group runner/,
      /^pveum user token add claude-mcp@pve ci-runner-202611 --privsep 1 --expire \d+ /,
      /^pveum acl modify \/ --tokens claude-mcp@pve!ci-runner-202611 --roles PVEAuditor$/,
      /^curl .*\/version$/,
      /^curl .*\/access\/permissions$/,
      /^pct exec 205 -- sh -c /,
      /^pct exec 205 -- stat -c/,
    ],
  );

  const receivers = calls.filter((call) => call.stdin.includes(PVE_SECRET));
  assert.deepEqual(
    receivers.map((call) => [call.tool, call.stdin]),
    [
      ["curl", `Authorization: PVEAPIToken=${fullToken}\n`],
      ["curl", `Authorization: PVEAPIToken=${fullToken}\n`],
      ["pct", `${fullToken}\n`],
    ],
  );
  assert.ok(!called(calls, /token remove/));
});

for (const [label, env, message] of [
  ["its privileges go beyond audit", { FAKE_PERMISSIONS: JSON.stringify({ data: { "/": { "Sys.Audit": 1, "VM.PowerMgmt": 1 } } }) }, /VM\.PowerMgmt/],
  ["it holds no privileges", { FAKE_PERMISSIONS: JSON.stringify({ data: {} }) }, /no privileges/],
  ["the role grant fails", { FAKE_FAIL_MATCH: "acl modify" }, /forced failure/],
  ["the token does not work", { FAKE_FAIL_MATCH: "api2/json/version" }, /forced failure/],
  ["the permission check fails", { FAKE_FAIL_MATCH: "access/permissions" }, /forced failure|JSONDecodeError/],
]) {
  test(`issue-token revokes the new token and installs nothing when ${label}`, () => {
    const box = sandbox(env);
    const result = box.run(ISSUE_TOKEN, ISSUE_ARGS);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    const calls = box.calls();
    assertNoLeak(result, calls, PVE_SECRET);
    assert.ok(called(calls, /^pveum user token remove claude-mcp@pve ci-runner-202611$/));
    assert.ok(!called(calls, /token\.new/), "the token must not reach the LXC");
  });
}

test("issue-token revokes the token when it cannot be installed", () => {
  const box = sandbox({ FAKE_FAIL_MATCH: "token.new" });
  const result = box.run(ISSUE_TOKEN, ISSUE_ARGS);

  assert.notEqual(result.status, 0);
  assert.ok(called(box.calls(), /^pveum user token remove claude-mcp@pve ci-runner-202611$/));
});

test("issue-token revokes the token when the file has the wrong owner or mode", () => {
  const box = sandbox({ FAKE_TOKEN_FILE_STAT: "root:root 644" });
  const result = box.run(ISSUE_TOKEN, ISSUE_ARGS);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected 'root:runner 640'/);
  assert.ok(called(box.calls(), /^pveum user token remove claude-mcp@pve ci-runner-202611$/));
});

test("issue-token never removes a token it did not create", () => {
  const box = sandbox({ FAKE_FAIL_MATCH: "token add" });
  const result = box.run(ISSUE_TOKEN, ISSUE_ARGS);

  assert.notEqual(result.status, 0);
  const calls = box.calls();
  assert.ok(!called(calls, /token remove/));
  assert.ok(!called(calls, /acl modify/));
});

test("issue-token issues nothing when the LXC is not ready", () => {
  const box = sandbox({ FAKE_FAIL_MATCH: "getent group runner" });
  const result = box.run(ISSUE_TOKEN, ISSUE_ARGS);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run provision\.sh first/);
  assert.ok(!called(box.calls(), /^pveum/));
});

// nftables.conf, evaluated by a small interpreter so the rule order is tested
// even where nft is not installed. It throws on any rule it does not understand.

function parseNft(text) {
  const defines = new Map();
  for (const [, name, values] of text.matchAll(/^define (\w+) = \{ (.*) \}$/gm)) {
    defines.set(name, values.split(", "));
  }
  const chains = new Map();
  for (const [, name, body] of text.matchAll(/chain (\w+) \{([^}]*)\}/g)) {
    const lines = body
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean);
    chains.set(name, { policy: /policy (\w+);/.exec(lines[0])[1], rules: lines.slice(1) });
  }
  return { defines, chains };
}

function ipv4ToNumber(ip) {
  return ip.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function inRange(ip, entry) {
  const [base, bits = "32"] = entry.split("/");
  const size = 2 ** (32 - Number(bits));
  const start = ipv4ToNumber(base);
  return ipv4ToNumber(ip) >= start && ipv4ToNumber(ip) < start + size;
}

// Verdict for the first packet of a new, non-loopback connection.
function verdict({ defines, chains }, chain, packet) {
  const ipv4 = !packet.daddr.includes(":");
  for (const rule of chains.get(chain).rules) {
    let rest = rule;
    let matches = true;
    for (;;) {
      let token;
      if ((token = /^(iif|oif) "lo" /.exec(rest))) {
        matches = false;
      } else if ((token = /^ct state established,related /.exec(rest))) {
        matches = false;
      } else if ((token = /^meta nfproto ipv4 /.exec(rest))) {
        matches &&= ipv4;
      } else if ((token = /^ip daddr \$(\w+) /.exec(rest))) {
        const set = defines.get(token[1]);
        assert.ok(set, `undefined set ${token[1]}`);
        matches &&= ipv4 && set.some((entry) => inRange(packet.daddr, entry));
      } else if ((token = /^(tcp|udp) (sport|dport) (\d+) /.exec(rest))) {
        matches &&= packet.proto === token[1] && packet[token[2]] === Number(token[3]);
      } else {
        break;
      }
      rest = rest.slice(token[0].length);
    }
    assert.ok(["accept", "reject"].includes(rest), `unsupported rule: ${rule}`);
    if (matches) return rest;
  }
  return chains.get(chain).policy;
}

const nft = parseNft(readFileSync(NFT_CONF, "utf8"));
const leaving = (proto, daddr, dport) => verdict(nft, "output", { proto, daddr, dport, sport: 40000 });

for (const ip of ["192.0.2.1", "192.0.2.1", "192.0.2.1"]) {
  test(`firewall allows the PVE API on ${ip} and blocks SSH and other ports`, () => {
    assert.equal(leaving("tcp", ip, 8006), "accept");
    assert.equal(leaving("tcp", ip, 22), "reject");
    assert.equal(leaving("tcp", ip, 443), "reject");
  });
}

test("firewall allows external 443 and DNS only", () => {
  assert.equal(leaving("tcp", "140.82.121.4", 443), "accept");
  assert.equal(leaving("udp", "1.1.1.1", 53), "accept");
  assert.equal(leaving("tcp", "1.1.1.1", 53), "accept");
  assert.equal(leaving("udp", "192.0.2.1", 53), "accept");

  assert.equal(leaving("tcp", "140.82.121.4", 80), "reject");
  assert.equal(leaving("tcp", "140.82.121.4", 22), "reject");
  assert.equal(leaving("udp", "8.8.8.8", 53), "reject");
});

test("firewall closes the rest of the LAN and the other private ranges", () => {
  for (const ip of ["192.0.2.1", "192.0.2.1", "192.0.2.1", "10.x.x.x", "172.x.x.x", "100.64.0.1", "169.254.169.254"]) {
    assert.equal(leaving("tcp", ip, 443), "reject", ip);
    assert.equal(leaving("tcp", ip, 8006), "reject", ip);
    assert.equal(leaving("tcp", ip, 22), "reject", ip);
  }
});

test("firewall rejects IPv6, even to port 443", () => {
  assert.equal(leaving("tcp", "2606:4700:4700::1111", 443), "reject");
});

test("firewall allows DHCP renewal and no new inbound connection", () => {
  const entering = (proto, sport, dport) => verdict(nft, "input", { proto, sport, dport, daddr: "192.0.2.1" });

  assert.equal(verdict(nft, "output", { proto: "udp", sport: 68, dport: 67, daddr: "192.0.2.1" }), "accept");
  assert.equal(entering("udp", 67, 68), "accept");
  assert.equal(entering("tcp", 40000, 22), "drop");
  assert.equal(entering("tcp", 40000, 8006), "drop");
  assert.equal(entering("tcp", 40000, 443), "drop");
});

test("firewall defaults to drop on every chain and has no forwarding rule", () => {
  for (const chain of ["input", "forward", "output"]) assert.equal(nft.chains.get(chain).policy, "drop");
  assert.deepEqual(nft.chains.get("forward").rules, []);
});

// Tooling

// Each script stands alone, so these helpers exist twice. Only provision.sh has
// words with quotes in them, so this also carries its coverage over.
test("both scripts carry the same copy of the shared helpers", () => {
  const helper = (file, name) => {
    const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m").exec(readFileSync(file, "utf8"));
    assert.ok(match, `${name} in ${file}`);
    return match[0];
  };
  for (const name of ["die", "usage_error", "need_value", "shell_join", "plan", "step", "ssh_node", "on_node"]) {
    assert.equal(helper(PROVISION, name), helper(ISSUE_TOKEN, name), name);
  }
});

test("the scripts are executable", () => {
  for (const script of SHELL_FILES) accessSync(script, constants.X_OK);
});

test("the scripts parse with bash -n", () => {
  const bash = findTool("bash");
  for (const script of SHELL_FILES) {
    const result = spawnSync(bash, ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("shellcheck passes", { skip: findTool("shellcheck") ? false : "shellcheck is not installed" }, () => {
  const result = spawnSync(findTool("shellcheck"), SHELL_FILES, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout);
});

test("nft accepts nftables.conf", { skip: findTool("nft") ? false : "nft is not installed" }, () => {
  const result = spawnSync(findTool("nft"), ["-c", "-f", NFT_CONF], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
