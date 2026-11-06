#!/usr/bin/env python3
"""Fixture tests for agent-guard.py. Run: python3 -I .claude/hooks/test_agent_guard.py

Each case feeds one PreToolUse input to the guard and checks the exit code
(0 = allowed, 2 = blocked). Exit status of this script: 0 when every case
matches, 1 otherwise.
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GUARD = HERE / "agent-guard.py"
PROJ = HERE.parents[1]
SCR = "/var/tmp/claude-1000/probe-scratch"
RO = ["--bash", "bash-readonly", "--write", "no-write"]
VV = RO + ["--net-local"]
CL = RO + ["--kb-db"]
TEST = ["--bash", "bash-test", "--write", "no-write"]
COMMIT = ["--bash", "bash-commit", "--write", "no-write"]
IMPL = ["--bash", "bash-impl", "--write", "write-impl"]
DOCS = ["--bash", "bash-readonly", "--write", "write-docs"]
UX = ["--bash", "bash-readonly", "--write", "write-scratch"]
RW = ["--bash", "relay-write", "--write", "no-write"]
RR = ["--bash", "relay-read", "--write", "no-write"]

RELAY_W = """agent-run codex medium "$PWD" workspace-write <<'TASK_EOF'
Implement X. Files: a.ts Done when: ok Verify: npm test
Mention of git push inside the task text is data.

Environment (fixed, from the relay):
- Do not commit.
TASK_EOF"""
RELAY_R = """AGENT_RESUME=abc-123 agent-run codex high "$PWD" read-only <<'TASK_EOF'
Scope: server/auth Threat model: remote attacker

Review rules (fixed, from the relay):
- Adversarial review.
TASK_EOF"""
COMMITTER_LOOP = (
    "for f in $(git -C /home/user/sagae-tools diff --cached --name-only); do "
    "git -C /home/user/sagae-tools diff --cached -U0 -- \"$f\" | grep -qEi -e \"BEGIN [A-Z ]*PRIVATE KEY\" "
    "-e \"(api[_-]?key|secret|token|password|passwd)[\\\"' ]*[:=][\\\"' ]*[A-Za-z0-9/+_-]{12,}\" && echo \"SECRET? $f\"; done"
)


def bash(cmd, cwd=str(PROJ)):
    return {"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd, "scratchpad_dir": SCR}


def tool(name, path, cwd=str(PROJ)):
    key = "notebook_path" if name == "NotebookEdit" else "file_path"
    return {"tool_name": name, "tool_input": {key: path}, "cwd": cwd, "scratchpad_dir": SCR}


CASES = [
    # (name, args, input, expected exit)
    ("ro: git status allowed", RO, bash("git status --short"), 0),
    ("ro: grep pipeline allowed", RO, bash("grep -rn foo src | head -5"), 0),
    ("ro: redirect to scratch allowed", RO, bash(f"git diff > {SCR}/d.txt 2>&1"), 0),
    ("ro: redirect to /dev/null allowed", RO, bash("ls missing 2>/dev/null; echo \"EXIT=$?\""), 0),
    ("ro: redirect into repo blocked", RO, bash("echo x > docs/x.md"), 2),
    ("ro: append into repo blocked", RO, bash(f"echo x >> {PROJ}/CLAUDE.md"), 2),
    ("ro: glued redirect blocked", RO, bash("echo $(date)>notes.txt"), 2),
    ("ro: sed -i blocked", RO, bash("sed -i s/a/b/ README.md"), 2),
    ("ro: rm in repo blocked", RO, bash("rm -f server/x.ts"), 2),
    ("ro: rm in scratch allowed", RO, bash(f"rm -f {SCR}/old.png"), 0),
    ("ro: cp to scratch allowed", RO, bash(f"cp server/x.ts {SCR}/x.ts"), 0),
    ("ro: tee into repo blocked", RO, bash("echo x | tee out.txt"), 2),
    ("ro: git commit blocked", RO, bash("git commit -m x"), 2),
    ("ro: git checkout blocked", RO, bash("git -C /home/user/sagae-tools checkout main"), 2),
    ("ro: subshell git push blocked", RO, bash("echo $(git push origin HEAD)"), 2),
    ("ro: bash -c write blocked", RO, bash("bash -c 'echo x > a.txt'"), 2),
    ("ro: npm install blocked", RO, bash("npm install left-pad"), 2),
    ("ro: printenv blocked", RO, bash("printenv"), 2),
    ("ro: cat .env blocked", RO, bash("cat tools/loupe/.env"), 2),
    ("ro: heredoc body is data", RO, bash(f"cat > {SCR}/s.js <<'EOF'\nconst fs=require('fs'); // git push > x\nEOF\nnode {SCR}/s.js"), 0),
    ("ro: chmod scratch script allowed", RO, bash(f"chmod +x {SCR}/run.sh"), 0),
    ("ro: Write blocked", RO, tool("Write", f"{SCR}/a.md"), 2),
    ("ro: Edit blocked", RO, tool("Edit", f"{PROJ}/README.md"), 2),
    ("ro: NotebookEdit blocked", RO, tool("NotebookEdit", f"{PROJ}/x.ipynb"), 2),
    ("ro: Read .env blocked", RO, tool("Read", f"{PROJ}/tools/loupe/.env"), 2),
    ("ro: Read codex auth blocked", RO, tool("Read", str(Path.home() / ".codex/auth.json")), 2),
    ("ro: Read .env.example allowed", RO, tool("Read", f"{PROJ}/.env.example"), 0),
    ("ro: Read source allowed", RO, tool("Read", f"{PROJ}/CLAUDE.md"), 0),
    ("vv: localhost curl allowed", VV, bash("curl -s http://127.0.0.1:5173/"), 0),
    ("vv: external curl blocked", VV, bash("curl -s https://example.com/"), 2),
    ("vv: bind 0.0.0.0 blocked", VV, bash("npx vite --host 0.0.0.0"), 2),
    ("cl: KB db read blocked", CL, tool("Read", str(Path.home() / "sagae-knowloge-base/data/kb.sqlite")), 2),
    ("cl: KB db via bash blocked", CL, bash("sqlite3 ~/sagae-kb-data/kb.db .tables"), 2),
    ("cl: KB contract read allowed", CL, tool("Read", str(Path.home() / "sagae-knowloge-base/docs/contracts/openapi.yaml")), 0),
    ("test: playwright run allowed", TEST, bash("cd tools/loupe && PLAYWRIGHT_BROWSERS_PATH=/x npx playwright test e2e/round1.spec.ts; echo \"EXIT=$?\""), 0),
    ("test: timeout prefix allowed", TEST, bash("timeout -k 5 600 npm test"), 0),
    ("test: --update-snapshots blocked", TEST, bash("npx playwright test --update-snapshots"), 2),
    ("test: -u blocked", TEST, bash("npx vitest run -u"), 2),
    ("test: --grep left to the prompt", TEST, bash("npx playwright test --grep auth"), 0),
    ("test: --passWithNoTests blocked", TEST, bash("npx vitest run --passWithNoTests"), 2),
    ("test: sort -u outside a runner allowed", TEST, bash("git status --short | sort -u"), 0),
    ("test: git reset blocked", TEST, bash("git reset --hard"), 2),
    ("commit: diff cached allowed", COMMIT, bash("git -C /home/user/sagae-tools diff --cached --name-only"), 0),
    ("commit: add explicit paths allowed", COMMIT, bash("git -C /home/user/sagae-tools add -- docs/a.md docs/b.md"), 0),
    ("commit: secret scan loop allowed", COMMIT, bash(COMMITTER_LOOP), 0),
    ("commit: heredoc commit allowed", COMMIT, bash("git -C /home/user/sagae-tools commit -F - <<'MSG_EOF'\nAdd x\n\nCo-Authored-By: A <a@b>\nMSG_EOF"), 0),
    ("commit: restore --staged allowed", COMMIT, bash("git -C /r restore --staged -- a.txt"), 0),
    ("commit: push blocked", COMMIT, bash("git push origin HEAD"), 2),
    ("commit: amend blocked", COMMIT, bash("git commit --amend -m x"), 2),
    ("commit: no-verify blocked", COMMIT, bash("git commit --no-verify -m x"), 2),
    ("commit: add -A blocked", COMMIT, bash("git add -A"), 2),
    ("commit: add . blocked", COMMIT, bash("git add ."), 2),
    ("commit: rebase blocked", COMMIT, bash("git rebase main"), 2),
    ("commit: stash blocked", COMMIT, bash("git stash"), 2),
    ("commit: restore worktree blocked", COMMIT, bash("git restore a.txt"), 2),
    ("commit: config blocked", COMMIT, bash("git config user.name x"), 2),
    ("impl: edit source allowed", IMPL, tool("Edit", f"{PROJ}/tools/relief/src/a.ts"), 0),
    ("impl: write scratch allowed", IMPL, tool("Write", f"{SCR}/n.md"), 0),
    ("impl: edit .claude blocked", IMPL, tool("Edit", f"{PROJ}/.claude/settings.json"), 2),
    ("impl: edit CLAUDE.md blocked", IMPL, tool("Edit", f"{PROJ}/CLAUDE.md"), 2),
    ("impl: write global config blocked", IMPL, tool("Write", str(Path.home() / ".claude/settings.json")), 2),
    ("impl: dotdot escape blocked", IMPL, tool("Write", f"{PROJ}/tools/../../.bashrc"), 2),
    ("impl: write .env blocked", IMPL, tool("Write", f"{PROJ}/tools/loupe/.env"), 2),
    ("impl: run tests allowed", IMPL, bash("cd tools/relief && npm test 2>&1 | tail -20"), 0),
    ("impl: git commit blocked", IMPL, bash("git commit -am x"), 2),
    ("impl: git checkout -- blocked", IMPL, bash("git checkout -- src/a.ts"), 2),
    ("impl: npm install blocked", IMPL, bash("npm i zod"), 2),
    ("docs: write docs allowed", DOCS, tool("Write", f"{PROJ}/docs/plans/2026-11-05-x.md"), 0),
    ("docs: write tool docs allowed", DOCS, tool("Edit", f"{PROJ}/tools/relief/docs/ops.md"), 0),
    ("docs: write CLAUDE.md blocked", DOCS, tool("Edit", f"{PROJ}/CLAUDE.md"), 2),
    ("docs: write code blocked", DOCS, tool("Write", f"{PROJ}/tools/relief/src/a.ts"), 2),
    ("docs: write repo root blocked", DOCS, tool("Write", f"{PROJ}/README-guard-probe.md"), 2),
    ("ux: write scratch allowed", UX, tool("Write", f"{SCR}/wire.html"), 0),
    ("ux: write scratchpad_dir allowed", UX, {"tool_name": "Write", "tool_input": {"file_path": "/home/user/other-scratch/w.html"}, "cwd": str(PROJ), "scratchpad_dir": "/home/user/other-scratch"}, 0),
    ("ux: write repo blocked", UX, tool("Write", f"{PROJ}/docs/design/x.html"), 2),
    ("relay-w: proper call allowed", RW, bash(RELAY_W), 0),
    ("relay-w: timeout env allowed", RW, bash("AGENT_TIMEOUT=900 " + RELAY_W), 0),
    ("relay-w: read-only sandbox blocked", RW, bash(RELAY_W.replace("workspace-write", "read-only", 1)), 2),
    ("relay-w: missing fixed block blocked", RW, bash(RELAY_W.replace("Environment (fixed, from the relay):", "Env:")), 2),
    ("relay-w: trailing command blocked", RW, bash(RELAY_W + "\nrm -rf /"), 2),
    ("relay-w: other command blocked", RW, bash("echo hi"), 2),
    ("relay-w: chained before blocked", RW, bash("git status; " + RELAY_W), 2),
    ("relay-r: proper call allowed", RR, bash(RELAY_R), 0),
    ("relay-r: workspace-write blocked", RR, bash(RELAY_R.replace("read-only", "workspace-write", 1)), 2),
    ("bad: not JSON blocked", RO, "not json", 2),
    ("bad: unknown policy blocked", ["--bash", "nope"], bash("ls"), 2),
    ("bad: unbalanced quote blocked", RO, bash("echo 'oops"), 2),
    ("other tool passes", RO, {"tool_name": "WebSearch", "tool_input": {"query": "x"}}, 0),
]


BY_TYPE = ["--by-agent-type"]


def typed(inp, agent_type):
    out = dict(inp)
    out["agent_type"] = agent_type
    out["agent_id"] = "a1"
    return out


CASES += [
    # fallback path: policy chosen from agent_type in the hook input
    ("type: lead (no agent_type) passes a write", BY_TYPE, tool("Write", f"{PROJ}/README-x.md"), 0),
    ("type: lead passes git push", BY_TYPE, bash("git push origin HEAD"), 0),
    ("type: unknown agent type passes", BY_TYPE, typed(tool("Write", f"{PROJ}/README-x.md"), "Explore"), 0),
    ("type: non-string agent_type passes", BY_TYPE, typed(tool("Write", f"{PROJ}/README-x.md"), 7), 0),
    ("type: test-runner Write blocked", BY_TYPE, typed(tool("Write", f"{PROJ}/guard-probe-write.txt"), "test-runner"), 2),
    ("type: test-runner bash redirect blocked", BY_TYPE, typed(bash("echo x > guard-probe-bash.txt"), "test-runner"), 2),
    ("type: test-runner test run allowed", BY_TYPE, typed(bash("npm test"), "test-runner"), 0),
    ("type: test-runner --update-snapshots blocked", BY_TYPE, typed(bash("npx vitest run -u"), "test-runner"), 2),
    ("type: code-reviewer git commit blocked", BY_TYPE, typed(bash("git commit -m x"), "code-reviewer"), 2),
    ("type: committer push blocked", BY_TYPE, typed(bash("git push"), "committer"), 2),
    ("type: committer add explicit allowed", BY_TYPE, typed(bash("git add -- a.txt"), "committer"), 0),
    ("type: implementer edits source", BY_TYPE, typed(tool("Edit", f"{PROJ}/tools/relief/src/a.ts"), "implementer"), 0),
    ("type: implementer edit .claude blocked", BY_TYPE, typed(tool("Edit", f"{PROJ}/.claude/settings.json"), "implementer"), 2),
    ("type: debugger commit blocked", BY_TYPE, typed(bash("git commit -m x"), "debugger"), 2),
    ("type: doc-writer docs allowed", BY_TYPE, typed(tool("Write", f"{PROJ}/docs/a.md"), "doc-writer"), 0),
    ("type: doc-writer code blocked", BY_TYPE, typed(tool("Write", f"{PROJ}/tools/a.ts"), "doc-writer"), 2),
    ("type: ux-designer repo blocked", BY_TYPE, typed(tool("Write", f"{PROJ}/docs/x.html"), "ux-designer"), 2),
    ("type: contract-liaison KB db blocked", BY_TYPE, typed(tool("Read", str(Path.home() / "sagae-knowloge-base/data/kb.sqlite")), "contract-liaison"), 2),
    ("type: visual-verifier external curl blocked", BY_TYPE, typed(bash("curl -s https://example.com/"), "visual-verifier"), 2),
    ("type: implementer-codex relay allowed", BY_TYPE, typed(bash(RELAY_W), "implementer-codex"), 0),
    ("type: implementer-codex other bash blocked", BY_TYPE, typed(bash("ls"), "implementer-codex"), 2),
    ("type: security-reviewer-codex relay-read allowed", BY_TYPE, typed(bash(RELAY_R), "security-reviewer-codex"), 0),
    ("type: security-reviewer-codex write-sandbox blocked", BY_TYPE, typed(bash(RELAY_W), "security-reviewer-codex"), 2),
    ("type: bad JSON blocked", BY_TYPE, "not json", 2),
    ("type: extra argument blocked", BY_TYPE + ["--bash", "bash-impl"], bash("ls"), 2),
]


def check_table_matches_frontmatter():
    """AGENT_POLICIES must equal the guard arguments in each agent's frontmatter hook."""
    import importlib.util
    import re
    spec = importlib.util.spec_from_file_location("agent_guard", GUARD)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    bad = 0
    seen = set()
    for md in sorted((PROJ / ".claude" / "agents").glob("*.md")):
        text = md.read_text()
        front = text.split("---", 2)[1] if text.startswith("---") else ""
        m = re.search(r"agent-guard\.py\\?\"\s+(.*?)\"?\s*$", front, re.M)
        name = re.search(r"^name:\s*(\S+)", front, re.M)
        if not m or not name:
            continue  # an agent without the guard hook is not governed
        seen.add(name.group(1))
        want = m.group(1).replace('\\"', "").split()
        if mod.AGENT_POLICIES.get(name.group(1)) != want:
            bad += 1
            print(f"FAIL table drift for {name.group(1)}: table={mod.AGENT_POLICIES.get(name.group(1))} frontmatter={want}")
    for extra in set(mod.AGENT_POLICIES) - seen:
        bad += 1
        print(f"FAIL table entry without a guarded agent file: {extra}")
    print(f"table vs frontmatter: {len(seen)} agents, {bad} drift")
    return bad


def main():
    fails = 0
    for name, args, inp, want in CASES:
        payload = inp if isinstance(inp, str) else json.dumps(inp)
        r = subprocess.run([sys.executable, "-I", str(GUARD), *args], input=payload, capture_output=True, text=True, timeout=20)
        ok = r.returncode == want
        if not ok:
            fails += 1
            print(f"FAIL {name}: exit {r.returncode}, want {want}; stderr: {r.stderr.strip()[:200]}")
    print(f"{len(CASES) - fails}/{len(CASES)} passed")
    fails += check_table_matches_frontmatter()
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
