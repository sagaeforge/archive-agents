// Shared helpers. Hook scripts run directly with HOME set to a fake home. Full
// sessions run the real Claude Code binary inside bwrap, with the real home hidden
// and only loopback networking, against mock-api.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, "../../..");
export const hooksDir = path.join(repoRoot, ".claude/hooks");
export const realHome = os.homedir();

const nodeRoot = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
const rtkInstall = path.join(realHome, ".local/bin/rtk");
const trailInstall = path.join(realHome, ".local/share/trail-code");
const pinnedTrail = ".local/share/trail-code/0.28.1/node_modules/.bin/trail";

// The chain Claude Code would use to run a hook command: a small PATH, no user rc.
const basePath = `${path.join(nodeRoot, "bin")}:/usr/bin:/bin`;

const onPath = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;

export const hasRealRtk = () => fs.existsSync(rtkInstall);
export const hasRealTrail = () => fs.existsSync(path.join(realHome, pinnedTrail));

function claudeBinary() {
  try {
    return fs.realpathSync(path.join(realHome, ".local/bin/claude"));
  } catch {
    return null;
  }
}

/** Why session tests cannot run here, or null when they can. */
export function sessionSkipReason() {
  if (!onPath("bwrap")) return "bwrap is not installed";
  if (!claudeBinary()) return "no Claude Code binary at ~/.local/bin/claude";
  if (!hasRealRtk()) return "rtk is not installed";
  if (!hasRealTrail()) return "Trail-Code 0.28.1 is not installed";
  return null;
}

export const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const tempDirs = [];
process.on("exit", () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

export function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `project-hooks-${label}-`));
  tempDirs.push(dir);
  return dir;
}

export function writeFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

/** A fake home for running one hook script directly. */
export function fakeHome({ rtk, trail } = {}) {
  const home = tempDir("home");
  if (rtk === "real") {
    fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    fs.symlinkSync(rtkInstall, path.join(home, ".local/bin/rtk"));
  } else if (rtk) {
    writeFile(path.join(home, ".local/bin/rtk"), rtk, 0o755);
  }
  if (trail === "real") {
    fs.mkdirSync(path.join(home, ".local/share"), { recursive: true });
    fs.symlinkSync(trailInstall, path.join(home, ".local/share/trail-code"));
  } else if (trail) {
    writeFile(path.join(home, pinnedTrail), trail, 0o755);
  }
  return home;
}

/** Runs one hook script the way the settings file does, with a clean environment. */
export function runHook(script, input, { home, project, cwd, env = {}, shell = "sh", pathValue = basePath, timeout = 40000 }) {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const started = Date.now();
  const result = spawnSync(shell, [path.join(hooksDir, script)], {
    input: stdin,
    cwd: cwd ?? project ?? home,
    encoding: "utf8",
    timeout,
    env: { HOME: home, PATH: pathValue, ...(project ? { CLAUDE_PROJECT_DIR: project } : {}), ...env },
  });
  return { rc: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started };
}

/** A PATH that holds only the named tools, to simulate one going missing. */
export function restrictedPath(tools) {
  const dir = tempDir("path");
  for (const tool of tools) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    fs.symlinkSync(found, path.join(dir, tool));
  }
  return dir;
}

/** A copy of this checkout's tracked and new files in a fresh git repository. */
export function copyRepo(target) {
  const files = git(repoRoot, "ls-files", "--cached", "--others", "--exclude-standard")
    .split("\n")
    .filter(Boolean);
  for (const file of files) {
    const source = path.join(repoRoot, file);
    if (!fs.existsSync(source)) continue;
    writeFile(path.join(target, file), fs.readFileSync(source), fs.statSync(source).mode);
  }
  git(target, "init", "-q", "-b", "main");
  git(target, "config", "user.email", "sandbox@example.invalid");
  git(target, "config", "user.name", "sandbox");
  git(target, "add", "-A");
  git(target, "commit", "-qm", "copy of the branch under test");
  return target;
}

const shimLog = "shim.log";
const argSeparator = "\x1f";

// One line per call, with arguments split by a byte no argument here contains.
const logArgv = (tool, logs) =>
  `{ printf '%s' ${tool}; for arg in "$@"; do printf '\\037%s' "$arg"; done; echo; } >> ${logs}/${shimLog}`;

// Logged and refused: a hook has no business calling these.
const refusedTools = ["npm", "npx", "gh", "curl", "wget", "ssh"];

/** A fake home and work area for a sealed session. */
export function sessionCase(label, { rtkStub, trailStub } = {}) {
  const dir = tempDir(label);
  const home = path.join(dir, "home");
  const logs = path.join(dir, "logs");
  const work = path.join(dir, "work");
  const shims = path.join(dir, "shims");
  for (const sub of [home, logs, work, shims]) fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".local/share"), { recursive: true });
  writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = sandbox\n\temail = sandbox@example.invalid\n");
  for (const tool of refusedTools) {
    writeFile(path.join(shims, tool), `#!/bin/sh\n${logArgv(tool, logs)}\nexit 1\n`, 0o755);
  }
  writeFile(path.join(shims, "git"), `#!/bin/sh\n${logArgv("git", logs)}\nexec /usr/bin/git "$@"\n`, 0o755);
  if (rtkStub) writeFile(path.join(home, ".local/bin/rtk"), rtkStub, 0o755);
  if (trailStub) writeFile(path.join(home, pinnedTrail), trailStub, 0o755);
  return { dir, home, logs, work, shims, rtkStub, trailStub, runs: 0 };
}

function sandboxArgs(box, { managedDir, hide = [] }) {
  const claude = path.join(box.dir, "claude-bin");
  if (!fs.existsSync(claude)) fs.writeFileSync(claude, "");
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--bind", box.dir, box.dir,
    "--bind", box.home, realHome,
    "--ro-bind", claudeBinary(), claude,
  ];
  if (!box.rtkStub && hasRealRtk()) args.push("--ro-bind", rtkInstall, path.join(realHome, ".local/bin/rtk"));
  if (!box.trailStub && hasRealTrail()) args.push("--ro-bind", trailInstall, path.join(realHome, ".local/share/trail-code"));
  if (nodeRoot.startsWith(`${realHome}/`)) args.push("--ro-bind", nodeRoot, nodeRoot);
  if (managedDir) {
    args.push("--overlay-src", "/etc", "--tmp-overlay", "/etc", "--ro-bind", managedDir, "/etc/claude-code");
  }
  for (const tool of hide) if (fs.existsSync(tool)) args.push("--ro-bind", "/dev/null", tool);
  args.push("--unshare-net", "--unshare-pid", "--die-with-parent", "--clearenv");
  return args;
}

/** Runs any command inside the same seal, under the case's fake home. */
export function sealed(box, cwd, command, { env = {}, timeout = 60000 } = {}) {
  const args = [
    ...sandboxArgs(box, {}),
    "--chdir", cwd,
    ...envArgs(box, env),
    ...command,
  ];
  return spawnSync("bwrap", args, { encoding: "utf8", timeout });
}

function envArgs(box, extra) {
  const pathValue = extra.PATH ?? `${box.shims}:${path.join(realHome, ".local/bin")}:${basePath}`;
  const env = {
    HOME: realHome,
    USER: "sandbox",
    LANG: "C.UTF-8",
    TERM: "dumb",
    SHELL: "/bin/bash",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
    PATH: pathValue,
  };
  return Object.entries(env).flatMap(([key, value]) => ["--setenv", key, String(value)]);
}

const driver = `
"$NODE_BIN" "$MOCK_FILE" &
for _ in $(seq 1 100); do [ -e "$MOCK_READY" ] && break; sleep 0.05; done
"$CLAUDE_BIN" -p "$PROMPT" --setting-sources "$SETTING_SOURCES" --output-format stream-json --verbose --include-hook-events --model sonnet "$@" > "$RUN_DIR/out.ndjson" 2> "$RUN_DIR/err.txt"
echo $? > "$RUN_DIR/rc"
kill %1 2>/dev/null
`;

function parseLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** What a session did, as the mock API and the stream-json output saw it. */
function readRun(dir) {
  const events = parseLines(path.join(dir, "out.ndjson"));
  const api = parseLines(path.join(dir, "mock.jsonl"));
  const hooks = events.filter((event) => event.type === "system" && event.subtype === "hook_response");
  const results = new Map();
  for (const request of api) {
    for (const message of request.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        results.set(block.tool_use_id, { text, isError: Boolean(block.is_error) });
      }
    }
  }
  const final = events.find((event) => event.type === "result");
  const rcFile = path.join(dir, "rc");
  return {
    rc: fs.existsSync(rcFile) ? Number(fs.readFileSync(rcFile, "utf8")) : null,
    events,
    api,
    apiText: JSON.stringify(api),
    hooks,
    results: [...results.values()],
    denials: final?.permission_denials ?? [],
    final,
    stderr: fs.existsSync(path.join(dir, "err.txt")) ? fs.readFileSync(path.join(dir, "err.txt"), "utf8") : "",
  };
}

/**
 * Runs one headless session with the real binary and a scripted model.
 * Settings sources are named explicitly: the fake home's user settings, then the
 * project and local files of the directory the session starts in.
 */
export function session(box, { cwd, steps, substeps, prompt = "please go ahead", args = [], env = {}, settingSources = "user,project,local", managedDir, hide, timeout = 90000 }) {
  const run = path.join(box.logs, `run-${++box.runs}`);
  fs.mkdirSync(run, { recursive: true });
  const scriptFile = path.join(run, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify({ steps, substeps }));
  const mockFile = path.join(box.dir, "mock-api.mjs");
  if (!fs.existsSync(mockFile)) fs.copyFileSync(path.join(here, "mock-api.mjs"), mockFile);
  const port = 20000 + crypto.randomInt(20000);
  const sessionEnv = {
    ANTHROPIC_API_KEY: "sk-ant-sandbox-offline",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    NODE_BIN: path.join(nodeRoot, "bin/node"),
    MOCK_FILE: mockFile,
    MOCK_PORT: port,
    MOCK_SCRIPT: scriptFile,
    MOCK_LOG: path.join(run, "mock.jsonl"),
    MOCK_READY: path.join(run, "mock.ready"),
    CLAUDE_BIN: path.join(box.dir, "claude-bin"),
    RUN_DIR: run,
    PROMPT: prompt,
    SETTING_SOURCES: settingSources,
    ...env,
  };
  const started = Date.now();
  const bwrapArgs = [
    ...sandboxArgs(box, { managedDir, hide }),
    "--chdir", cwd,
    ...envArgs(box, sessionEnv),
    "/bin/bash", "-c", driver, "--", ...args,
  ];
  spawnSync("bwrap", bwrapArgs, { encoding: "utf8", timeout });
  return { ...readRun(run), ms: Date.now() - started, runDir: run };
}

/** The PreToolUse rewrites a session applied, as hook JSON. */
export function rewrites(run) {
  return run.hooks.flatMap((hook) => {
    try {
      const output = JSON.parse(hook.stdout ?? "");
      const command = output.hookSpecificOutput?.updatedInput?.command;
      return command ? [command] : [];
    } catch {
      return [];
    }
  });
}

/** Every logged call as its argv, so a subcommand can be read past global options. */
export const shimCalls = (box) => {
  const file = path.join(box.logs, shimLog);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => line.split(argSeparator));
};

/** A logged git call from its subcommand on, past options such as `-c key=value`. */
export function gitCommand([, ...args]) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "-C") i++;
    else if (!args[i].startsWith("-")) return args.slice(i).join(" ");
  }
  return "";
}

// Paths the sandbox mounts into the fake home. They are tools, not state.
const mounts = [/^\.local\/bin\/rtk$/, /^\.local\/share\/trail-code(\/|$)/, /^\.nvm(\/|$)/];

/** Every path under a home with its content hash. */
export function snapshot(home) {
  const seen = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(home, full);
      if (mounts.some((mount) => mount.test(relative))) continue;
      if (entry.isDirectory()) {
        seen.set(relative, "dir");
        walk(full);
      } else if (entry.isFile()) {
        seen.set(relative, sha256(full));
      } else {
        seen.set(relative, "other");
      }
    }
  };
  walk(home);
  return seen;
}

export function snapshotDiff(before, after) {
  const changed = [];
  for (const [file, hash] of after) {
    if (!before.has(file)) changed.push(`added ${file}`);
    else if (before.get(file) !== hash) changed.push(`changed ${file}`);
  }
  for (const file of before.keys()) if (!after.has(file)) changed.push(`removed ${file}`);
  return changed.sort();
}

/** Strips what differs per run, so two sessions' writes can be compared. */
export function pathShape(entry) {
  return entry
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\.claude\/projects\/[^/]+/g, ".claude/projects/<slug>")
    .replace(/\d{6,}/g, "<n>")
    .replace(/agent-[0-9a-z]+/g, "agent-<id>");
}
