#!/usr/bin/env python3
"""PreToolUse guard for the role agents in .claude/agents/.

Usage (from an agent's frontmatter hook):
    python3 -I "${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-guard.py" \
        --bash <bash-policy> --write <write-policy> [--kb-db]

Fallback (from .claude/settings.json, for teammates whose frontmatter hooks do
not attach):
    python3 -I "${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-guard.py" --by-agent-type
The hook input's `agent_type` picks the policy from AGENT_POLICIES. No
agent_type (the lead) or an unknown type passes unchanged.

Reads the hook input JSON on stdin. Exit 0 lets the call run; exit 2 blocks it
and the stderr text reaches the agent as the reason.

Fail closed. Bad input, an unknown policy or an internal error blocks the call.
This is the opposite of rtk-rewrite.sh, which fails open: that hook only
shortens output, while this one carries a limit the agent's prompt promises.

Tool input is data. It is parsed and compared, never executed or echoed back
beyond a path or a short command name.

Strength (see docs/project-tools.md):
- relay-write / relay-read: allow-list. Only the single agent-run call passes.
- write policies: path prefix after realpath. Strong.
- bash-readonly / bash-test / bash-commit / bash-impl: deny-list over a shell
  parse. Stops mistakes, not a determined agent (python3 -c, node -e and
  similar can still write). It is not a sandbox.
"""
import json
import os
import re
import shlex
import sys
from pathlib import Path

PROJ = Path(os.environ.get("CLAUDE_PROJECT_DIR") or Path(__file__).resolve().parents[2]).resolve()
HOME = Path.home()
KB_REPO = HOME / "sagae-knowloge-base"
KB_DATA = HOME / "sagae-kb-data"
SCRATCH_ROOTS = [Path("/var/tmp/claude-1000"), Path("/tmp")]
DEV_OK = {"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"}
# Global agent config and other repos: never written by a role agent.
GLOBAL_PROTECTED = [HOME / ".claude", HOME / ".codex", HOME / ".config", HOME / ".local", HOME / ".ssh"]

SECRET_NAME = re.compile(
    r"(^|/)(\.env(\.(?!example$|sample$|template$)[^/]*)?|[^/]*\.pem|[^/]*\.key|id_rsa[^/]*|id_ed25519[^/]*"
    r"|\.credentials[^/]*|auth\.json|\.netrc|\.npmrc|\.pypirc)$"
)
KB_DB_NAME = re.compile(r"\.(sqlite3?|db)(-wal|-shm|-journal)?$")

GIT_WRITE = {
    "commit", "push", "add", "rm", "mv", "reset", "checkout", "switch", "restore", "stash", "clean",
    "apply", "am", "rebase", "merge", "cherry-pick", "revert", "tag", "branch", "config", "worktree",
    "pull", "fetch", "submodule", "notes", "gc", "prune", "update-ref", "update-index", "init", "clone",
    "filter-branch", "replace", "bisect", "sparse-checkout", "lfs",
}
GIT_COMMITTER_OK = {"diff", "add", "restore", "commit", "log", "show", "status", "rev-parse", "ls-files", "check-ignore", "cat-file"}
GIT_READ_OK = {"diff", "log", "show", "status", "rev-parse", "ls-files", "blame", "grep", "cat-file", "check-ignore",
               "merge-base", "describe", "shortlog", "ls-tree", "name-rev", "for-each-ref", "rev-list", "whatchanged"}
WRITE_CMDS = {"rm", "rmdir", "mv", "cp", "ln", "chmod", "chown", "chgrp", "truncate", "tee", "touch",
              "install", "mkdir", "unlink", "shred", "rsync", "patch"}
DEST_LAST = {"cp", "mv", "rsync", "ln", "install"}
SHELLS = {"bash", "sh", "zsh", "dash"}
INSTALLERS = {"npm", "npx", "pnpm", "yarn", "bun", "bunx", "pip", "pip3", "pipx", "uv", "apt", "apt-get", "brew", "cargo", "go", "gem"}
INSTALL_VERBS = {"install", "i", "add", "ci", "update", "upgrade", "uninstall", "remove", "rm", "link", "get"}
TEST_RUNNERS = {"npm", "npx", "pnpm", "yarn", "bun", "bunx", "node", "vitest", "playwright", "jest", "pytest", "tsx", "deno"}
# Only flags that rewrite repo files or hide a missing suite. Filters such as --grep can be part of
# the command the lead gives, which this hook cannot see, so they stay prompt-only.
TEST_BANNED_FLAGS = re.compile(r"^(--update(-snapshots)?(=.*)?|-u|--updateSnapshot|--passWithNoTests)$")
PREFIX_WORDS = {"sudo", "env", "command", "builtin", "exec", "nohup", "time", "nice", "stdbuf", "xargs"}
SEGMENT_OPS = {";", ";;", "&&", "||", "|", "&", "|&", "(", ")", "!"}
KEYWORDS = {"{", "}", "do", "then", "else", "elif", "fi", "done", "if", "while", "until", "for", "case", "esac", "function", "time"}
KNOWN_PUNCT = sorted(SEGMENT_OPS | {">", ">>", ">|", "&>", "&>>", "<>", ">&", ">>&", "<", "<<", "<<<", "<&"}, key=len, reverse=True)
REDIRECT_OPS = {">", ">>", ">|", "&>", "&>>", "<>"}


# Same arguments as each .claude/agents/<name>.md frontmatter hook. test_agent_guard.py
# compares this table with the frontmatter so the two cannot drift apart.
AGENT_POLICIES = {
    "code-reviewer": ["--bash", "bash-readonly", "--write", "no-write"],
    "committer": ["--bash", "bash-commit", "--write", "no-write"],
    "contract-liaison": ["--bash", "bash-readonly", "--write", "no-write", "--kb-db"],
    "debugger": ["--bash", "bash-impl", "--write", "write-impl"],
    "doc-writer": ["--bash", "bash-readonly", "--write", "write-docs"],
    "implementer-codex": ["--bash", "relay-write", "--write", "no-write"],
    "implementer": ["--bash", "bash-impl", "--write", "write-impl"],
    "security-reviewer-codex": ["--bash", "relay-read", "--write", "no-write"],
    "test-runner": ["--bash", "bash-test", "--write", "no-write"],
    "ux-designer": ["--bash", "bash-readonly", "--write", "write-scratch"],
    "visual-verifier": ["--bash", "bash-readonly", "--write", "no-write", "--net-local"],
}


class Block(Exception):
    pass


def block(msg):
    raise Block(msg)


def resolve(p, cwd):
    p = os.path.expanduser(p)
    base = Path(cwd) if cwd else PROJ
    q = Path(p) if os.path.isabs(p) else base / p
    return Path(os.path.realpath(q))


def under(p, root):
    try:
        p.relative_to(root.resolve())
        return True
    except ValueError:
        return False


def in_scratch(p, extra=()):
    roots = list(SCRATCH_ROOTS) + [Path(x) for x in extra if x]
    return any(under(p, r) for r in roots)


def is_secret(token):
    t = token.strip("'\"")
    if any(c in t for c in "*?[]|$\\^(){}"):
        return False  # a pattern or expression, not a path
    return bool(SECRET_NAME.search(t)) or "/.claude/.credentials" in t


# ---------- write tools ----------

def check_write(policy, tool, ti, data):
    path = ti.get("file_path") or ti.get("notebook_path") or ti.get("path")
    if not isinstance(path, str) or not path:
        block(f"{tool} without a file path")
    p = resolve(path, data.get("cwd"))
    if is_secret(str(p)):
        block(f"writing a secret-like file ({p.name})")
    if policy == "no-write":
        block(f"this role never uses {tool}")
    scratch_extra = [data.get("scratchpad_dir")]
    if policy == "write-scratch":
        if in_scratch(p, scratch_extra):
            return
        block(f"{tool} outside the scratchpad: {p}")
    if policy == "write-docs":
        rel = p.relative_to(PROJ) if under(p, PROJ) else None
        if rel is not None and (rel.parts[:1] == ("docs",) or (len(rel.parts) >= 3 and rel.parts[0] == "tools" and rel.parts[2] == "docs")):
            return
        block(f"{tool} outside docs/ and tools/*/docs/: {p}")
    if policy == "write-impl":
        if in_scratch(p, scratch_extra):
            return
        if not under(p, PROJ):
            block(f"{tool} outside the project and scratchpad: {p}")
        rel = p.relative_to(PROJ)
        if rel.parts[:1] in ((".claude",), (".git",), ("node_modules",)) or str(rel) == "CLAUDE.md" or "node_modules" in rel.parts:
            block(f"{tool} on agent config, git internals or node_modules: {rel}")
        return
    block(f"unknown write policy {policy!r}")


# ---------- read tools ----------

def check_read(tool, ti, data, kb_db):
    path = ti.get("file_path") or ti.get("path") or ""
    if not path:
        return
    p = resolve(path, data.get("cwd"))
    if is_secret(str(p)):
        block(f"{tool} on a secret-like file ({p.name})")
    if kb_db and KB_DB_NAME.search(p.name) and (under(p, KB_REPO) or under(p, KB_DATA)):
        block(f"{tool} on a KB database file ({p.name}); read the contract instead")


# ---------- bash ----------

HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def strip_heredocs(cmd):
    """Drop heredoc bodies; their text is data for the command, not shell."""
    out, lines, i = [], cmd.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        tags = [m.group(2) for m in HEREDOC.finditer(line)]
        i += 1
        for tag in tags:
            while i < len(lines) and lines[i].strip() != tag:
                i += 1
            i += 1  # skip the closing tag
    return "\n".join(out)


def tokenize(cmd):
    lex = shlex.shlex(cmd.replace("\n", " ; "), posix=True, punctuation_chars=";&|()<>")
    lex.whitespace_split = True
    lex.commenters = "#"
    try:
        raw = list(lex)
    except ValueError:
        block("cannot parse the command (unbalanced quotes); split it into simpler commands")
    out = []
    for t in raw:
        if t and all(c in ";&|()<>" for c in t) and t not in KNOWN_PUNCT:
            while t:  # split glued operators such as ')>' greedily
                op = next((k for k in KNOWN_PUNCT if t.startswith(k)), t[0])
                out.append(op)
                t = t[len(op):]
        else:
            out.append(t)
    return out


def segments(tokens):
    seg, segs = [], []
    for t in tokens:
        if t in SEGMENT_OPS:
            if seg:
                segs.append(seg)
            seg = []
        elif not seg and t in KEYWORDS:
            continue
        else:
            seg.append(t)
    if seg:
        segs.append(seg)
    return segs


def split_redirects(seg):
    """Return (words, [(op, target)]). Handles '2>' '>&' '&>' '>>' forms after shlex."""
    words, reds, i = [], [], 0
    while i < len(seg):
        t = seg[i]
        if t in ("<", "<<", "<<<", "<&"):
            i += 2
            continue
        if t in REDIRECT_OPS or t in (">&", ">>&"):
            if words and words[-1].isdigit() and t != "&>":
                words.pop()
            target = seg[i + 1] if i + 1 < len(seg) else ""
            if t in (">&", ">>&") or target.startswith("&") or target.isdigit() or target == "-":
                i += 2
                continue
            reds.append((t, target))
            i += 2
            continue
        words.append(t)
        i += 1
    return words, reds


def head_word(words):
    i = 0
    while i < len(words):
        w = words[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w):
            i += 1
            continue
        base = os.path.basename(w)
        if base in PREFIX_WORDS:
            i += 1
            continue
        if base == "timeout":
            i += 1
            while i < len(words) and (words[i].startswith("-") or re.match(r"^\d+[smhd]?$", words[i])):
                i += 1
            continue
        return base, words[i + 1:]
    return "", []


def git_sub(args):
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-C", "-c", "--git-dir", "--work-tree", "--namespace"):
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        return a, args[i + 1:]
    return "", []


def path_args(args):
    return [a for a in args if not a.startswith("-")]


def check_write_target(target, data, what):
    if target in DEV_OK:
        return
    if "$" in target or "`" in target or "*" in target:
        block(f"{what} to an unexpanded path ({target}); use an absolute scratchpad path")
    p = resolve(target, data.get("cwd"))
    if str(p) in DEV_OK or in_scratch(p, [data.get("scratchpad_dir")]):
        return
    block(f"{what} outside the scratchpad: {p}")


def check_bash(policy, cmd, data, kb_db):
    if not isinstance(cmd, str) or not cmd.strip():
        block("empty Bash command")

    if policy in ("relay-write", "relay-read"):
        return check_relay(policy, cmd)

    body = strip_heredocs(cmd)
    tokens = tokenize(body)
    for t in tokens:
        if is_secret(t):
            block(f"command names a secret-like file ({os.path.basename(t.strip(chr(39) + chr(34)))})")
        if kb_db and KB_DB_NAME.search(t) and ("sagae-knowloge-base" in t or "sagae-kb-data" in t):
            block("command touches a KB database file; read the contract instead")

    for seg in segments(tokens):
        words, reds = split_redirects(seg)
        if policy != "bash-impl":
            for op, target in reds:
                check_write_target(target, data, f"redirect {op}")
        else:
            for op, target in reds:
                p = resolve(target, data.get("cwd")) if "$" not in target else None
                if p and any(under(p, g) for g in GLOBAL_PROTECTED):
                    block(f"redirect into global agent config: {p}")
        cmdname, args = head_word(words)
        if not cmdname:
            continue
        if cmdname in SHELLS and "-c" in args:
            i = args.index("-c")
            if i + 1 < len(args):
                check_bash(policy, args[i + 1], data, kb_db)
            continue
        if cmdname == "eval":
            check_bash(policy, " ".join(args), data, kb_db)
            continue
        if cmdname == "printenv" or (cmdname in ("env", "set", "export", "declare") and not args):
            block("printing the environment")
        if cmdname == "git":
            check_git(policy, args)
            continue
        if cmdname in INSTALLERS and args and args[0] in INSTALL_VERBS and not (cmdname in ("npx", "bunx")):
            block(f"{cmdname} {args[0]}: no package installs (packages are preinstalled)")
        if cmdname in ("pip", "pip3") or (cmdname in ("python", "python3") and args[:2] == ["-m", "pip"]):
            block("pip: no package installs")
        if policy == "bash-test" and cmdname in TEST_RUNNERS:
            for a in args:
                if TEST_BANNED_FLAGS.match(a):
                    block(f"test flag {a} is not allowed (no snapshot update, no passWithNoTests)")
        if cmdname in ("sed", "perl", "ruby") and any(a == "-i" or a.startswith("-i") or a.startswith("--in-place") or (cmdname == "perl" and re.match(r"^-[a-zA-Z]*i", a)) for a in args):
            if policy == "bash-impl":
                check_impl_targets(path_args(args[1:]), data, cmdname)
            else:
                block(f"{cmdname} in-place edit: this role never edits files")
        if cmdname in WRITE_CMDS:
            targets = [a for a in args if not a.startswith("-")]
            if cmdname in DEST_LAST and targets:
                targets = targets[-1:]  # sources may be anywhere; only the destination is written
            if cmdname in ("chmod", "chown", "chgrp") and targets:
                targets = targets[1:]  # the first word is the mode or owner
            if policy == "bash-impl":
                check_impl_targets(targets, data, cmdname)
            else:
                for t in targets:
                    check_write_target(t, data, cmdname)
        if cmdname in ("curl", "wget") and policy == "bash-readonly" and data.get("_net_local_only"):
            for a in args:
                if re.match(r"^https?://", a) and not re.match(r"^https?://(127\.0\.0\.1|localhost)([:/]|$)", a):
                    block("network access beyond 127.0.0.1")
        if data.get("_net_local_only") and any(a in ("0.0.0.0",) or a.endswith("=0.0.0.0") for a in args):
            block("binding to 0.0.0.0")


def check_impl_targets(targets, data, what):
    for t in targets:
        if "$" in t or "`" in t:
            continue
        p = resolve(t, data.get("cwd"))
        if any(under(p, g) for g in GLOBAL_PROTECTED):
            block(f"{what} on global agent config: {p}")
        if under(p, PROJ) and p.relative_to(PROJ).parts[:1] in ((".git",), (".claude",)):
            block(f"{what} on git internals or agent config: {p}")


def check_git(policy, args):
    sub, rest = git_sub(args)
    if not sub:
        return
    if policy == "bash-commit":
        if sub not in GIT_COMMITTER_OK:
            block(f"git {sub}: the committer only stages and commits")
        if sub == "add" and any(a in ("-A", "--all", ".", "-u", "--update", "-f", "--force", ":/", "*") for a in rest):
            block("git add: only explicit paths after --")
        if sub == "restore" and "--staged" not in rest:
            block("git restore: only --staged is allowed")
        if sub == "restore" and "--worktree" in rest:
            block("git restore --worktree changes files")
        if sub == "commit" and any(a in ("--amend", "--no-verify", "-n", "--fixup", "--squash", "-a", "--all") or a.startswith("--fixup=") or a.startswith("--squash=") for a in rest):
            block("git commit: no --amend, --no-verify, -a, fixup or squash")
        return
    if policy == "bash-impl":
        if sub in GIT_WRITE:
            block(f"git {sub}: implementers never change git state (the committer commits)")
        return
    if sub not in GIT_READ_OK:
        block(f"git {sub}: this role is read-only on git")
    if sub == "diff" and any(a == "--output" or a.startswith("--output=") for a in rest):
        block("git diff --output writes a file")


RELAY = {
    "relay-write": ("workspace-write", "Environment (fixed, from the relay):"),
    "relay-read": ("read-only", "Review rules (fixed, from the relay):"),
}


def check_relay(policy, cmd):
    sandbox, marker = RELAY[policy]
    first, _, rest = cmd.lstrip().partition("\n")
    head = re.compile(
        r"^((AGENT_RESUME|AGENT_TIMEOUT)=[A-Za-z0-9._-]+\s+)*agent-run\s+codex\s+(low|medium|high)\s+"
        r"(\"[^\"\n]+\"|'[^'\n]+'|[^\s'\"]+)\s+" + re.escape(sandbox) + r"(\s+[A-Za-z0-9._-]+)?\s+<<\s*'TASK_EOF'\s*$"
    )
    if not head.match(first.strip()):
        block(f"this relay runs only: agent-run codex <tier> <dir> {sandbox} [model] <<'TASK_EOF'")
    lines = rest.split("\n")
    try:
        end = lines.index("TASK_EOF")
    except ValueError:
        block("the heredoc must end with a TASK_EOF line")
    if any(l.strip() for l in lines[end + 1:]):
        block("nothing may follow the TASK_EOF line")
    if marker not in "\n".join(lines[:end]):
        block(f"the fixed relay block ({marker}) is missing")


def parse_args(argv, pol):
    kb_db = net_local = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--bash", "--write") and i + 1 < len(argv):
            pol[a[2:]] = argv[i + 1]
            i += 2
            continue
        if a == "--kb-db":
            kb_db = True
        elif a == "--net-local":
            net_local = True
        else:
            block(f"unknown argument {a!r}")
        i += 1
    return kb_db, net_local


def main(argv):
    pol = {"bash": None, "write": None}
    by_type = "--by-agent-type" in argv
    if by_type:
        if len(argv) != 1:
            block("--by-agent-type takes no other argument")
        kb_db = net_local = False
    else:
        kb_db, net_local = parse_args(argv, pol)
        known_bash = {"bash-readonly", "bash-test", "bash-commit", "bash-impl", "relay-write", "relay-read", None}
        known_write = {"no-write", "write-docs", "write-scratch", "write-impl", None}
        if pol["bash"] not in known_bash or pol["write"] not in known_write:
            block("unknown policy")

    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except ValueError:
        block("hook input is not JSON")
    if not isinstance(data, dict):
        block("hook input is not an object")

    if by_type:
        agent_type = data.get("agent_type")
        if not isinstance(agent_type, str) or agent_type not in AGENT_POLICIES:
            return  # the lead, or a subagent type this table does not govern
        kb_db, net_local = parse_args(AGENT_POLICIES[agent_type], pol)

    data["_net_local_only"] = net_local
    tool = data.get("tool_name") or ""
    ti = data.get("tool_input") or {}
    if not isinstance(ti, dict):
        block("tool_input is not an object")

    if tool == "Bash":
        if pol["bash"] is None:
            block("this role has no Bash policy")
        check_bash(pol["bash"], ti.get("command"), data, kb_db)
    elif tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        check_write(pol["write"] or "no-write", tool, ti, data)
    elif tool in ("Read", "Grep", "Glob"):
        check_read(tool, ti, data, kb_db)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Block as e:
        sys.stderr.write(f"agent-guard: blocked: {e}. Enforced by .claude/hooks/agent-guard.py; report REFUSED or BLOCKED instead of working around it.\n")
        sys.exit(2)
    except Exception as e:  # fail closed
        sys.stderr.write(f"agent-guard: internal error ({type(e).__name__}); call blocked. Report this to the lead.\n")
        sys.exit(2)
    sys.exit(0)
