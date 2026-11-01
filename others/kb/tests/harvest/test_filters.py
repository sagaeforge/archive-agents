import pytest

from conftest import FAKE_PAT, NODE
from kb.harvest import filters

SC = filters.HarvestScrubber([NODE])


@pytest.mark.parametrize("line", [
    "사설 주소 192.0.2.1 접속",                       # intake 규칙 그대로
    "loopback 127.0.0.1:8080",
    "tailnet 100.64.3.4 에서",                          # CGNAT
    "내부 host.internal 확인",
    "localhost:8080 사용",
    f"노드 {NODE} 에서 실측",                           # 차단 목록
    "fe80::1 과 fd00::5",                               # IPv6 링크 로컬, ULA
    "scopes: repo, admin:org",                          # intake 토큰 권한 줄
    # 아래는 수확이 더한 규칙
    "차단 대역 192.168.x.x 와 10.0.0/8",
    "range 172.16.x.x",
    "site-local fec0::1",
    "mac.localdomain 에 접속",
    "node1.tailnet.example.ts.net 연결",
    "dev.homelab 도착",
    "Token scopes: 'gist', 'repo'",
    "token permissions list",
    "OAuth scopes are repo and workflow",
    "scopes = ['repo', 'workflow']",
    "필요한 read:org 와 write:packages",
    "  contents: write",
    "pull_requests: read",
    "role PVEAuditor on /",
    "privs Sys.Audit VM.Audit Datastore.Audit",
])
def test_line_removed(line):
    assert SC.bad(line), line


@pytest.mark.parametrize("line", [
    "공개 문서 https://example.org/docs/a 참고",
    "버전 10.x.x.x 과 3.14.2",                            # 숫자만 3성분은 버전이다
    "호버 10.8/18.3 ms 첫 프레임 924 ms",               # 측정값 표기를 CIDR로 읽지 않는다
    "Node 10.x 지원 종료",
    "Scope: `oss-viewers.md` 를 조사했다",              # 작업 범위 문장
    "the OAuth scope challenge is dropped",              # 단수 scope는 권한 목록이 아니다
    "user.home 속성",
    "package-lock.corp.json 파일",                       # 점 확장자가 이어지면 호스트가 아니다
    "WSL 6.18.54.1 커널",                                # 공인 주소 모양의 버전
    "정상 줄 하나",
])
def test_line_kept(line):
    assert not SC.bad(line), line


def test_scrub_drops_whole_lines_and_counts_without_keeping_content():
    text = "\n".join(["# 제목", "정상 1", "내부 192.0.2.1 접속", f"노드 {NODE}", "scopes: repo", "", "", "", "정상 2", ""])
    body, n = filters.scrub(SC, text)
    assert n == 3
    assert body == "# 제목\n정상 1\n\n정상 2\n"          # 연속 빈 줄은 하나로
    assert "192.168" not in body and NODE not in body and "scopes" not in body


def test_scrub_removes_control_chars_and_ansi():
    body, n = filters.scrub(SC, "a\x00b\r\n\x1b[31m빨강\x1b[0m\r\n")
    assert n == 0 and body == "ab\n빨강\n"


def test_audit_reports_counts_only():
    text = f"x {NODE}\n192.0.2.1\n192.168.x.x\nuser@example.com\n정상\n"
    r = SC.audit(text)
    assert r == {"deny": 1, "internal_addr": 1, "email": 1, "extra": 1}      # 줄 수. 내용은 없다
    assert filters.audit_total(r) == 4


def test_secret_rules_return_ids_not_values():
    ids = filters.secret_rules(f"token = {FAKE_PAT}\n")
    assert ids and all(isinstance(i, str) for i in ids) and not any(FAKE_PAT in i for i in ids)
    assert filters.secret_rules("DISABLE_AUTOUPDATER=1\n정상 문장\n") == []
    assert filters.secret_rules("") == []


def test_clip_is_line_aligned_and_utf8_safe():
    text = "".join(f"줄 {i:03d} 한글 본문\n" for i in range(200))
    out, cut = filters.clip(text, 500)
    assert cut and len(out.encode()) <= 500 and out.endswith("\n")
    assert text.startswith(out)
    assert filters.clip("짧다\n", 500) == ("짧다\n", False)


# ------------------------------------------------------------------ 이메일

@pytest.mark.parametrize("line", [
    "연락처는 user@example.com 입니다",
    "someone.name+tag@gmail.com",
    "Co-Authored-By: Claude <noreply@anthropic.com>",        # 예외를 두지 않는다
    "git@github.com:org/repo.git",
    "https://user:pw@example.org/z",
    "[메일](mailto:team@example.org)",
    "대문자 USER@Example.COM 도",
    "관리자@host.example.kr 로 문의",
])
def test_email_line_removed_without_exceptions(line):
    assert SC.bad(line), line
    assert filters.has_email(line)


@pytest.mark.parametrize("line", [
    "typescript@5.9.3 설치",
    "npx pnpm@11.5.2 install",
    "`@modelcontextprotocol/conformance@0.2.0-alpha.12` 고정",
    "@scope/pkg@1.0.0 과 @hono/mcp@0.3.2",
    "orval@8.46.0 은 8.46 이상",
    "pkg@latest",
    "https://www.npmjs.com/package/@scope/pkg",
    "데코레이터 @app.route 사용",
])
def test_package_versions_and_scopes_are_not_emails(line):
    assert not filters.has_email(line), line
    assert not SC.bad(line), line


# ------------------------------------------------------------------ 차단 목록에서 뽑은 앞부분 토큰

def test_partial_node_tokens_are_derived_from_deny_entries():
    sc = filters.HarvestScrubber(["pve-node", "pve-node", "example-cluster", "zz-node-alpha"])
    assert (sc.deny_entries, sc.deny_stems) == (4, 1)               # 두 epyc 항목이 앞부분 토큰 하나(epyc-)를 낸다
    for line in ("새 노드 pve-node 추가", "pve-node-1 노드", "see epyc-", "example-cluster 상태", "example-CLUSTER"):
        assert sc.bad(line), line
    for line in ("AMD EPYC 프로세서", "epyc 7262 칩", "example 단독으로는 그대로"):
        assert not sc.bad(line), line
    assert sc.audit("pve-node\nexample-cluster\n정상\n")["deny"] == 2


def test_stems_need_four_letters_then_hyphen_then_digit():
    sc = filters.HarvestScrubber(["pve-1", "node-alpha", "ab-12", "abcd-12", "Host-7a"])
    assert sc.deny_stems == 2                                       # abcd-, host-
    assert sc.bad("abcd-99") and sc.bad("host-1") and not sc.bad("pve-manager 와 ab-cd")


# ------------------------------------------------------------------ git SHA

SHA = "0123456789abcdef0123456789abcdef01234567"
RANDOM40 = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k"


def test_git_sha_values_on_plain_keys_are_shortened():
    text = f"TIP={SHA}\nBASE=\"{SHA}\"\nexport HEAD={SHA}\n  COMMIT_SHA={SHA}\n"
    out, n = filters.shorten_git_shas(text)
    assert n == 4 and SHA not in out
    assert out == f"TIP={SHA[:12]}…\nBASE=\"{SHA[:12]}…\"\nexport HEAD={SHA[:12]}…\n  COMMIT_SHA={SHA[:12]}…\n"


@pytest.mark.parametrize("line", [
    f"API_TOKEN={SHA}",                      # 키 이름이 비밀스럽다: 옛 GitHub 토큰은 40자리 16진수였다
    f"DEPLOY_KEY={SHA}",
    f"AUTH_COMMIT={SHA}",
    f"TIP={SHA.upper()}",                    # 소문자 16진수만 SHA로 본다
    f"TIP={SHA}0",                           # 41자리
    f"TIP={SHA}" + "ab" * 12,                # 64자리(SHA-256 크기)
    f"TIP={SHA[:39]}",                       # 39자리
    f"TIP={RANDOM40}",                       # 16진수가 아닌 고엔트로피 값
    f"note TIP={SHA}",                       # 줄 머리의 KEY=값이 아니다
])
def test_other_values_are_left_alone(line):
    out, n = filters.shorten_git_shas(line + "\n")
    assert n == 0 and out == line + "\n"


def test_shortening_quiets_the_scan_only_for_git_shas():
    quiet, n = filters.shorten_git_shas(f"TIP={SHA}\nBASE={SHA}\n")
    assert n == 2 and filters.secret_rules(f"TIP={SHA}\n") == ["kb-env-high-entropy"]     # 줄이기 전에는 오탐이다
    assert filters.secret_rules(quiet) == []
    for line in (f"API_TOKEN={SHA}", f"TIP={RANDOM40}", f"TIP={SHA}" + "ab" * 12, f"TIP={SHA.upper()}", f"SOME_VALUE={RANDOM40}"):
        out, _ = filters.shorten_git_shas(line + "\n")
        assert filters.secret_rules(out), line                                              # 진짜 고엔트로피 값은 계속 잡힌다
