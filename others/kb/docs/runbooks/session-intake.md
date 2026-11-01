# 세션 조사 자료 흡수 (kb intake)

대장 `docs/intake/session-research.md`의 자료를 `docs/intake/session-research.yaml`(매니페스트)로 옮겨 `kb intake`가 처리한다. 규범은 ADR-0001 7.8의 세션 조사 자료 행이다.

## 절차

1. `kb intake deny-build [--nodes FILE|-]`: `$KB_CONFIG_DIR/intake-deny.txt`(0600)를 만든다. 입력은 hostname, `/etc/hosts` 이름, 노드 이름(세션의 proxmox MCP 읽기 도구로 이름만 읽어 표준입력으로 넘긴다), 접수 사본의 내부 접미사 호스트다. 건수만 출력한다. 이 파일이 없거나 비면 `plan`, `run`이 `E_DENY_MISSING`으로 exit 1이고 아무것도 쓰지 않는다.
2. `kb intake plan --json`: 쓰기 없음. 3. `kb intake run --json`: 멱등. gold가 없거나 gold_schema가 다르면 먼저 rebuild와 schema sync를 돈다.
4. `kb intake status --json`, `kb intake verify --json`(차단 목록과 내부 주소 적중 건수, treat 불일치 건수).

## 처리 규칙

- treat: full, filtered(exclude_lines), jsonl_filter(select=label), urls_only(본문 미저장, urls_file이 있으면 전사를 열지 않음), index, versions_only(select=패키지), excluded(열지 않음). `no_urls: true`는 URL 후보를 만들지 않는다.
- 저장 전 줄 단위 제거: 사설/루프백/링크 로컬 IPv4, ULA/링크 로컬 IPv6, `localhost:포트`, `.local .lan .internal .home.arpa` 호스트, 차단 목록 문자열, 토큰 권한 줄. 줄 수만 `props.scrubbed`에 남긴다.
- 기록: `put_record(transport="intake", session=<대장 세션>)`, 키 `intake:<id>:<본문 sha256>`, type=Artifact, sensitivity=internal. 결정 2 전에는 `spool/fp-held`에 held. 비밀 탐지에 걸리면 secret + 격리.
- URL: https만, 정규화 뒤 전역 중복 제거. IP, 점 없는 호스트, 내부 접미사, userinfo, token/key/secret/sig 쿼리, 차단 목록 문자열, `host_allowed` 거부, 활성 소스 URL은 등록하지 않는다. 나머지는 `open_ticket("세션 출처 재확인: <topic>", priority=low, url)`로 티켓 urls에 쌓는다. 티켓당 URL 상한(`kb.ticket.MAX_URLS`=50)을 넘는 것은 `ticket_capped`로 세고 `urls.skipped`에 든다. 상한을 올리고 다시 돌리면 이어서 등록된다. 네트워크 0회. 실제 수집은 결정 11 뒤 kb-fulfill이 한다.
- 세션 서술은 claim, entity, edge 이벤트로 쓰지 않는다.

## 앞으로의 제출

세션은 `use-from-other-session.md`대로 자료는 `kb_put(type=Artifact, props.session, props.topic, props.researched_on)`, 외부 사실 URL은 `kb_request`로 낸다. 경로만 회신하면 대장과 매니페스트에 행을 더하고 `kb intake run`을 다시 돈다. `claude-setup-b1`은 재전송하지 않고, `sagae-claude-plugins-0e`의 훅 설정 결론은 회신이 오면 같은 절차로 더한다.

## 접수 사본 삭제

`kb intake purge-copy`(건식)는 조건만 보여 준다. `--apply`는 MANIFEST.sha256 대조, 전 항목 처리, 결정 3 승인, TTY가 모두 맞을 때만 `~/.local/share/sagae-kb/intake/`를 지운다. T0 사본이 1벌인 동안은 지우지 않는다(사용자 입회).
