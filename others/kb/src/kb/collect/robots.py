"""robots.txt: RFC 9309 매처(*, $, 가장 긴 규칙, 동률이면 allow)."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

AGENT = "kb-collector"
TTL_MS = 24 * 3600 * 1000
MAX_PARSE = 500 * 1024


def _norm(s: str) -> str:
    """%XX를 대문자로 통일하고 예약되지 않은 문자의 인코딩을 푼다."""
    def fix(m):
        c = chr(int(m.group(1), 16))
        return c if re.fullmatch(r"[A-Za-z0-9\-._~]", c) else "%" + m.group(1).upper()
    return re.sub(r"%([0-9A-Fa-f]{2})", fix, s)


def _regex(pattern: str):
    anchored = pattern.endswith("$")
    if anchored:
        pattern = pattern[:-1]
    parts = [re.escape(x) for x in _norm(pattern).split("*")]
    return re.compile(".*".join(parts) + ("$" if anchored else ""), re.S)


class Robots:
    def __init__(self, groups: list):
        self.groups = groups   # [(agents[lower], rules[(allow, pattern, regex)])]

    @classmethod
    def parse(cls, text: str) -> "Robots":
        groups: list = []
        agents: list = []
        rules: list = []
        in_rules = False
        for line in text[:MAX_PARSE].lstrip("﻿").splitlines():
            line = line.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            k, v = k.strip().lower(), v.strip()
            if k == "user-agent":
                if in_rules:
                    groups.append((agents, rules))
                    agents, rules, in_rules = [], [], False
                agents.append(v.lower())
            elif k in ("allow", "disallow"):
                if not agents:
                    continue
                in_rules = True
                if v:
                    rules.append((k == "allow", v, _regex(v)))
        if agents:
            groups.append((agents, rules))
        return cls(groups)

    def _rules_for(self, agent: str) -> list:
        agent = agent.lower()
        exact = [r for ags, r in self.groups if any(a != "*" and (agent == a or agent.startswith(a)) for a in ags)]
        pick = exact or [r for ags, r in self.groups if "*" in ags]
        return [x for r in pick for x in r]

    def allowed(self, path_query: str, agent: str = AGENT) -> bool:
        if path_query.split("?", 1)[0] == "/robots.txt":
            return True
        target = _norm(path_query or "/")
        best = None   # (길이, allow)
        for allow, pat, rx in self._rules_for(agent):
            if rx.match(target):
                cand = (len(pat), allow)
                if best is None or cand[0] > best[0] or (cand[0] == best[0] and allow):
                    best = cand
        return True if best is None else best[1]


def path_query(url: str) -> str:
    u = urlsplit(url)
    return (u.path or "/") + ("?" + u.query if u.query else "")
