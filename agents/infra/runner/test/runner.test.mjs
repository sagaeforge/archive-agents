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

const PVE_NODES = ["192.0.2.1", "192.0.2.1", "192.0.2.1"];

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

// GET /cluster/status as a node answers it, with every node of nftables.conf
// online. `changes` replaces fields of the node at each address.
function clusterStatus(changes = {}) {
  const nodes = PVE_NODES.map((ip, i) => ({ type: "node", id: `node/n${i}`, name: `n${i}`, nodeid: i + 1, local: 0, level: "", online: 1, ip, ...changes[ip] }));
  return JSON.stringify([{ type: "cluster", id: "cluster", name: "test", nodes: nodes.length, quorate: 1, version: 3 }, ...nodes]);
}

const sandboxDirs = [];
after(() => {
  for (const dir of sandboxDirs) rmSync(dir, { recursive: true, force: true });
});

// `clock` fixes the instant date reports, and date formats it as usual.
function sandbox(env = {}, { clock } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
  sandboxDirs.push(dir);
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  for (const name of FAKE_TOOLS) symlinkSync(FAKE_TOOL, join(bin, name));
  for (const name of REAL_TOOLS) symlinkSync(findTool(name), join(bin, name));
  if (clock) {
    rmSync(join(bin, "date"));
    writeFileSync(join(bin, "date"), `#!${findTool("bash")}\nexec ${findTool("date")} -d '${clock}' "$@"\n`, { mode: 0o755 });
  }

  return {
    dir,
    // A soft size limit of zero kills whatever writes a byte to a regular file, so
    // no run can leave a secret in a local file. Only fake-tool.sh lifts it.
    run(script, args) {
      return spawnSync(join(bin, "bash"), ["-c", 'ulimit -S -f 0 && exec bash "$@"', "bash", script, ...args], {
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
    "apt-get install -y --no-install-recommends ca-certificates curl git nftables unattended-upgrades",
    "useradd --create-home --shell /bin/bash runner",
    "passwd --lock root",
    "apt-get purge -y sudo openssh-server",
    "sed -i 's#http://#https://#'",
    "https://github.com/actions/runner/releases/download/v",
    "sha256sum --check --strict",
    "bin/installdependencies.sh",
    "nft -c -f /etc/nftables.conf",
    "systemctl enable --now nftables",
    "# A node the cluster does not report online skips its 8006 probe, with a warning.",
    `[local] gh api -X POST repos/${REPO}/actions/runners/registration-token --jq .token | [pve-node] pct exec 101 -- runuser -l runner -c`,
    `./config.sh --unattended --replace --url https://github.com/${REPO} --name pve-runner-01 --labels proxmox`,
    "./svc.sh install runner",
    "./svc.sh start",
    "# Next: infra/runner/issue-token.sh --node pve-node --vmid 101",
  ]) {
    assert.ok(result.stdout.includes(expected), `plan is missing: ${expected}`);
  }
});

test("provision --dry-run unpacks the runner as the runner account, never as root", () => {
  const { stdout } = sandbox().run(PROVISION, ["--dry-run", "--node", "n1", "--vmid", "101"]);
  const unpack = stdout.split("\n").find((line) => line.includes("tar xzf"));
  assert.match(unpack, /pct exec 101 -- runuser -l runner -c /);
});

test("provision --dry-run applies and checks the firewall before the runner can register", () => {
  const result = sandbox().run(PROVISION, ["--dry-run", "--node", "pve-node", "--vmid", "101"]);
  assertInOrder(result.stdout.split("\n"), [
    /pvesh get \/cluster\/nextid/,
    /pveam download local/,
    /pct create 101/,
    /apt-get install/,
    /apt-get update --error-on=any/,
    /sha256sum --check/,
    /cat > \/etc\/nftables\.conf/,
    /nft -c -f/,
    /systemctl enable --now nftables/,
    /pct config 101/,
    /systemctl is-enabled nftables/,
    /sudo -n true/,
    /nft list ruleset/,
    /pvesh get \/cluster\/status/,
    /dev\/tcp\/192\.168\.0\.10\/22/,
    /dev\/tcp\/192\.168\.0\.10\/8006/,
    /dev\/tcp\/github\.com\/443/,
    /apt-get update --error-on=any/,
    /registration-token/,
    /svc\.sh install runner/,
    /require-firewall\.conf/,
    /--property=Requires,After/,
    /svc\.sh start/,
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
  // The default ID carries the local month. In UTC this instant is still October.
  const box = sandbox({ TZ: "KST-9" }, { clock: "2026-11-01T00:30:00+09:00" });
  const result = box.run(ISSUE_TOKEN, ["--dry-run", "--node", "pve-node", "--vmid", "101"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(box.calls(), [], "a dry run must not start any tool");

  for (const expected of [
    "[pve-node] pct exec 101 -- getent group runner",
    "[pve-node] pveum user token add claude-mcp@pve ci-runner-202611 --privsep 1 --expire ",
    "[pve-node] pveum acl modify / --tokens 'claude-mcp@pve!ci-runner-202611' --roles PVEAuditor",
    "curl --fail --silent --show-error --cacert /etc/pve/pve-root-ca.pem --header @- https://localhost:8006/api2/json/version",
    "https://localhost:8006/api2/json/access/permissions | python3 -c",
    "install -d -m 750 -o root -g runner /etc/proxmox-mcp",
    "(umask 077 && cat > /etc/proxmox-mcp/token.new)",
    "chown root:runner /etc/proxmox-mcp/token.new",
    "chmod 640 /etc/proxmox-mcp/token.new",
    `stat -c '%U:%G %a' /etc/proxmox-mcp/token.new`,
    "mv -f /etc/proxmox-mcp/token.new /etc/proxmox-mcp/token",
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
    /cat > \/etc\/proxmox-mcp\/token\.new/,
    /stat -c/,
    /mv -f \/etc\/proxmox-mcp\/token\.new/,
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
  ["an address with an octet above 255", PROVISION, ["--ip", "192.168.x.x/24"]],
  ["an address that is all out of range", PROVISION, ["--ip", "999.999.999.999/99"]],
  ["a prefix above 32", PROVISION, ["--ip", "192.0.2.1/33"]],
  ["an address with no prefix", PROVISION, ["--ip", "192.0.2.1"]],
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

test("provision takes a free address on the LAN", () => {
  const result = sandbox().run(PROVISION, ["--dry-run", "--node", "n1", "--vmid", "101", "--ip", "192.0.2.1/24"]);
  assert.equal(result.status, 0, result.stderr);
});

for (const ip of PVE_NODES) {
  test(`provision refuses ${ip}, which belongs to a cluster node`, () => {
    const box = sandbox();
    const result = box.run(PROVISION, ["--node", "n1", "--vmid", "101", "--ip", `${ip}/24`]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is the address of a cluster node/);
    assert.deepEqual(box.calls(), []);
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

test("a script under test cannot write a local file", () => {
  const box = sandbox();
  const writer = join(box.dir, "writer.sh");
  const target = join(box.dir, "written");
  writeFileSync(writer, 'printf secret > "$1"\n');

  assert.notEqual(box.run(writer, [target]).status, 0);
  assert.equal(readFileSync(target, "utf8"), "");
});

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

  const asRunner = ["runuser", "-u", "runner", "--"];
  assert.deepEqual(find("sudo -n true").argv.slice(3), [...asRunner, "bash", "-c", "! sudo -n true 2>/dev/null"]);
  assert.deepEqual(find("nft list ruleset").argv.slice(3), [...asRunner, "bash", "-c", "! /usr/sbin/nft list ruleset 2>/dev/null"]);
  assert.deepEqual(find("/dev/tcp/192.0.2.1/22").argv.slice(3), [...asRunner, "bash", "-c", "! timeout 5 bash -c 'exec 3<>/dev/tcp/192.0.2.1/22' 2>/dev/null"]);
  assert.deepEqual(find("/dev/tcp/192.0.2.1/8006").argv.slice(3), [...asRunner, "timeout", "5", "bash", "-c", "exec 3<>/dev/tcp/192.0.2.1/8006"]);

  assert.equal(
    find("20auto-upgrades").argv.at(-1),
    `printf '%s\\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades`,
  );

  const unit = "$(cat /home/runner/actions-runner/.service)";
  assert.equal(
    find("require-firewall.conf").argv.at(-1),
    `dir=/etc/systemd/system/${unit}.d && mkdir -p "$dir" && printf '%s\\n' '[Unit]' 'Requires=nftables.service' 'After=nftables.service' > "$dir/require-firewall.conf" && systemctl daemon-reload`,
  );
  assert.equal(
    find("--property=Requires,After").argv.at(-1),
    `test "$(systemctl show --property=Requires,After --value "${unit}" | grep -cwF nftables.service)" = 2`,
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
  assert.match(result.stdout, new RegExp(`Runner pve-runner-01 is online in LXC ${VMID} on ${NODE}\\. Took \\d+s\\.`));
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
  ["gh gives no answer on admin rights", { FAKE_GH_ADMIN: "" }, /^$/],
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

const NODE_1_DOWN = { "192.0.2.1": { online: 0 } };
const ALL_DOWN = Object.fromEntries(PVE_NODES.map((ip) => [ip, { online: 0 }]));

for (const [label, env, message] of [
  ["apt cannot use its https sources", { FAKE_FAIL_MATCH: "update --error-on=any" }, /forced failure/],
  ["the firewall does not parse", { FAKE_FAIL_MATCH: "nft -c" }, /forced failure/],
  ["the firewall does not load", { FAKE_FAIL_MATCH: "enable --now nftables" }, /forced failure/],
  ["the firewall table is missing", { FAKE_FAIL_MATCH: "nft list table" }, /forced failure/],
  ["the firewall is off for the next boot", { FAKE_FAIL_MATCH: "is-enabled nftables" }, /forced failure/],
  ["the LXC is privileged", { FAKE_PCT_CONFIG: "unprivileged: 0" }, /not unprivileged/],
  ["runner can use sudo", { FAKE_FAIL_MATCH: "sudo -n true" }, /can use sudo/],
  ["runner can read the firewall", { FAKE_FAIL_MATCH: "nft list ruleset" }, /can read the firewall/],
  ["node SSH is reachable", { FAKE_FAIL_MATCH: "/22" }, /192\.168\.0\.10:22 must be blocked/],
  ["the PVE API is blocked", { FAKE_FAIL_MATCH: "/8006" }, /192\.168\.0\.10:8006 must be reachable/],
  ["external 443 is blocked", { FAKE_FAIL_MATCH: "github.com/443" }, /github\.com:443 must be reachable/],
  ["apt fails through the firewall", { FAKE_FAIL_MATCH: "update --error-on=any", FAKE_FAIL_AFTER: "enable --now nftables" }, /apt cannot reach its mirrors/],
  ["the cluster status cannot be read", { FAKE_FAIL_MATCH: "cluster/status" }, /cannot read the cluster status/],
  ["the cluster status is not JSON", { FAKE_CLUSTER_STATUS: "<html>" }, /cannot read the cluster status/],
  ["an online node has no address", { FAKE_CLUSTER_STATUS: clusterStatus({ "192.0.2.1": { ip: undefined } }) }, /cannot read the cluster status/],
  ["the cluster reports no node online", { FAKE_CLUSTER_STATUS: clusterStatus(ALL_DOWN) }, /no node online/],
  ["an online node is not in the firewall", { FAKE_CLUSTER_STATUS: clusterStatus({ "192.0.2.1": { ip: "192.168.x.x" } }) }, /192\.168\.0\.30 is online but not in PVE_NODES/],
  ["an online node blocks the API while another node is down", { FAKE_CLUSTER_STATUS: clusterStatus(NODE_1_DOWN), FAKE_FAIL_MATCH: "/dev/tcp/192.0.2.1/8006" }, /192\.168\.0\.20:8006 must be reachable/],
  ["SSH to a down node is not rejected", { FAKE_CLUSTER_STATUS: clusterStatus(NODE_1_DOWN), FAKE_FAIL_MATCH: "/dev/tcp/192.0.2.1/22" }, /192\.168\.0\.10:22 must be blocked/],
]) {
  test(`provision never registers a runner when ${label}`, () => {
    const box = sandbox(env);
    const result = box.run(PROVISION, PROVISION_ARGS);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
    assert.ok(!called(box.calls(), /registration-token/));
  });
}

for (const [label, change] of [
  ["reported offline", { online: 0 }],
  ["reported offline with no address", { online: 0, ip: undefined }],
]) {
  test(`provision finishes with a node ${label}, skipping only that node's API probe`, () => {
    const box = sandbox({
      FAKE_CLUSTER_STATUS: clusterStatus({ "192.0.2.1": change }),
      FAKE_FAIL_MATCH: "/dev/tcp/192.0.2.1/8006",
    });
    const result = box.run(PROVISION, PROVISION_ARGS);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning: skipped 192\.168\.0\.10:8006/);

    const calls = box.calls();
    assert.ok(!called(calls, /\/dev\/tcp\/192\.168\.0\.10\/8006/));
    for (const expected of [/\/dev\/tcp\/192\.168\.0\.10\/22/, /\/dev\/tcp\/192\.168\.0\.11\/8006/, /\/dev\/tcp\/192\.168\.0\.20\/8006/, /registration-token/, /svc\.sh start/]) {
      assert.ok(called(calls, expected), String(expected));
    }
  });
}

for (const [label, env] of [
  ["the firewall requirement cannot be written", { FAKE_FAIL_MATCH: "require-firewall.conf" }],
  ["the service does not end up requiring the firewall", { FAKE_FAIL_MATCH: "--property=Requires,After" }],
]) {
  test(`provision never starts the runner when ${label}`, () => {
    const box = sandbox(env);
    const result = box.run(PROVISION, PROVISION_ARGS);

    assert.equal(result.status, 1);
    const calls = box.calls();
    assert.ok(!called(calls, /svc\.sh start/));
    // Enabled and onboot, the service would start on the next boot with no firewall behind it.
    assert.ok(called(calls, /svc\.sh uninstall/));
  });
}

test("a provision that gets past the firewall requirement leaves the service alone", () => {
  const box = sandbox();
  assert.equal(box.run(PROVISION, PROVISION_ARGS).status, 0);
  assert.ok(!called(box.calls(), /svc\.sh uninstall/));
});

test("a failed uninstall says what is left, and the provision still fails", () => {
  const box = sandbox({ FAKE_FAIL_MATCH: "require-firewall.conf", FAKE_FAIL_ALSO: "svc.sh uninstall" });
  const result = box.run(PROVISION, PROVISION_ARGS);

  assert.equal(result.status, 1);
  assert.ok(called(box.calls(), /svc\.sh uninstall/));
  assert.match(result.stderr, new RegExp(`Could not remove the runner service\\. Do not reboot LXC ${VMID}`));
});

test("provision fails when the runner never comes online, and leaves the LXC alone", () => {
  const box = sandbox({ FAKE_RUNNER_STATE: "offline false" });
  const result = box.run(PROVISION, PROVISION_ARGS);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not online; last state: offline false/);
  assert.match(result.stderr, new RegExp(`pct destroy ${VMID}`));
  assert.ok(!called(box.calls(), /pct (destroy|stop)/), "the hint must not be executed");
});

test("a runner busy with a job that was queued for it counts as online", () => {
  const result = sandbox({ FAKE_RUNNER_STATE: "online true" }).run(PROVISION, PROVISION_ARGS);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Next: /m);
});

// Defect 35: what a retry is for.

test("provision waits out a network that takes a while to come up", () => {
  const box = sandbox({ FAKE_FAIL_MATCH: "getent hosts", FAKE_FAIL_FIRST: "4" });
  const result = box.run(PROVISION, PROVISION_ARGS);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.calls().filter((call) => call.tool === "pct" && /getent hosts/.test(call.text)).length, 5);
});

test("provision rides out gh failing while the runner comes online", () => {
  const result = sandbox({ FAKE_FAIL_MATCH: "actions/runners --jq", FAKE_FAIL_FIRST: "2" }).run(PROVISION, PROVISION_ARGS);
  assert.equal(result.status, 0, result.stderr);
});

test("a run never prompts over ssh, in either script", () => {
  for (const [script, args] of [
    [PROVISION, PROVISION_ARGS],
    [ISSUE_TOKEN, ISSUE_ARGS],
  ]) {
    const box = sandbox();
    assert.equal(box.run(script, args).status, 0);
    const calls = box.calls().filter((call) => call.tool === "ssh");
    assert.notEqual(calls.length, 0);
    for (const call of calls) assert.ok(call.argv.includes("BatchMode=yes"), call.text);
  }
});

test("issue-token never exports the token, which would show in every child's environment", () => {
  assert.doesNotMatch(readFileSync(ISSUE_TOKEN, "utf8"), /^\s*(?:export|declare -x)\b/m);
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
      /^pct exec 205 -- stat -c %U:%G %a \/etc\/proxmox-mcp\/token\.new$/,
      /^pct exec 205 -- mv -f \/etc\/proxmox-mcp\/token\.new \/etc\/proxmox-mcp\/token$/,
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
  ["pveum prints no value", { FAKE_PVE_SECRET: "" }, /returned no token value/],
  ["its privileges go beyond audit", { FAKE_PERMISSIONS: JSON.stringify({ data: { "/": { "Sys.Audit": 1, "VM.PowerMgmt": 1 } } }) }, /VM\.PowerMgmt/],
  ["a write privilege sits below /", { FAKE_PERMISSIONS: JSON.stringify({ data: { "/": { "VM.Audit": 1 }, "/vms/100": { "VM.Audit": 1, "VM.Allocate": 1 } } }) }, /VM\.Allocate/],
  ["a privilege name only contains Audit", { FAKE_PERMISSIONS: JSON.stringify({ data: { "/": { "Sys.Audit": 1, "Sys.AuditLog": 1 } } }) }, /Sys\.AuditLog/],
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

for (const [label, env, message] of [
  ["the new file has the wrong owner or mode", { FAKE_TOKEN_FILE_STAT: "root:root 644" }, /token\.new is 'root:root 644', expected 'root:runner 640'/],
  ["the new file cannot be checked", { FAKE_FAIL_MATCH: "stat -c" }, /forced failure/],
]) {
  test(`issue-token leaves the previous token in place when ${label}`, () => {
    const box = sandbox(env);
    const result = box.run(ISSUE_TOKEN, ISSUE_ARGS);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    const calls = box.calls();
    assert.ok(called(calls, /^pveum user token remove claude-mcp@pve ci-runner-202611$/));
    assert.ok(!called(calls, /mv -f/), "the swap must not run");
  });
}

test("issue-token revokes the new token when the swap fails", () => {
  const box = sandbox({ FAKE_FAIL_MATCH: "mv -f" });
  const result = box.run(ISSUE_TOKEN, ISSUE_ARGS);

  assert.notEqual(result.status, 0);
  assert.ok(called(box.calls(), /^pveum user token remove claude-mcp@pve ci-runner-202611$/));
});

test("a revoke that fails leaves a command to run by hand, and the run still fails", () => {
  const box = sandbox({ FAKE_FAIL_MATCH: "ci-runner-202611", FAKE_FAIL_AFTER: "acl modify" });
  const result = box.run(ISSUE_TOKEN, ISSUE_ARGS);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not revoke it\. Run on the node: pveum user token remove claude-mcp@pve ci-runner-202611/);
  assertNoLeak(result, box.calls(), PVE_SECRET);
});

test("issue-token never removes a token it did not create", () => {
  const box = sandbox({ FAKE_FAIL_MATCH: "token add" });
  const result = box.run(ISSUE_TOKEN, ISSUE_ARGS);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not issue ci-runner-202611\..*--token-id/);
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
    chains.set(name, { hook: /hook (\w+)/.exec(lines[0])[1], policy: /policy (\w+);/.exec(lines[0])[1], rules: lines.slice(1) });
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

test("firewall lists exactly the PVE nodes and the resolvers", () => {
  assert.deepEqual(nft.defines.get("PVE_NODES"), PVE_NODES);
  assert.deepEqual(nft.defines.get("DNS_SERVERS"), ["1.1.1.1", "192.0.2.1"]);
});

for (const ip of PVE_NODES) {
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
  assert.equal(leaving("udp", "140.82.121.4", 443), "reject");
  assert.equal(leaving("udp", "8.8.8.8", 53), "reject");
});

// Both ends of every range, because a narrowed range still holds any address in its middle.
const CLOSED_RANGES = [
  ["0.0.0.0", "0.255.255.255"],
  ["10.0.0.0", "10.x.x.x"],
  ["100.64.0.0", "100.127.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.x.x.x"],
  ["192.168.x.x", "192.168.x.x"],
  ["224.0.0.0", "255.255.255.255"],
];

test("firewall closes the rest of the LAN and the other private ranges", () => {
  for (const ip of ["192.0.2.1", "192.0.2.1", "192.0.2.1", "169.254.169.254", ...CLOSED_RANGES.flat()]) {
    assert.equal(leaving("tcp", ip, 443), "reject", ip);
    assert.equal(leaving("tcp", ip, 8006), "reject", ip);
    assert.equal(leaving("tcp", ip, 22), "reject", ip);
  }
});

test("firewall keeps port 443 open right up to the edge of each closed range", () => {
  for (const ip of ["1.0.0.0", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0", "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "223.255.255.255"]) {
    assert.equal(leaving("tcp", ip, 443), "accept", ip);
  }
});

test("firewall rejects IPv6, even to port 443", () => {
  assert.equal(leaving("tcp", "2606:4700:4700::1111", 443), "reject");
});

test("firewall allows DHCP renewal and no new inbound connection", () => {
  const entering = (proto, sport, dport) => verdict(nft, "input", { proto, sport, dport, daddr: "192.0.2.1" });

  assert.equal(verdict(nft, "output", { proto: "udp", sport: 68, dport: 67, daddr: "192.0.2.1" }), "accept");
  assert.equal(entering("udp", 67, 68), "accept");
  // Only the DHCP client's own port, or this is a way out to anything listening on 67.
  assert.equal(verdict(nft, "output", { proto: "udp", sport: 40000, dport: 67, daddr: "192.0.2.1" }), "reject");
  assert.equal(entering("udp", 40000, 68), "drop");
  assert.equal(entering("tcp", 40000, 22), "drop");
  assert.equal(entering("tcp", 40000, 8006), "drop");
  assert.equal(entering("tcp", 40000, 443), "drop");
});

test("firewall defaults to drop on every chain and has no forwarding rule", () => {
  for (const chain of ["input", "forward", "output"]) assert.equal(nft.chains.get(chain).policy, "drop");
  assert.deepEqual(nft.chains.get("forward").rules, []);
});

test("firewall replaces the whole ruleset and hooks each chain by its name", () => {
  const text = readFileSync(NFT_CONF, "utf8");

  assert.match(text, /^flush ruleset$/m);
  assert.match(text, /^table inet runner \{$/m);
  for (const chain of ["input", "forward", "output"]) assert.equal(nft.chains.get(chain).hook, chain);
  for (const chain of ["input", "output"]) assert.ok(nft.chains.get(chain).rules.includes("ct state established,related accept"), chain);
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

test("nft accepts nftables.conf", { skip: findTool("nft") ? false : "nft is not installed" }, (t) => {
  const check = (input) => spawnSync(findTool("nft"), ["-c", "-f", "-"], { encoding: "utf8", input });
  const conf = readFileSync(NFT_CONF, "utf8");

  // Without CAP_NET_ADMIN, nft still parses and evaluates the whole file, and only
  // the kernel's own check of the batch is refused. Nothing else is tolerated.
  const refused = /Could not process rule: Operation not permitted/;
  const result = check(conf);
  if (refused.test(result.stderr)) {
    t.diagnostic("parsed and evaluated only: the kernel check needs CAP_NET_ADMIN");
  } else {
    assert.equal(result.status, 0, result.stderr);
  }

  const broken = check(conf.replace("policy drop;", "policy dorp;"));
  assert.notEqual(broken.status, 0);
  assert.doesNotMatch(broken.stderr, refused);
});
