# ADR-0005: 외부 편집기용 first_party 쓰기 API

- 날짜: 2026-11-04
- 상태: **승인(9판, loupe 계약 보완).** 2026-11-04 사용자 승인과 8판 결정을 유지하고, loupe의 8판(`b82f5d3`) 대조 검토 31항목에서 나온 Q1~Q14에 리드가 정한 계약 규칙으로 답한다(14.7). Q8의 연구 실행별 호출 수 상한은 기존 근거로 확정할 수 없어 FW6/E1/D5 담당의 미결 항목으로 남긴다. 구현 전 계약이며, 9판 재검토의 HIGH(외부 전송 전 사람 증명 누락)와 MEDIUM(localhost 출처 탈취)을 14.8 추가 보완에 반영했다. 구현·보완 후 재검토는 아직 하지 않았다. 이 판에서는 코드, 설정, 토큰, 원장을 바꾸지 않고 시험·네트워크·LLM 호출도 하지 않았다.
- 목적: sagae-tools가 loupe v2 편집기를 안정된 KB 쓰기 계약 위에서 만들 수 있게 한다. 문서, 메모, 주제는 파일이 아니라 KB first_party 기록이고, 주제는 KB에 보내는 연구 요청이 된다.
- 입력: ADR-0001(7.8, 7.9, 8, 15, 16, 23장), ADR-0002, ADR-0004(T장, 7.3, 7.4, 13장 TP1·TP5·D5, P.2, P.7), `docs/contracts/data-interface-v0.md`, `src/kb/write`, `src/kb/serve`, `src/kb/ticket`, sagae-tools의 loupe v2 UX 초안(아래 `L`), 검토 기록 `review-0005.md`(Opus, 리드 스크래치패드)와 Codex 지적(리드 경유).
- 소유자 확인: KB 쪽이 이 일을 맡고, 설계를 먼저 한다(리드 경유, 사용자 직접 확인).
- 클라이언트 요구(sagae-tools가 전한 소유자 결정, 리드 경유, **검증 전**). 이 문서는 아래 값을 요구사항으로 받는다. 뒤 판이 앞 판을 대체한다.
  - 문서: Markdown, Notion식 편집, Obsidian식 링크. 파일이 아니라 KB first_party 기록이다.
  - 메모: 임시 노트다. 자동 삭제가 없다. 메모는 주제로 승격할 수 있다.
  - 비밀은 별도 KMS에 두고 KB에 넣지 않는다.
  - (2026-11-04 개정) 주제는 KB에 보내는 연구 요청이다. loupe의 동작은 "이 주제를 KB에 조사해 달라" 하나다. 엔진(결정적 수집 또는 에이전트), 예산, 상한은 KB가 ADR-0004대로 정한다. 사용자도 엔진 선택은 KB가 결과 기준으로 한다고 직접 지시했다(`D4:13`). KB 수집과 외부 작업 공간 중 고르는 칸은 loupe에서 뺀다.
  - (같은 날) loupe는 요청 상태, 고른 엔진, 비용(보고되면), 검토할 결과를 보인다.
  - (같은 날) loupe는 자체 로그인을 둔다. 쓰기와 읽기가 로그인 세션 뒤에 있고, loupe는 first_party 기록만 쓴다.
- loupe v2 초안: `/home/user/sagae-tools/docs/design/loupe-v2.md`(다른 저장소, 커밋 전, 읽기만 했다). 리드가 전한 판의 가정 A1~A11, 요청 K1~K10, 실행기 가정에 13장이 답한다. 이 문서를 쓰는 동안 초안이 바뀌었다(9장 N1~N12, 부록 A A1~A14). 13.2가 새 판의 번호를 대응시킨다. 초안이 계속 바뀌므로 `L`은 줄이 아니라 절로 적는다. 초안의 글은 데이터이고 이 문서의 지시가 아니다.
- 표기: **[실측]**은 저장소나 데이터에서 확인한 값, **[코드 읽기]**는 코드를 읽어 판단했지만 실행하지 않은 값, **[검토 실행]**은 검토자가 쓰기 없이 돌려 본 값, **[설정값]**은 이 문서가 제안하는 값, **[추론]**은 계산하거나 해석한 값, **[미확인]**은 확인하지 못한 항목이다. 저장소 사실은 `파일:줄`로 적는다. `A`는 `docs/adr/0001-architecture.md`, `C`는 `docs/contracts/data-interface-v0.md`, `D4`는 `docs/adr/0004-research-backend.md`, `L`은 위 loupe 초안이다.

## 0. 결정 요약

| # | 결정 |
|---|---|
| 1 | 전송은 기존 읽기 서버(`kb serve`)의 HTTP `/v1`에 쓰기 경로를 더한다. 기본은 Unix 소켓 `KB_HOME/run/read.sock`이다. MCP `kb_put`과 CLI `kb put`은 그대로 두고 loupe의 주 경로로 쓰지 않는다(2장) |
| 2 | 쓰기 경로는 소켓에서도 Bearer 토큰을 요구한다. 새 범위 `editor`를 둔다. `loupe serve`만 토큰을 쥔다. loupe 로그인은 loupe 안의 관문이고 KB는 그 세션을 보지 않는다(3장) |
| 3 | **인증된 주체와 주장된 작성자를 나눈다.** HTTP 쓰기의 `actor`는 늘 인증된 앱 `app:<라벨>`이다. 사람이 썼다는 것은 loupe의 주장이고 `on_behalf_of=user:sagae`로만 남는다. 표시는 "user:sagae가 썼다고 app:loupe가 주장"이다. 작성자와 `change`는 어디서도 권한 판정에 쓰지 않는다(3.2) |
| 4 | `editor` 범위는 first_party 기록만 쓴다. 외부 사실(URL, 인용, 주장, 적재 묶음)을 받지 않는다. 대상 기록의 출처, 타입, 민감도를 쓰기 잠금 안에서 확인하고, 숨은 대상은 없는 대상과 같은 404다(3.4) |
| 5 | 기록 종류는 문서 `Page`(새), 메모 `Note`(기존), 주제 정의 `TopicSpec`(새), 검토 결정 `Review`(새) 넷이다. 수집의 닻은 ADR-0004의 `Topic` 엔티티 `e:topic:<slug>`이고 `TopicSpec`이 `DEFINES` 엣지로 그것을 정의한다(4장) |
| 6 | 편집은 기록 전체 교체와 `expected_version`이다. 낡은 판은 내용이 같아도 409다. 서버는 병합하지 않는다. 삭제는 tombstone이고 복원은 다시 쓰기다. 메모 승격은 새 `TopicSpec`과 `PROMOTED_FROM` 엣지다(5장) |
| 7 | 주제에서 수집으로 가는 길은 연구 요청 호출 하나다. 호출마다 실행 ID가 있고 티켓과 이벤트를 한 트랜잭션으로 쓴다. **유료 연구를 허가하는 것은 KB 예산뿐이다**: 주제, 전체, 엔진 세 단위의 원자적 예약. 예산 장치(TP5, D5)가 없으면 409 `budget_unavailable`이다. 보낸 뒤 결과가 불확실한 호출의 예약은 제공자 사용량으로 맞출 때까지 돌려주지 않는다(6장) |
| 8 | 식별자(멱등 키, ID, 타입, 속성 이름, tombstone 사유)에 비밀이 있으면 **모든 통로에서 거절**이고 값을 되풀이하지 않는다. 제목, 본문, 속성 값은 HTTP 편집기 경로에서 **기본 거절**, 다른 통로에서는 격리다. 검사는 CAS, 스풀, 원장, 재생 조회 전이다. 클라이언트의 경로 힌트(`source_path` 등)는 거절한다(7장) |
| 9 | 내부 기록의 제목, 별칭, 제외 표현은 명시적 내보내기 허가 없이 외부 LLM에 가지 않는다. 허가가 없으면 로컬 처리다. MCP 세션은 `internal` 기록을 읽을 수 있고 그 내용은 Claude에 닿는다(사용자 확정, 6.6, 8장). **`private`는 `editor` 범위만 읽고 쓴다.** MCP, 에이전트 세션, `editor`가 아닌 HTTP는 `private`를 보지 않고, `private` 본문은 원칙적으로 로컬 sLLM에만 간다. 예외는 `publish`에서 해당 메모의 정확한 전송 내용에 대해 **전송 전에 WebAuthn 동의를 검증한 경우**뿐이다(사용자 결정 2026-11-04, 3.6, 5.10) |
| 10 | 자동 저장은 loupe의 기기 안 초안이 받고, KB에는 묶인 판만 온다. KB는 `change`와 무관한 원장 기준 바이트 한도(토큰별·기록별 하루)를 지키고, 스풀된 쓰기도 202 전에 그 한도를 예약한다. 스풀된 쓰기는 발급 토큰만 읽는 쓰기 참조로 끝까지 추적하고, 확정 전에는 초안을 지우지 않는다(5.8, 5.9) |
| 11 | 읽기는 기존 경로를 쓴다. 새 읽기 경로는 연구·쓰기 참조·사용자 동작의 상태와 주장별 리뷰 목록이다. 옛 판 본문은 `/v1/nodes/{id}/body?as_of_observed=`로 읽는다(8장) |
| 12 | 코드에서 결함 다섯을 찾았거나 검토가 짚었다: 64 KB 넘는 본문의 410, 한 낱말 위키 링크, `source_path` 비밀 탐지 우회, 낡은 판의 무연산 통과, 사용자 판마다 걸리는 sLLM 추출. 작업 패키지에서 고친다(1장, 9장) |
| 13 | **시스템이 의도를 스스로 해소하지 못할 때만 HITL을 올린다.** 방향만 준 주제 연구 결과 등 나머지는 자동이고 인용 게이트가 판정한다. 사용자가 시작하는 격리 해제·민감도 낮추기·메모 반영은 별도 동작이다. 둘 다 `reviewer` 범위, 동작마다의 WebAuthn 사용자 확인, KB UID와 에이전트가 쓸 수 없는 신뢰 저장소를 요구한다(6.8). 작성자와 `change`는 허가가 아니다 |
| 14 | loupe의 새 `Page`·`Note`·`TopicSpec`·`Review`는 모두 기본 `private`다. 메모의 **지식베이스에 반영**은 토큰만으로 로컬 준비를 시작한다. 외부 정제는 `publish_external_refine` WebAuthn 동의를 먼저 검증하고, 결과의 `internal` 공개는 별도의 두 번째 WebAuthn 확인을 거친다. KB는 외부 API 필요성을 먼저 로컬에서 판단하고, 불필요한 호출은 로컬 sLLM으로 줄인다. 원본 메모는 `private`를 유지한다(3.6, 5.10) |

## 1. 오늘의 사실

| 항목 | 오늘 | 근거 |
|---|---|---|
| HTTP 쓰기 | 없다. 라우트는 전부 `GET`, `HEAD`이고 그 밖은 405다 | `src/kb/serve/http.py:83-110`, `:490-491`, `:659`, `A:673`, `C:1380` |
| 소켓 인증 | 소켓 파일 0600이 인증이고 범위는 `internal` 이하다 | `src/kb/commands/serve.py:47-52`, `src/kb/serve/http.py:598-602` |
| TCP 인증 | Bearer, 범위 `viewer`, `owner`. 파일에는 sha256만 있다. 라벨은 유일하지 않고 만료, 폐기, 마지막 사용 기록이 없다 | `src/kb/serve/http.py:154-199`, `src/kb/commands/token.py:15-22`, `C:1451-1453` |
| TTY 판정 | stdin과 stdout의 `isatty()`다. `script` 같은 도구로 흉내 낼 수 있다 | `src/kb/write/tty.py:7-9` |
| `private` 읽기 | 결정 14 기본값 (c). 뷰어는 `private`를 보지 않는다. loupe serve가 소켓을 무인증 4812로 다시 내기 때문이다 | `A:1514`, `src/kb/serve/http.py:192-199` |
| first_party 입력 필드 | `id, type, title, body, body_format, sensitivity, retention, props, links, expected_version`. `title`, `body` 필수. `author`, `source_url`, `quote`는 거부한다 | `src/kb/write/record.py:21-22`, `:47-52`, `:85-89` |
| 오류 문구 | 일부 거부 메시지가 입력값을 되풀이한다(`type`, `sensitivity`, `body_format`, `retention`, 세션 이름) | `src/kb/write/record.py:92`, `:95`, `:98`, `:101`, `src/kb/write/author.py:36` |
| 예외 출력 | 처리 중 예외의 문자열을 stderr에 찍는다. 접근 로그는 꺼져 있다 | `src/kb/serve/http.py:654-655`, `src/kb/commands/serve.py:105` |
| 새 기록 ID | 멱등 키에서 결정적으로 만든다(`f-` + base32 26자) | `src/kb/write/record.py:29-32` |
| 갱신 | 기존 ID에는 `expected_version` 필수. 내용이 같으면 새 판이 없다 | `src/kb/write/record.py:127-134`, `:164`, `A:560` |
| 무연산 판정 순서 | 같은 내용이면 `_prefilter`가 판 확인 전에 건너뛴다. 낡은 `expected_version`도 내용이 같으면 성공으로 돌아온다 | `src/kb/write/engine.py:163-178`, `src/kb/core/ledger.py:243-249` [코드 읽기] |
| 버전 충돌 | 원장이 `VersionConflict`를 던진다. 메시지에만 현재 판이 있다 | `src/kb/core/ledger.py:248` |
| 멱등 비교 | 같은 키의 기존 이벤트와 `kind, subject, payload_sha, actor, origin, on_behalf_of, generated_by`를 비교한다 | `src/kb/core/ledger.py:232-241` |
| tombstone | `kb put --tombstone ID --key --reason`(CLI만). `expected_version`을 받지 않고, 대상은 존재만 확인하고, 사유를 비밀 탐지하지 않는다. 투영은 `status=dead`이고 id 조회는 200이다. 나가는 엣지는 닫지 않는다 | `src/kb/commands/put.py:18-21`, `src/kb/write/record.py:194-211`, `src/kb/project/apply.py:381-387`, `C:140` |
| 원장의 tombstone 판 | `record.tombstone`도 레코드 판을 올리고 `record_head.content_sha`가 tombstone 본문 해시가 된다. 그래서 복원 쓰기가 무연산으로 건너뛰어지지 않는다 | `src/kb/core/ledger.py:48`, `:243-249`, `:274-277` |
| 복원 | 같은 ID에 `record.put`을 다시 쓰면 투영이 `status=active`로 만든다 | `src/kb/project/apply.py:357` [코드 읽기] |
| 큰 본문 | 64 KB 넘는 본문은 `raw/fp` CAS에 넣고 원장에는 `body_sha`만 둔다 | `src/kb/write/engine.py:37`, `:99-104`, `A:321` |
| 판 본문 사본 | 판마다 전체 본문이 원장 `payload`에 남고, `sensitivity < 3`이면 gold `content` 표에도 sha 단위로 들어간다 | `A:354`, `src/kb/project/apply.py:349-353` |
| 사용자 판의 추출 | 작성자가 `agent:*`가 아닌 first_party 판은 판마다 민감 범위 큐(sLLM)에 들어간다. 참조는 `<id>\|<seq>`다 | `src/kb/extract/tick_stage.py:15-25` |
| 위키 링크 | `[[x]]`, `[[x\|표시]]`, `[[x#제목]]`. 공개 ID 형식(`[A-Za-z0-9][A-Za-z0-9:._-]*`)이면 `LINKS_TO`, 아니면 경고 `link_not_id:<x>` | `src/kb/write/record.py:25`, `:35-41`, `:72-79`, `src/kb/core/ids.py:16` |
| ID 모양 | 기록 `f-`, 엔티티 `e:<type>:<slug>`, 주장 `c-`(base32 12자), 스냅샷 `n-`(hex 16자), 문서 `d-`(hex 16자), 엣지 `r-`, 근거 `ev-`, 티켓 `t-`(uuid7 base32). `s-`는 MCP 프로세스 세션이다 | `src/kb/core/ids.py:33-35`, `:60-93`, `:128-137`, `src/kb/write/author.py:22` |
| 비밀 탐지 | 쓰기 전 `build_payload` 안에서 제목, 본문, `props`(이름과 값), 링크를 검사한다. 적중하면 `secret`으로 올리고 격리하고 경고 `secret_detected:<규칙>`을 남긴다. 위치(`Hit.start`, `end`, 코드포인트)는 계산하지만 `scan_record`가 버린다. 커밋 전 수정은 멱등 키, ID, 타입, 삭제 사유를 `scan_key`로 따로 검사해 거절하고, `:`로 나뉜 16~128자 소문자 16진수 칸(앞 칸 이름이 key, token 같은 말이 아닐 때)은 다이제스트로 보고 뺀다. 속성 이름도 식별자로 검사해 거절한다. 작성기가 직접 붙인 내용 해시 꼬리는 늘 뺀다 | `src/kb/write/record.py:39-47`, `:50-58`, `:141-144`, `:187`, `:246-248`, `src/kb/write/secrets_scan.py:15`, `:211-244` [코드 읽기, 커밋 전] |
| `source_path` 우회 | `scan_record`가 호출자의 `props.source_path`를 경로로 받고, 그 경로가 전역 허용 경로(`*.png`, `node_modules/` 등)에 맞으면 `scan_text`가 아무것도 검사하지 않는다. 검토자가 `props.source_path='import/shot.png'`로 키가 든 본문의 적중이 0이 되는 것을 확인했다. 커밋 전 수정으로 `scan_record`는 경로 허용 목록을 쓰지 않고 `source_path`를 읽지 않는다 | `src/kb/write/secrets_scan.py:270-277` [검토 실행, 코드 읽기] |
| 오탐 해제 | TTY `kb secret release <id>` | `A:575`, `src/kb/commands/secret.py:12-13` |
| 작성자 | MCP는 `agent:<세션>` + `on_behalf_of=user:sagae`, TTY `kb put`과 inbox는 `user:sagae`, 비 TTY `kb put`은 `agent:cli` | `src/kb/write/author.py:46-59`, `A:557` |
| 작성자 표시 | 카드는 `user:`로 시작하는 작성자만 `user`로, 나머지는 `agent`로 표시한다 | `src/kb/read/cards.py:185-186` |
| 경계 | 같은 UID 앞에서 작성자 구분과 민감도 필터는 실수 방지다. "운영자 주장은 인증이 아니다"는 이미 겪은 교훈이다 | `A:563`, `src/kb/write/author.py:3-4`, `docs/adr/0003-llm-backends.md:99` |
| first_party 게이트 | 원장 `meta.fp_open`이 없으면 `spool/fp-held`에 보류한다. 2026-11-01에 열렸다 | `src/kb/write/engine.py:107-108`, `:214-215`, `A:675`, `A:1271` |
| 스풀 재적재 실패 | 재적재 때 판이나 멱등 충돌이면 `spool/in/.failed/`와 `dlq(kind=spool_reload)`로 간다 | `A:679` |
| 스풀 생략 | `commit(spool_on_timeout=False)`이면 게이트 시간 초과를 예외로 올린다 | `src/kb/write/engine.py:200-201`, `:227-229` |
| `/v1/meta.first_party_open` | 보이는 first_party 노드가 하나라도 있다는 뜻이다. 게이트 상태가 아니다 | `src/kb/read/catalog.py:189-193` |
| 귀속 열 | 원장에 `actor`, `on_behalf_of`, `generated_by`가 있고 투영 노드에도 있다. `actor`는 형식 제약이 없는 문자열이다 | `A:346-347`, `src/kb/project/apply.py:360-361`, `schemas/events/envelope.schema.json:44-47` |
| 타입 | `Note`(묶음 `user`)가 있다. `Document`는 묶음 `evidence`, 외부 문서(`d-`)용이다. `Topic`, `Page`, `TopicSpec`, `Review`는 없다. 엣지 `ABOUT`, `REQUESTS_ABOUT`, `LINKS_TO`는 있다 | `schemas/types/Note.json:5-6`, `schemas/types/Document.json:5-6`, `schemas/types/edge-ABOUT.json`, `schemas/types/edge-REQUESTS_ABOUT.json`, `D4:163` |
| 요청 티켓 | `kb_request(topic, reason, priority?, url?)`. 문장 500자, URL 50개. 병합 확인을 원장 잠금 밖에서 하고, ID는 임의 uuid7이고, 쓰기는 따로 한다. 상태 `queued → in_progress → done \| unanswerable \| blocked_policy` | `src/kb/ticket/__init__.py:19-25`, `:149-164`, `src/kb/core/ids.py:136-137`, `A:1220` |
| 수집 프로필의 티켓 | `kb-collect` 프로필의 `kb_ticket_list`가 티켓 `topic` 글을 수집 에이전트(외부 LLM)에게 준다 | `src/kb/serve/mcp_collect.py:130-139` |
| 주제(ADR-0004) | `Topic` 엔티티 `e:topic:<slug>`, `kb topic add/show/list/pause/retire`, `kb_request kind=topic`, `IN_TOPIC`, `COLLECTS_FOR`, 주제 월 상한 기본 $10. 주제 비용 귀속은 TP5, 엔진 장부는 D5 | `D4:161-205`, `D4:175`, `D4:438`, `D4:1015`, `D4:1801`, `D4:1811`, `D4:1815` |
| 유료 호출 | 호출마다 예산을 예약하고 정산한다. 키는 쓰기 주체에만 있다 | `src/kb/extract/budget.py:131`, `:147`, `D4:842`, `D4:1772` |
| `internal`의 세션 노출 | 일반 세션의 `kb-mcp`는 `internal` first_party를 읽고 그 내용은 Claude에 닿는다. 사용자가 2026-11-01에 확정했다 | `docs/adr/0002-user-decisions.md:56`, `:65-67` |
| 사람 판단 대기열 | `kb review`는 생존 판정(H01~H11)용이다. 주장 검증을 사람이 바꾸는 경로는 없다 | `src/kb/commands/review.py:1`, `A:508` |
| loupe 읽기 | `loupe serve`가 소켓 HTTP로 읽는다. 라이브러리는 없다(sagae-tools는 Node 26) | `A:1233-1256` |

## 2. 전송과 경로

### 2.1 비교

| 기준 | A. 소켓 HTTP 쓰기 | B. MCP `kb_put` 확장 | C. CLI `kb put` |
|---|---|---|---|
| loupe와 맞는가 | loupe는 이미 이 소켓으로 읽는다(`A:1239`). loupe 초안도 이 안을 권한다(`L 5.1`) | loupe는 MCP 클라이언트가 아니다. tower 경로는 호출마다 사용자 확인을 받고 `-p`에서 거부된다(`A:1231`) | 저장마다 Python 프로세스를 띄운다. 입력이 argv로 간다(`L 5.1`) |
| 귀속 | 인증된 앱과 주장된 작성자를 따로 남긴다(3.2) | `agent:tower`, 대리 `user:sagae`(`A:557`) | 비 TTY라 `agent:cli`(`src/kb/write/author.py:53-55`) |
| 구조화 오류 | problem+json(`src/kb/serve/http.py:36-57`) | 문자열(`src/kb/serve/mcp.py:172-175`) | JSON `code`(`src/kb/write/cliutil.py:33-35`) |
| 원격 이전 | 같은 경로를 TCP + Bearer로 낸다(`D4:1769-1770`) | tower 상류가 바뀐다 | ssh가 필요하다 |
| 새 위험 | 읽기 전용 서버에 쓰기가 생긴다. 소켓 권한만으로는 같은 UID와 loupe 프록시를 막지 못한다 | 없음(이미 있음) | 없음(이미 있음) |

**결정.** A를 loupe의 주 경로로 쓴다. 새 위험은 3장의 토큰, 대상 확인, 예산 허가로 막는다. B는 세션용으로, C는 스크립트와 관리용으로 그대로 둔다. 세 통로는 같은 함수(`put_record`, `tombstone_record`, `engine.commit`)를 부른다. 편집기 경로만 다른 점은 3.4의 대상 확인, 7장의 비밀 거절, 4.6의 위키 링크 모양 검사다.

**쓰기 전용 소켓은 두지 않는다.** loupe 초안은 읽기와 다른 쓰기 소켓을 가정한다(`L 부록 A A2`). 두 소켓 모두 같은 UID의 0600 파일이라(`src/kb/commands/serve.py:47-52`) 권한이 나뉘지 않는다. 실제 경계는 토큰 범위다. 소켓을 하나 더 두면 소켓 활성화 유닛과 유휴 종료(`A:1240`)가 하나 더 생긴다.

### 2.2 경로

| 메서드 | 경로 | `operationId` | 성공 | 하는 일 |
|---|---|---|---|---|
| `POST` | `/v1/records` | `createRecord` | 201, 보류·스풀이면 202 | 새 기록 |
| `PUT` | `/v1/records/{id}` | `replaceRecord` | 200, 202 | 전체 교체 편집 |
| `POST` | `/v1/records/{id}/tombstone` | `tombstoneRecord` | 200, 202 | 기본 읽기에서 내린다 |
| `POST` | `/v1/records/{id}/promote` | `promoteRecord` | 201 | 메모를 주제 정의로 승격 |
| `POST` | `/v1/topics/{id}/research` | `requestResearch` | 201(새 실행), 200(열린 실행) | 연구 요청(6장) |
| `POST` | `/v1/topics/{id}/research/{run}/stop` | `stopResearch` | 200 | 연구 실행 멈춤(6장) |
| `GET` | `/v1/topics/{id}/research` | `getResearch` | 200 | 연구 요청 상태(6.3) |
| `GET` | `/v1/writes/{ref}` | `getWrite` | 200 | 스풀·보류된 쓰기의 상태. 발급한 토큰만 읽는다(5.9) |
| `DELETE` | `/v1/writes/{ref}` | `discardWrite` | 200 | `failed` 쓰기의 본문을 지금 지운다. 발급한 토큰만(5.8, 5.9) |
| `GET` | `/v1/nodes/{id}/reviews` | `listClaimReviews` | 200 | 주장별 리뷰와 제보 사유·선택 URL. 일반 읽기 범위(6.5) |
| `GET` | `/v1/hitl` | `listHitl` | 200 | HITL 항목 목록. `reviewer` 범위(6.8, FW9) |
| `POST` | `/v1/hitl/challenge` | `hitlChallenge` | 201 | 동작에 묶인 WebAuthn 도전(6.8, FW9) |
| `POST` | `/v1/hitl/{item}/resolve` | `resolveHitl` | 200 | WebAuthn 확인과 함께 항목 해결(6.8, FW9) |
| `POST` | `/v1/reviewer/enroll` | `enrollReviewer` | 201 | 인증기 등록 후보. 신뢰 저장소 반영은 사용자의 별도 특권 단계(6.8, FW9) |
| `POST` | `/v1/actions` | `prepareUserAction` | `publish`는 202, 나머지 201 | 사용자 동작 준비: `release`, `declassify`, `publish`. `reviewer` 범위(5.10, 6.8) |
| `GET` | `/v1/actions/{id}` | `getUserAction` | 200 | 비동기 준비 상태·후보 조회. 발급 `reviewer` 토큰만(5.10) |
| `POST` | `/v1/actions/challenge` | `userActionChallenge` | 201 | 준비된 사용자 동작에 묶인 WebAuthn 도전(6.8) |
| `POST` | `/v1/actions/{id}/external-refine` | `consentExternalRefine` | 202 | 전송 내용에 묶인 WebAuthn 동의를 검증한 뒤 외부 정제 접수. `reviewer` 범위(5.10) |
| `POST` | `/v1/actions/{id}/execute` | `executeUserAction` | 200 | 사람 확인 뒤 사용자 동작 실행(6.8) |

- 연구 경로의 `{id}`는 `TopicSpec`의 `f-` ID, 기록 경로는 대상 기록의 `f-` ID, 사용자 동작 경로는 준비 응답의 `action_id`다. `{run}`은 연구 실행(티켓) ID다.
- `POST /v1/records`와 `PUT /v1/records/{id}`는 쿼리 `dry_run=1`을 받는다. 검증과 비밀 탐지만 하고 쓰지 않는다. 다른 쿼리 파라미터는 400 `bad_param`이다(`C:129`).
- 요청 본문은 `application/json`, UTF-8이다. 본문 상한은 4.5에 있다.
- 쓰기 응답은 읽기 경로의 `Envelope`를 쓰지 않는다. `kb_put` 응답과 같은 평면 객체에 필드를 더한 것이다(`src/kb/write/engine.py:56-59`, `C:1382-1411`).
- 쓰기 경로의 응답은 `Cache-Control: no-store`다.
- 쓰기는 `kb serve`의 스레드풀에서 돈다. 게이트 대기는 5초이고, 넘으면 기록 쓰기는 바이트 한도를 예약한 뒤 202 `spooled:true`다(`A:654`, `src/kb/write/engine.py:225-238`, 5.8). 승격과 연구 요청은 스풀하지 않는다(`spool_on_timeout=False`, `src/kb/write/engine.py:200-201`). 잠금 안 확인이 필요하기 때문이고, 503 `gate_busy`와 `Retry-After`로 답한다.
- 쓰기 경로의 동시 처리는 2개다 [설정값]. 원장 게이트가 하나라 더 열어도 빨라지지 않는다. 읽기 상한 16(`A:1244`)과 따로 센다.

### 2.3 처리 순서

```
요청 → 형식·크기 검사 → 경로 힌트 거절(7.2) → 비밀 탐지: 기록 전체 + 식별자(7.2)
     → [쓰기 잠금: gate.acquire → BEGIN IMMEDIATE]
       → 멱등 재생 확인(같은 키면 첫 결과)
         → 재생이면 대상의 지금 가시성(3.4): 숨었으면 404 not_found, 보이면 첫 응답(5.1)
       → 대상 확인: 출처, 타입, 민감도, 격리, 지움(3.4)
       → 바이트·판 한도(5.8, 대기 중인 스풀 예약 포함)
       → expected_version 확인(낡으면 내용이 같아도 409)
       → 내용 해시 비교(같으면 unchanged)
       → 큰 본문 CAS(fsync) → event + payload + record_head → COMMIT
     → 투영 → 해제 → 응답
     게이트 대기 5초 초과(기록 쓰기만): [한도 잠금] → 바이트 한도 + 스풀 상한(5.8) → 예약 파일(fsync) → 스풀 파일 → 202
```

- 지금 엔진은 큰 본문 CAS를 게이트 전에 한다(`src/kb/write/engine.py:207-211`, `A:642`). 편집기 경로에서는 비밀 탐지와 대상 확인이 CAS보다 앞서야 하므로 FW3이 순서를 위처럼 바꾼다. 게이트 시간이 초과되면 아직 CAS에 쓰지 않은 상태로 스풀 파일에 넣는다. 스풀 본문은 이미 비밀 탐지를 지났다. 스풀된 만들기는 대상 ID의 머리를 보지 않고 받는다. 그 ID는 actor 이름공간의 해시라 다른 actor의 기록을 가리킬 수 없다(5.1). 스풀 전에 5.8의 바이트 한도를 예약하고, 한도나 스풀 상한을 넘으면 스풀하지 않고 429 `byte_quota_exceeded`나 503 `spool_full`로 답한다. 202는 예약이 내구 저장된 뒤에만 나간다.
- 요청 수 상한(분당 요청, 3.5)은 잠금 전에 본다. 홍수를 막는 장치이고 쓰기 허가가 아니다. 판과 바이트 한도는 멱등 재생 확인 뒤에 본다. 응답을 못 받은 재시도가 한도에 걸리지 않게 하기 위해서다.
- 낡은 판 확인을 무연산보다 앞에 둔다. 지금은 반대다(`src/kb/write/engine.py:163-178`). 이 순서 변경은 모든 통로에 적용한다. MCP `kb_put`과 inbox도 낡은 판이면 내용이 같아도 409가 된다. 9장 "바뀌는 것"에 적었다.

### 2.4 공통 요청과 응답 모양

```json
{"idempotency_key": "<문자열 1~256자>",
 "change": "save|autosave|auto",
 "on_secret": "reject",
 "record": {"type": "Page|Note|TopicSpec|Review", "title": "...", "body": "...", "body_format": "markdown",
            "sensitivity": "internal", "props": {}, "links": [], "expected_version": 3}}
```

- `record`는 `kb_put`의 `record`와 같은 필드 집합이다(`src/kb/write/record.py:21-22`). `author`, `actor`, `origin`, `generated_by`, `on_behalf_of`, `source_url`, `quote`는 400 `schema_invalid`다(`src/kb/write/record.py:47-52`).
- `PUT`에서 `record.id`는 생략하거나 경로의 `id`와 같아야 한다.
- 기록 쓰기의 `change`는 필수다. 6.8의 HITL·사용자 동작은 별도 스키마와 사람 증명을 쓰며 `change`를 받지 않는다. 기본값이 없다. 3.2에 뜻이 있다. 편집 키에는 `change`를 넣고, 만들기 키에는 넣지 않는다(5.1).
- `on_secret`은 `reject`(기본) 또는 `quarantine`이다(7장).

```json
{"id": "f-...", "version": 4, "seq": 190233, "replayed": false, "unchanged": false, "projected": true,
 "spooled": false, "held": false, "write_ref": null, "payload_sha": "3c9e…", "quarantined": false,
 "warnings": [], "reason": null,
 "actor": "app:loupe", "claimed_author": "user:sagae", "generated_by": "app:loupe:save"}
```

- 앞 9개 필드는 지금 `WriteResult.as_dict`(`src/kb/write/engine.py:56-59`)다. `unchanged`, `write_ref`, `payload_sha`, `quarantined`, `actor`, `claimed_author`, `generated_by`를 더한다.
- `payload_sha`는 서버가 받은 기록 본문의 정규 해시다. loupe는 이 값으로 자기 초안이 확정됐는지 맞춘다(5.9).
- `unchanged: true`는 내용 해시가 같아 새 판을 만들지 않았다는 뜻이다. `version`은 현재 판이다.

## 3. 인증, 로그인, 귀속, 대상 확인

### 3.1 범위

| 범위 | 읽기 | 쓰기 | 만들기 |
|---|---|---|---|
| (소켓, 토큰 없음) | `internal` 이하(지금 그대로) | 없음. 쓰기 경로는 401 `token_required` | |
| `viewer` | `internal` 이하 | 없음. 403 `scope_denied` | `kb token create --scope viewer`(지금) |
| `owner` | 결정 14 승인 뒤 `private` 이하 | 이 ADR에서 정하지 않는다. ADR-0004 P.7의 tower 경로가 정한다(`D4:1769`) | 지금 |
| `editor` **새** | `private` 이하(3.6) | 2.2의 쓰기 경로만. 타입 `Page`, `Note`, `TopicSpec`, `Review`. 민감도 `public`, `internal`, `private` | `kb token create --scope editor --label loupe`, TTY에서만 |
| `reviewer` **새** | `editor`와 같다 | 6.8의 HITL 해결과 사용자 동작 경로만. 실행마다 WebAuthn 사용자 확인이 있어야 한다 | `kb token create --scope reviewer --label loupe-review`, TTY에서만. `loupe serve`만 쥔다 |

**`editor`가 쓰지 못하는 것.** 적재 계약 묶음(`kb ingest`, `kb-collect`), 주장, 엔티티와 엣지의 직접 쓰기, 스냅샷, URL 제보(`kb_request`의 `url`), 최상위 `record.source_url`·`quote` 필드. `Review.props.source_url`만 6.5의 틀림 제보용 URL 예외이며, 직접 주장·인용 제출 권한은 아니다. loupe는 외부 사실을 확정하지 않는다. 연구 요청(6장)도 URL을 받지 않는다. 연구 요청이 서버 안에서 쓰는 티켓과 `Topic` 엔티티는 요청과 정의이고 외부 사실이 아니다(`D4:163`).

### 3.2 loupe 로그인과 귀속

**로그인이 KB에 닿는 방식.** loupe 로그인은 loupe 안의 관문이다. KB는 loupe의 계정, 비밀번호, 세션 쿠키를 받지 않고 저장하지 않는다. KB가 인증하는 것은 `loupe serve`가 쥔 `editor` 토큰 하나다. 요청마다의 `change`는 loupe의 신고이고 인증이 아니다.

```
브라우저(loupe 로그인 세션) → loupe serve(세션 확인, CSRF, /kb-write/*만) → KB 소켓(Bearer editor + change 신고)
```

**귀속 표.** `actor`는 인증된 주체, `on_behalf_of`는 주장된 작성자, `generated_by`는 앱과 변경 종류다.

| `change` | loupe가 쓰는 때 | `actor` | `on_behalf_of` | `generated_by` | 표시 |
|---|---|---|---|---|---|
| `save` | 로그인한 사람이 저장을 눌렀다고 loupe가 신고(`Ctrl+S`, 저장 단추, 승격, 연구 요청, 검토 결정) | `app:<라벨>` | `user:sagae` | `app:<라벨>:save` | "user:sagae가 썼다고 app:loupe가 주장", 카드 `f:user~app:loupe` |
| `autosave` | 사람이 친 내용을 loupe가 묶어 보냈다고 신고(무입력, 초점 이탈, 탭 닫기, 오프라인 초안 재전송) | `app:<라벨>` | `user:sagae` | `app:<라벨>:autosave` | 같음 |
| `auto` | loupe가 스스로 만든 변경(제목 링크를 ID로 바꾸기, 가져오기 변환, 형식 이전, 기본값 채우기) | `app:<라벨>` | 없음 | `app:<라벨>:auto` | "app:loupe의 자동 변경", 카드 `f:app:loupe` |

- HTTP 경로의 `actor`는 `user:sagae`가 되지 않는다. 예외는 6.8의 HITL 해결과 사용자 동작 실행이고, 그때는 토큰이 아니라 검증된 WebAuthn 사용자 확인이 사람의 행위를 증명한다. 그 밖의 `actor=user:sagae`는 TTY `kb put`과 inbox뿐이다(`src/kb/write/author.py:51-55`). 그래서 loupe의 주장과 터미널의 사람 쓰기가 원장에서 구별된다.
- `author.resolve`에 전송 `http`를 더한다(`src/kb/write/author.py:20`, `:46-59`). 인수는 토큰 라벨과 `change`다. 입력의 `author`를 받지 않는다는 원칙(`A:557`)은 그대로다.
- 카드 표시 규칙(`src/kb/read/cards.py:185-186`)에 `app:` 작성자를 더한다. 지금 규칙이면 `agent`로 보인다.
- 귀속은 쓸 때 한 번 정해 이벤트에 박는다. 재시도와 스풀 재적재는 다시 계산하지 않는다(`src/kb/write/author.py:6-7`). `on_behalf_of`, `generated_by`는 멱등 비교에 들어간다(`src/kb/core/ledger.py:237`).

**권한 판정에 쓰지 않는다.** 주장된 작성자와 `change`는 어떤 허가에도 쓰지 않는다: 편집 허가(3.4), 민감도, 비밀 해제, 연구 시작(6.4), 예산. 이것들은 토큰 범위, 대상 기록의 상태, KB 예산이 정한다. 근거: 같은 UID 프로세스는 `loupe serve` 설정 파일의 토큰을 읽어 `change=save`를 보낼 수 있다. 권한 우회 모드로 도는 세션도 같다. "운영자 주장은 인증이 아니다"는 이 저장소가 `llm:off` 해제 사고로 이미 배운 규칙이다(`docs/adr/0003-llm-backends.md:99`).

**loupe가 지켜야 할 것.** KB가 강제하지 못하는 약속이다. 지키지 않아도 KB의 허가와 예산은 무너지지 않고, 표시만 틀린다.

1. 로그인 세션이 있을 때만 KB 쓰기를 보낸다.
2. 각 쓰기의 `change`를 위 표대로 고른다. 사람이 `auto` 결과를 보고 고쳐 저장하면 그 판은 `save`다.
3. 4812 같은 loupe의 포트로 KB 쓰기 경로를 다시 내지 않는다. loupe의 쓰기 API는 loupe 세션 확인을 거친다.
4. Claude Code, Codex 같은 에이전트에게 `editor`·`reviewer` 토큰이나 loupe 계정을 주지 않는다. 에이전트는 MCP `kb_put`을 쓴다.
5. `private` 기록은 loupe 로그인 세션 뒤에서만 보인다. 4812 같은 loupe의 포트로 로그인 없이 내지 않는다. 결정 14 (c)의 이유(무인증 4812, `A:1514`)는 이 약속으로 막는다.

### 3.3 토큰

- **소켓의 쓰기와 인증된 읽기.** 쓰기는 전송과 상관없이 Bearer 인증을 요구한다. Unix 소켓 읽기도 `Authorization: Bearer`로 `editor`·`reviewer`를 인증하면 3.6·8장의 모든 편집기 읽기 경로에서 `private`까지 돌려준다. 토큰 없는 소켓 읽기만 지금처럼 `internal` 이하다. 보낸 토큰이 틀리거나 만료·폐기됐으면 401이며 무토큰 범위로 조용히 낮추지 않는다. 기존 소켓 읽기가 인증 헤더를 무시하는 부분(`src/kb/serve/http.py:598-602`)을 FW4에서 고친다.
- **이것이 막는 것과 못 막는 것.** loupe 4812 프록시를 통한 전달과, 소켓에는 닿지만 설정 파일을 못 읽는 샌드박스 프로세스는 막는다. 샌드박스 밖의 같은 UID 프로세스는 막지 못한다(`A:563`). 그래서 3.2는 귀속을 권한에 쓰지 않는다.
- **TTY 조건은 실수 방지다.** `editor` 토큰은 TTY에서만 만든다. TTY 판정은 `isatty()`라(`src/kb/write/tty.py:7-9`) `script`로 흉내 낼 수 있다. 보안 경계가 아니다.
- **발급과 저장.** loupe에는 범위 하나씩인 토큰 둘(`editor`, `reviewer`)을 발급한다. 사용자가 TTY에서 각각 `kb token create --scope editor --label loupe`, `kb token create --scope reviewer --label loupe-review`를 부른다. KB는 자기 설정의 `api-tokens`(0600)에 해시·범위·라벨·`tok_id`만 저장하고 값은 발급 시 한 번만 출력한다. 사용자가 값을 서로 다른 0600 파일에 넣으며 경로는 loupe가 정한다. KB는 자기 설정 밖에 토큰 파일을 쓰지 않는다. 브라우저, 에이전트 환경 변수, 명령줄, 로그에는 값을 두지 않는다.
- **토큰 선택.** loupe의 일반 읽기·기록 쓰기·연구·쓰기 참조에는 `editor`를 쓴다. `GET /v1/hitl`, `/v1/hitl/*`, `POST /v1/actions*`, `GET /v1/actions/{id}`, `POST /v1/reviewer/enroll`에는 `reviewer`를 쓴다. 범위를 합친 토큰이나 요청마다 두 토큰을 함께 보내는 방식은 쓰지 않는다. `reviewer` 토큰 소지는 WebAuthn 사람 증명을 대신하지 않는다.
- **토큰 일련 ID.** 만들 때 `tok_id`(uuid7)를 매겨 해시 줄에 함께 쓴다. 비밀이 아니고 토큰 값에서 나오지 않는다. 회전하면 새 `tok_id`다. 쓰기 참조의 소유 판정(5.9)에 쓴다.
- **라벨.** `[a-z][a-z0-9-]{0,31}`이고 살아 있는 토큰 사이에서 유일하다. 폐기·만료된 토큰의 라벨은 새 토큰이 다시 쓸 수 있고, 그 토큰은 같은 `actor`라 같은 ID·멱등 이름공간(5.1)을 이어받는다. 같은 앱의 후속 토큰이라는 뜻이고 다른 앱으로 새는 것이 아니므로 받아들인다. 쓰기 참조는 `tok_id`로 묶이므로 이어받지 않는다(5.9). 같은 라벨이 있으면 만들기를 거부한다. 라벨이 `actor`가 되므로 형식을 강제한다.
- **만료, 회전, 폐기.** `--expires`(기본 180일 [설정값]), `kb token rotate --label <라벨>`(새 토큰을 내고 옛 토큰에 만료 표시), `kb token revoke --label <라벨>`. 모두 TTY다. 파일 줄을 지우지 않고 표시 줄을 덧붙이며 `token_scope`가 그 표시를 본다.
- **마지막 사용.** 라벨별 마지막 사용 시각과 하루 쓰기 건수를 `ops.db` 지표로 남긴다(잃어도 되는 값, `A:608`). `kb status --json`이 낸다. 비율이나 점수가 아니라 건수다.

### 3.4 대상 확인(쓰기 잠금 안)

`PUT`, tombstone, 승격, 연구 요청, 멈춤은 대상 기록의 현재 머리를 **쓰기 잠금 안에서** 확인한다(2.3). 잠금 밖에서 읽은 값으로 판단하면 그 사이의 다른 쓰기를 놓친다.

| 확인 | 통과 조건 | 실패 |
|---|---|---|
| 존재 | `record_head`에 있다 | 404 `not_found` |
| 출처 | `origin=first_party` | 404 `not_found` |
| 타입 | 현재 판의 타입이 `Page`, `Note`, `TopicSpec`, `Review` 중 하나 | 404 `not_found` |
| 민감도 | 현재 판이 `public`, `internal`, `private` 중 하나이고 격리 표시가 없다. `secret`과 격리는 늘 숨는다 | 404 `not_found` |
| 지움 | `record.redact`로 지워지지 않았다 | 404 `not_found` |

- 실패는 모두 없는 기록과 같은 404다. 제목, 속성, 링크, 판 번호, 작성자를 싣지 않는다. 숨은 기록은 없는 기록과 같다는 규칙(`A:574`)과 `secret`은 HTTP로 나가지 않는다는 규칙(`src/kb/serve/http.py:192-199`)을 쓰기 경로에도 적용한다.
- 그래서 `editor`는 `Learning`, `Decision`, `Artifact`, `secret`, 격리된 기록, 다른 출처의 `private` 기록을 ID를 맞혀도 덮거나 지우지 못한다. first_party 네 타입의 `private`는 고칠 수 있다(3.6).
- 격리 저장(7.4)한 기록은 해제 전까지 loupe에서 고칠 수 없다. 해제는 6.8의 사용자 동작 `release`이고, TTY `kb secret release`도 같은 사람 증명을 거친다.
- 스풀된 쓰기는 재적재 때 같은 확인을 다시 한다. 실패하면 쓰기 참조가 `failed`, `not_found`가 된다(5.9).
- **죽은 머리.** 현재 판이 `record.tombstone`이면 타입, 민감도, 격리 확인은 마지막 `record.put` 판으로 한다. tombstone 페이로드에는 민감도와 격리 표시가 없으므로 현재 판을 보면 격리된 기록이 통과한다. tombstone된 대상은 통과해도 409 `current`에 내용을 싣지 않는다(5.4).
- 쓰기 참조 조회(5.9)는 예외다. 확정 전의 만들기 참조는 이 표가 아니라 소유로 판정하고 대상 머리를 읽지 않는다.

### 3.5 요청 수 상한 [설정값]

| 대상 | 상한 | 넘으면 |
|---|---|---|
| 토큰별 요청 | 분당 120, 순간 20 | 429 `too_many_requests` |
| 처리 중 쓰기 | 2 | 429 `too_many_requests`(`src/kb/serve/http.py:33`) |
| 기록별 새 판, `change=autosave`·`auto` | 30초에 1판(loupe 예의 규칙) | 429 `write_rate_limited` |
| 연구 요청 | 하루 5회 | 429 `write_rate_limited` |

- 이 표는 홍수 방지다. `change`별 하한은 클라이언트가 `save`로 신고하면 피할 수 있으므로 증가량을 묶는 장치가 아니다. 증가량을 묶는 것은 5.8의 바이트 한도다.

### 3.6 `private` 개방(사용자 결정 2026-11-04)

사용자가 "private 전면 개방"을 골랐다. 결정 14 (c)(`A:1514`)와 7.9의 읽기 규칙(`A:576`)은 편집기 경로에 필요한 만큼만 바꾼다. ADR-0001 문구 개정은 FW2와 같이 한다.

| 주체 | `private` 읽기 | `private` 쓰기 |
|---|---|---|
| `editor` 토큰(loupe serve) | 예. first_party 네 타입과, 그 밖의 `private` 노드의 목록·검색·본문 | 네 타입만 |
| `reviewer` 토큰 | `editor`와 같다 | 6.8의 사람 증명을 거친 해결·사용자 동작만 |
| 소켓 무토큰, `viewer`, `owner` HTTP | 아니오. 지금처럼 `internal` 이하 | 없음 |
| MCP `kb-mcp`, `kb-collect`, tower, `kb api`, `kb search` | 아니오. `kb_search`는 결과에 넣지 않고 `kb_get`은 없는 ID와 같은 `not_found`다 | 없음(MCP `kb_put`의 `private` 쓰기는 지금 규칙 그대로) |
| TTY `kb owner read` | 예(지금) | |

- **외부 LLM 전송은 publish 동작만 예외다.** `private` 본문, 제목, 속성은 원칙적으로 로컬 sLLM에만 간다(`A:766`). 단추나 reviewer 토큰으로 인증한 POST는 사람이 눌렀다는 증명이 아니다. 외부 정제는 5.10의 `publish_external_refine` 동의를 WebAuthn으로 검증한 뒤에만 그 증명이 지정한 메모 판·전송 내용에 한해 허용한다. 5.10의 `publish` 외에는 `private` 내용을 외부로 내보내지 않으며, 다른 `private` 기록이나 링크된 비공개 제목은 보내지 않는다. `private` `TopicSpec`은 `export_llm`, `export_query`가 늘 `false`이고, 생략해도 `false`다. `true`를 보내면 400 `schema_invalid`다. 연구 티켓·`Topic` 엔티티·실행 기록도 spec과 같은 민감도라 수집 프로필과 일반 HTTP에 보이지 않는다(6.1). 주제 이름이 공개 검색 서비스로도 나가지 않는다.
- **파생 주장과 근거의 민감도.** L2 파생 주장과 복사한 근거(인용문·문장 포함)는 연결된 모든 first_party 원본의 현재 민감도 중 최댓값 이상이어야 한다(`public < internal < private < secret`). 원본의 민감도를 높이면 이미 추출한 주장·근거·관련 엣지와 색인도 재투영한다. 지금은 엣지만 갱신하고 주장과 복사 근거를 남기는 결함이 있다(`src/kb/project/apply.py:200-209`, `src/kb/read/nodes.py:57-65`, 검토 근거). 원본 변경이 확정된 뒤부터 재투영 완료 전에도 모든 읽기는 현재 원본에 따른 가시성 제한을 먼저 적용한다. 현재 원본 민감도를 읽을 수 없는 주체에게는 HTTP·MCP·CLI의 목록, 검색/FTS, 본문, 이력/시점 조회, 엣지/백링크/이웃, 변경 피드, 내보내기 모두에서 숨고, 직접 조회는 없는 대상과 같은 404/`not_found`다. 낡은 투영이나 옛 판 조회로 우회하지 못한다. FW5가 기존 데이터 재투영과 회귀 시험을 맡는다. 민감도 하향은 자동 전파하지 않고, 6.8의 검증된 공개 결과 경계(5.10)에서만 허용한다.
- **`secret`과 격리는 `private` 위다.** `editor`도 읽지 못하고 쓰지 못한다(3.4). 해제는 6.8이나 TTY다.
- **민감도 낮추기.** `private` → `internal`·`public`과 `internal` → `public`은 읽기 범위를 넓히는 일이라 `editor` 토큰만으로 하지 않는다. `PUT`이나 승격으로 낮추려 하면 403 `declassify_requires_review` **새**다. 6.8의 사용자 동작 `declassify` 또는 `publish`와 사람 증명이 있어야 낮출 수 있다. 높이기(`internal` → `private`)는 `editor`로 된다.
- **기본 민감도(사용자 확정 2026-11-04).** loupe의 모든 새 `Page`·`Note`·`TopicSpec`·`Review`는 `sensitivity`가 빠지면 `private`다. 새 기록에 명시한 `public`·`internal`은 받을 수 있지만 서버가 만드는 기존 `private` 내용의 복사·승격·정제는 새 기록이라는 이유로 민감도 낮추기를 우회하지 못한다(5.7, 5.10). 메모의 **지식베이스에 반영** 단추는 로컬 준비를 시작하며, 외부 전송 전 동의와 결과 공개 전 확인은 5.10의 별도 WebAuthn 증명을 요구한다. 원본 메모는 `private`를 유지한다.
- 읽기 경로(8장)는 전송과 상관없이 인증된 `editor`·`reviewer`이면 `private`까지 보인다. 쓰기와 모든 읽기의 가시성 검사가 배포됐는지는 8.1의 단일 `/v1/meta.write` 계약으로 판단한다.

## 4. 기록 종류

### 4.1 타입

| loupe 이름 | KB 타입 | 묶음 | 개요 | 비고 |
|---|---|---|---|---|
| 문서 | `Page` **새** | `user` | 예 | 기존 `Document`는 외부 문서용 `evidence` 타입이라 쓰지 않는다(`schemas/types/Document.json:5-6`) |
| 메모 | `Note` | `user` | 예 | 기존 타입. ADR-0004도 메모를 `Note`로 본다(`D4:199`). loupe 초안의 `Memo`(`L 2.1`)는 이 타입이다 |
| 주제 | `TopicSpec` **새** | `user` | 아니오 | 사람이 고치는 주제 정의. 수집의 닻은 엔티티 `Topic`(ADR-0004)이다 |
| 검토 결정 | `Review` **새** | `user` | 아니오 | 연구 결과 하나에 대한 받기·버리기. 6.5 |

- **ADR-0004와 다른 점.** ADR-0004 T.1은 외부 편집기의 주제를 `type: Topic` 기록으로 적었다(`D4:197`). 그러면 같은 주제에 `Topic` 노드가 둘 생기고, 수집기 YAML의 `topics:`(`D4:288`)가 어느 쪽을 가리킬지 갈린다. 이 ADR은 기록 타입을 `TopicSpec`으로 바꾸고 `DEFINES` 엣지로 엔티티를 가리킨다(12장 질문 2).
- `editor`는 이 네 타입만 쓴다. 그 밖은 403 `type_not_allowed`다. provisional 등록(`src/kb/write/types.py:68-74`)은 이 경로에서 일어나지 않는다.

### 4.2 필드

공통: `title`(필수, 300자 이하), `body`(필수, 빈 문자열 허용), `body_format`(`markdown` 기본, `text`), `sensitivity`(`public`, `internal`, `private`. 기본 `private`), `props`, `links`. `retention`은 받지 않는다(늘 `permanent`, `A:581`).

| 타입 | `props` | `links` |
|---|---|---|
| `Page` | `tags`(문자열 50개 이하), `order`(정렬 문자열. 부동소수 금지 `A:362`), `icon`(8자 이하), `title_locked`(불리언), 사용자 속성(데이터베이스 보기 칸, `L 4.3`) | `PART_OF` → 상위 `Page`, `LINKS_TO`, `ABOUT` |
| `Note` | `tags`(문자열 50개 이하), `pinned`, `title_locked`(둘 다 불리언) | `LINKS_TO`, `ABOUT` |
| `TopicSpec` | `slug`(생략 가능, 4.2의 결정적 기본값, 명시하면 `ids.SLUG_RE`, `src/kb/core/ids.py:17`), `aliases`(20개 이하, 각 100자 이하), `domain`(`A`~`G` 부분집합), `parent`(`e:topic:<slug>` 또는 없음), `exclude`(문자열 20개 이하), `export_llm`(불리언, 기본 `false`, 6.6), `export_query`(불리언, `private`는 `false` 고정, 나머지 기본 `true`, 6.6) | `ABOUT` → 엔티티, 문서, `LINKS_TO`. `PROMOTED_FROM`은 승격·지식베이스 반영 경로만 쓴다 |
| `Review` | `target`(필수, 주장·엣지·엔티티 ID), `decision`(`accept`, `reject`; 화면 선택), `verdict`(`reject`; 틀림 제보), `topic`(`e:topic:<slug>`), `note`(500자 이하), `source_url`(선택, 틀림 제보 전용; 6.5) | 서버가 `REVIEWS` → `target`을 넣는다 |

- **타입별 속성 허용 범위(Q5).** 위 표가 이름과 형식을 정한다. `Note`는 `schemas/types/Note.json:9-17`의 `additionalProperties:true`를 유지하므로 `tags`·`pinned`·`title_locked` 밖의 사용자 키도 허용한다. 현재 `src/kb/write/record.py:199-201`의 타입별 속성 검증과 이 스키마는 미지 키를 거절하지 않는다 [코드 읽기]. `Page`도 위 표의 사용자 속성을 허용한다. 알려진 키의 형식 오류는 400 `schema_invalid`이고, 추가 키도 16 KB·JSON 자료형·비밀 탐지·경로 힌트 금지를 지켜야 한다. 새 `TopicSpec`·`Review`는 표의 키만 허용하고 미지 키는 400 `schema_invalid`다. `Review`는 `decision` 또는 `verdict` 중 하나가 필수이며 둘을 같이 보내면 값이 같아야 한다. `verdict`와 `source_url`의 추가 조건은 6.5다. `quarantine*` 같은 서버 관리 키는 편집기가 직접 설정하지 못한다(FW2/FW3).
- **생략한 slug(Q6).** 새 `TopicSpec`의 ID를 5.1로 먼저 정한 뒤 `slug = "t-" + sha256(UTF-8("kb-topic-slug-v1\0" + record_id)).hexdigest()[:16]`으로 ASCII 소문자 slug를 만든다. 제목의 한글은 그대로 라벨이고 번역·로마자 변환을 하지 않는다. 승격도 새 spec ID로 같은 계산을 한다. 정규화한 slug를 저장·응답하므로 재시도가 같다. `PUT`의 생략은 저장된 slug 유지이고 새 slug 생성은 아니다. 명시한 slug가 다른 spec과 충돌하거나 계산값이 충돌하면 409 `slug_taken`이며 임의 꼬리를 붙이지 않는다(FW2/FW6).
- **경로 힌트 금지.** `props`에 `source_path`, `path`, `file`, `filename`, 이름이 `_path`로 끝나는 키가 있으면 400 `schema_invalid`다. 비밀 탐지기가 경로를 허용 목록과 대조하기 때문이다(7.2).
- `TopicSpec`에는 엔진, 수집 방식, 예산 칸이 없다. KB가 정한다(6장). 예산을 바꾸는 일은 TTY `kb topic budget set`만 한다 [설정값].
- 사용자의 범위 문장(`TopicSpec.body`)은 사실이 아니다. 주장으로 투영하지 않는다(`D4:179`).
- `props`는 `PUT`의 전체 교체로 바꾼다. loupe는 셀 하나를 고쳐도 `props` 전체를 보낸다.
- `editor`의 `sensitivity`는 `public`, `internal`, `private`다(3.6). `secret`은 403 `sensitivity_not_allowed`다. 기본값과 낮추기 규칙은 3.6에 있다.
- 메모는 자동 삭제가 없다. 지우는 길은 사용자의 tombstone과 TTY `kb redact`뿐이다(`A:585`).

### 4.3 링크와 백링크

| 쓰는 형태 | 편집기 경로의 처리 |
|---|---|
| `[[f-…]]`, `[[e:feature:youtube-shorts]]`, `[[c-…]]`, `[[n-…]]`, `[[d-…]]` | 4.6의 모양을 통과하면 `LINKS_TO`(`src/kb/write/record.py:72-79`). 주장 `c-`와 스냅샷 `n-`도 대상이 된다 |
| `[[f-…\|보이는 이름]]` | 같다. `\|` 뒤는 본문 글로만 남는다(`src/kb/write/record.py:38`) |
| `[[f-…#제목]]` | 페이지에 대한 엣지. 앵커는 본문 글로만 남는다. 블록 수준 링크는 v1에 없다(`C:1437`) |
| `[[쇼츠 후킹 구조]]`, `[[Shorts]]`, `[[c-suite]]` | 엣지 없음. 경고 `link_not_id`(값은 싣지 않고 순번만, 7.2) |
| `links: [{rtype, dst}]` | 명시 엣지(`src/kb/write/record.py:65-71`). 4.2 표의 `rtype`만, `dst`도 4.6의 모양. 본문 링크와 겹치면 한 엣지다(`:66-80`) |

- **이름 해석은 loupe가 한다.** 서버는 제목으로 링크를 풀지 않는다. 제목은 유일하지 않고, 쓸 때 푼 결과가 재생에서 달라지면 안 된다. loupe는 `[[`를 입력할 때 `GET /v1/search?q=&kinds=record,entity`로 후보를 보이고 고른 결과를 `[[<id>|<이름>]]`로 넣는다. loupe가 혼자 바꿨다면 그 저장은 `auto`다.
- **못 푼 링크.** loupe는 빨간 링크로 보인다. 누르면 새 `Page`를 만들고 링크를 `[[<새 id>|<이름>]]`로 바꿔 저장한다.
- **백링크.** `GET /v1/nodes/{id}?include=backlinks`(`C:1157`). tombstone된 기록에서 나가는 링크는 백링크에서 빠진다(FW5, 5.5).

### 4.4 첨부

v1에는 첨부가 없다. 바이트는 KB에 들어오지 않는다.

- 이미지와 파일은 loupe 쪽에 둔다. 본문에 `https://` 주소를 글로 쓸 수 있고, KB는 그 주소를 가져오지 않는다. 그 주소는 외부 사실 제보가 아니다.
- 참조로 붙이기: 이미 KB에 있는 스냅샷 `n-…`이나 기록 `f-…`를 링크로 건다.
- 나중에 첨부가 필요하면 ADR-0004 P.2의 `PUT /v1/blob/<sha256>`(`D4:1684`)과 `raw/fp`(`A:321`)를 쓰는 안을 따로 정한다(12장 질문 4).

### 4.5 크기 [설정값]

| 대상 | 상한 | 넘으면 |
|---|---|---|
| 요청 본문 | 2 MiB | 413 `body_too_large` |
| `record.body` | UTF-8 1 MiB | 413 `body_too_large` |
| `title` | 300자 | 400 `schema_invalid` |
| `props` 정규 JSON | 16 KB | 400 `schema_invalid` |
| 링크(명시 + 위키) | 500개 | 400 `schema_invalid` |

**64 KB 경로와 결함.** 64 KB 넘는 본문은 `raw/fp`에 들어가고 원장에는 `body_sha`만 남는다(`src/kb/write/engine.py:37`, `:99-104`). 투영은 본문이 없으면 `content` 표에 넣지 않는다(`src/kb/project/apply.py:349-355`). 읽기는 `content` 표에서만 본문을 찾고, 없으면 410 `content_removed`다(`src/kb/read/nodes.py:214-218`, `:363-365`). 문단 색인도 본문이 있을 때만 연다(`src/kb/project/apply.py:366-367`). 그래서 64 KB 넘는 loupe 문서는 HTTP에서 지워진 것처럼 보이고 검색되지 않는다 [코드 읽기]. FW5가 고친다.

- 투영이 `sensitivity < 3`인 큰 본문을 `raw/fp`에서 읽어 `content`에 넣는다. 같은 읽기가 `src/kb/write/owner.py:33-34`, `src/kb/guard/export_md.py:80-81`에 있다. redact는 이미 sha로 `content`를 지운다(`src/kb/project/apply.py:401-405`).
- `raw/fp` 객체가 없거나 깨졌으면 `projected=false`로 남기고 다음 tick이 다시 본다. `system.projection_quarantined`로 보내지 않는다. 디스크 같은 환경 실패와 같은 처리다(`A:677`).
- 409의 `current.body`도 큰 본문이면 CAS에서 읽는다.

### 4.6 위키 링크 모양

공개 ID 형식은 넓다(`src/kb/core/ids.py:16`). 그래서 `[[Shorts]]`도 ID로 통과해 없는 대상 `Shorts`로 엣지가 된다(`src/kb/write/record.py:72-79`) [코드 읽기]. 접두사만 보면 `[[c-suite]]`, `[[d-day]]`도 통과한다. 편집기 경로는 종류별 정확한 모양만 받는다.

| 종류 | 모양 | 근거 |
|---|---|---|
| 기록 | `f-` + base32 소문자 26자 | `src/kb/write/record.py:29-32`, `src/kb/core/ids.py:128-133` |
| 엔티티 | `e:<type>:<slug>`, `TYPE_RE`, `SLUG_RE` | `src/kb/core/ids.py:84-90` |
| 주장, 엣지, 근거 | `c-`, `r-`, `ev-` + base32 12자 | `src/kb/core/ids.py:33-35`, `:60-81` |
| 스냅샷 | `n-` + hex 16자 | `src/kb/core/ids.py:68-69` |
| 문서 | `d-` + hex 16자 | `src/kb/core/ids.py:72-73` |

- 모양이 맞지 않으면 `link_not_id`다. 모양은 맞지만 대상 노드가 없으면 엣지를 두고 경고 `link_dangling`이다.
- `s-`는 스냅샷이 아니라 MCP 프로세스 세션이다(`src/kb/write/author.py:22`). 1판의 `s-` 표기는 틀렸다.
- 이 규칙은 편집기 경로에만 적용한다. 공용 `_links`를 바꾸면 MCP와 inbox 동작이 바뀐다. 그 두 경로의 같은 결함은 따로 고친다(12장 질문 8).

## 5. 편집 의미

### 5.1 멱등 키

| 동작 | loupe가 만드는 키 [설정값] |
|---|---|
| 만들기 | `loupe:c:<초안 UUID>`(`change`를 넣지 않는다) |
| 편집 | `loupe:e:<id>:v<expected_version>:<change>:r<초안 개정 번호>`(초안 내용이 바뀔 때마다 1씩 오르는 정수) |
| tombstone | `loupe:t:<id>:v<expected_version>` |
| 승격 | `loupe:p:<메모 id>:v<메모 판>` |
| 연구 요청 | `loupe:r:<spec id>:<실행 UUID>` |
| 멈춤 | `loupe:x:<run id>` |

- 키는 256자 이하이고 기한이 없다(`src/kb/write/record.py:26`, `:140-141`, `A:363`). 키에 비밀이 있으면 거절한다(7.2). HTTP 키는 호출자가 고른 키라 작성기 꼬리 예외가 없다(7.2). 편집 키는 16진수 다이제스트 대신 초안 개정 번호로 내용을 가른다. 다이제스트 칸 규칙의 알려진 놓침에 기대지 않기 위해서다. 같은 내용의 재전송은 같은 번호라 재생이다.
- 같은 키, 같은 내용의 재시도는 첫 응답을 `replayed:true`로 돌려준다. 같은 키에 다른 내용이나 다른 귀속은 409 `idem_conflict`다(`C:1392`, `src/kb/core/ledger.py:237`). 예외는 아래 만들기 키다.
- **편집 키에는 `change`가 들어간다.** 응답을 못 받은 자동 저장 뒤 같은 내용의 명시 저장은 다른 키가 된다. 그 저장은 낡은 판이면 409 `version_conflict`이고, `current.payload_sha`가 보낸 것과 같으면 loupe는 확정된 것으로 본다(5.4).
- **만들기 ID는 actor 이름공간의 결정적 해시다.** 편집기 경로의 새 기록 ID는 `f-` + base32(SHA-256(`kb-record-id-editor-v1\0` + actor + `\0` + 만들기 키)의 앞 16바이트)다. 저장하는 비밀이 없으므로 검증, 백업, 회전, 복구할 것이 없고, 원장을 내보낸 세그먼트에서 다시 만들어도 같은 키는 같은 ID다. `actor`는 토큰에서 서버가 정하고(3.2) 클라이언트가 보내지 못하므로, 다른 앱은 A의 이름공간 안의 ID를 만들 수 없다. 남이 A의 키를 알아 ID를 계산해도 얻는 것이 없다: 그 ID로 하는 읽기와 쓰기는 3.4를 지나고, 숨은 기록은 없는 기록과 같은 404다. 지금 `derive_id`(`src/kb/write/record.py:61-64`)는 키만 해시한다. MCP, inbox, CLI의 ID 규칙과 이미 있는 기록의 ID는 바꾸지 않는다.
- **멱등 키도 actor 이름공간이다.** 편집기 경로는 원장 `event.idem_key`에 실효 키 `h\0<actor>\0<클라이언트 키>`를 저장하고 그 값으로 찾는다. 원장의 조회(`src/kb/core/ledger.py:232-239`)는 지금처럼 저장된 문자열 하나로 찾으므로 바꾸지 않는다. 실효 키가 actor를 품고 있어 조회가 저절로 actor별이 된다. 그래서 A가 키 K를 쓴 뒤 B가 K를 보내면 B는 A와 충돌하지 않고 자기 기록을 만들며, K가 쓰였다는 것을 알 수 없다. 다른 통로(MCP, inbox, CLI, intake, harvest)의 키는 지금처럼 그대로 저장한다. 두 형식이 섞이지 않도록 모든 통로에서 클라이언트 키에 NUL(`\0`)이 있으면 400 `schema_invalid`다. 이미 NUL이 든 키로 저장된 이벤트는 그대로 남고, 그 키로 다시 보내는 것만 400이 된다. 2026-11-04 운영 원장을 읽기 전용으로 조회한 결과 이벤트 38,485건 중 NUL이 든 멱등 키는 0건이다 [실측]. 실효 키만 NUL로 시작하는 `h\0` 접두사를 가지므로 다른 통로의 키와 겹칠 수 없다. 256자 상한과 비밀 탐지는 클라이언트 키에 적용하고(7.2), 실효 키의 원장 열 상한은 FW3이 actor 길이만큼 늘린다. 쓰기 참조의 `idem_keys`, `hold_name`(`src/kb/write/engine.py:111-112`)도 실효 키로 계산한다.
- **만들기 키에는 `change`가 없다.** 같은 actor의 같은 키는 늘 같은 ID다. 그래서 한 초안은 늘 한 ID다. 자동 저장 만들기의 응답을 잃고 사용자가 `Ctrl+S`를 누르면 같은 키, 같은 ID로 간다. 내용과 귀속이 같으면 재생이다. 다르면(`generated_by`가 `autosave`와 `save`로 다르거나 그 사이 입력이 늘었으면) `idem_conflict` 대신 409 `version_conflict`와 `current`(그 ID가 3.4를 통과할 때만, 아니면 404)로 답한다. loupe는 5.4대로 `PUT … expected_version=<current.version>`으로 잇는다. 두 번째 기록은 생기지 않는다. ID와 멱등 키가 모두 actor 이름공간이라 그 ID의 머리는 같은 actor가 같은 키로 만든 것뿐이다.
- **스풀된 만들기의 충돌.** 재적재 때 만들기 ID에 머리가 이미 있으면(보이든 숨었든) 그 쓰기는 `failed`, `code:"create_conflict"` **새**다. 이 판정은 머리의 유무만 보고 3.4를 계산하지 않으므로, 숨은 머리와 보이는 머리가 같은 코드와 같은 처리 경로(같은 시간 등급)로 끝난다. 쓰기 참조(5.9)도 만들기 참조에는 대상 머리를 보지 않는다.
- **남는 것.** actor는 자기 이름공간의 ID와 멱등 키만 건드린다. 그래서 남는 신호는 "내가 이 키로 만든 기록이 아직 이 ID에 있다"(그 뒤 격리, 지움, 민감도 상향이 있었어도)뿐이다. 그 기록은 그 actor가 썼고 첫 응답에서 ID를 이미 받았으므로 새로 드러나는 것이 없다. 내용, 판, 민감도는 나가지 않는다. 같은 라벨의 토큰을 회전해도 actor가 같아 이름공간이 같다. 다른 라벨의 토큰(다른 actor)은 이 신호를 얻지 못한다. 같은 키를 보내도 다른 실효 키, 다른 ID가 되기 때문이다.
- **재생도 가시성을 다시 본다.** 같은 키의 첫 결과가 있어도, 그 대상(만들기·편집·tombstone·승격의 기록, 연구 요청과 멈춤의 spec)이 지금 3.4를 통과하지 못하면(그 뒤 `kb redact`, 민감도 상향, 격리) 첫 응답 대신 숨은 대상과 같은 404 `not_found`다. ID, 판, `payload_sha`, `write_ref`, `seq`를 싣지 않는다. 격리 저장(7.4)을 재시도해도 같다. 이 확인은 쓰기 잠금 안, 재생 조회 바로 뒤다(2.3).

### 5.2 만들기

```http
POST /v1/records
Authorization: Bearer kbt_e_<토큰>
Content-Type: application/json

{"idempotency_key":"loupe:c:5b0c8a5e-2f43-4d1a-9a8e-0d3f6c1e2b71","change":"save",
 "record":{"type":"Page","title":"쇼츠 후킹 구조","body":"# 첫 3초\n[[e:feature:youtube-shorts|유튜브 쇼츠]]의 시작 장면을 모은다.",
           "body_format":"markdown","sensitivity":"internal","props":{"tags":["shorts"],"order":"a0"},
           "links":[{"rtype":"PART_OF","dst":"f-hq3k2m4n5p6q7r8s9t0uvwxyza"}]}}
```

```http
HTTP/1.1 201 Created
Location: /v1/nodes/f-7vfz3b2k4q6m8n1p0r5s9t2wxa
Content-Type: application/json

{"id":"f-7vfz3b2k4q6m8n1p0r5s9t2wxa","version":1,"seq":190112,"replayed":false,"unchanged":false,"projected":true,
 "spooled":false,"held":false,"write_ref":null,"payload_sha":"a41c…","quarantined":false,"warnings":[],"reason":null,
 "actor":"app:loupe","claimed_author":"user:sagae","generated_by":"app:loupe:save"}
```

- 보류(`held:true`)나 스풀(`spooled:true`)이면 202이고 `write_ref`가 있다. 5.9를 따른다.

### 5.3 편집

전체 교체다. 보내지 않은 `props`, `links`는 새 판에서 빠진다. 서버는 필드를 병합하지 않는다.

```http
PUT /v1/records/f-7vfz3b2k4q6m8n1p0r5s9t2wxa
Authorization: Bearer kbt_e_<토큰>

{"idempotency_key":"loupe:e:f-7vfz3b2k4q6m8n1p0r5s9t2wxa:v1:autosave:r12","change":"autosave",
 "record":{"type":"Page","title":"쇼츠 후킹 구조","body":"# 첫 3초\n...\n# 첫 문장\n...","body_format":"markdown",
           "sensitivity":"internal","props":{"tags":["shorts","hook"],"order":"a0"},
           "links":[{"rtype":"PART_OF","dst":"f-hq3k2m4n5p6q7r8s9t0uvwxyza"}],"expected_version":1}}
```

```json
{"id":"f-7vfz3b2k4q6m8n1p0r5s9t2wxa","version":2,"seq":190140,"replayed":false,"unchanged":false,"projected":true,
 "spooled":false,"held":false,"write_ref":null,"payload_sha":"3c9e…","quarantined":false,"warnings":[],"reason":null,
 "actor":"app:loupe","claimed_author":"user:sagae","generated_by":"app:loupe:autosave"}
```

- `expected_version`이 없으면 428 `expected_version_required`다(`src/kb/write/record.py:132-133`).
- `expected_version`이 현재 판과 같고 내용이 같으면 200, `unchanged:true`다.
- `expected_version`이 낡았으면 내용이 같아도 409다(2.3).

### 5.4 충돌

대상이 3.4를 통과하고 판이 다를 때만 409다. 통과하지 못하면 404이고 `current`가 없다.

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{"type":"https://kb.local/problems/version-conflict","title":"version conflict","status":409,
 "detail":"expected_version이 현재 판과 다르다","code":"version_conflict",
 "instance":"/v1/records/f-7vfz3b2k4q6m8n1p0r5s9t2wxa",
 "current":{"version":2,"status":"active","payload_sha":"9f2a…","actor":"agent:tower","claimed_author":"user:sagae",
            "generated_by":null,"recorded_at":"2026-11-04T07:12:30Z","title":"쇼츠 후킹 구조","body":"# 첫 3초\n...",
            "body_truncated":false,"props":{"tags":["shorts"]},"links":[{"rtype":"PART_OF","dst":"f-hq3k2m4n5p6q7r8s9t0uvwxyza"}]}}
```

- problem 모양은 지금 함수 그대로이고(`src/kb/serve/http.py:36-42`) `current`를 더한다. `detail`은 고정 문구다. 지금 `VersionConflict`는 문자열만 가지므로(`src/kb/core/ledger.py:248`) FW3이 구조로 바꾼다.
- `current.body`는 200,000자까지이고 넘으면 `body_truncated:true`다(`C:1157`). 큰 본문은 CAS에서 읽는다(4.5).
- 현재 판이 tombstone이면 `current`는 `{"version":<tombstone 판>,"status":"dead"}`뿐이다. 제목, 본문, 속성, 링크, `payload_sha`, 작성자를 싣지 않는다. tombstone 이벤트에는 민감도가 없어, 격리된 기록을 CLI로 tombstone한 뒤 같은 키 만들기나 낡은 `PUT`이 tombstone 전 본문을 받아 갈 수 있기 때문이다. 그 전에 3.4가 마지막 `record.put` 판 기준으로 숨은 대상을 404로 거른다. loupe는 `current.version`으로 복원(5.5)하거나 휴지통을 보인다.
- **loupe의 행동.** `current.payload_sha`가 자기가 보낸 것과 같으면 확정된 것으로 보고 초안을 지운다. 다르면 사용자 초안과 `current`를 나란히 보이고, 사용자가 합친 결과를 `expected_version=<current.version>`, `change=save`, 새 키로 저장한다. 자동 덮어쓰기를 하지 않는다.

### 5.5 tombstone과 복원

```http
POST /v1/records/f-7vfz3b2k4q6m8n1p0r5s9t2wxa/tombstone
Authorization: Bearer kbt_e_<토큰>

{"idempotency_key":"loupe:t:f-7vfz3b2k4q6m8n1p0r5s9t2wxa:v2","change":"save","expected_version":2,"reason":"쇼츠 문서로 합침"}
```

```json
{"id":"f-7vfz3b2k4q6m8n1p0r5s9t2wxa","version":3,"seq":190201,"replayed":false,"unchanged":false,"projected":true,
 "spooled":false,"held":false,"write_ref":null,"payload_sha":"77d0…","quarantined":false,"warnings":[],"reason":null,
 "actor":"app:loupe","claimed_author":"user:sagae","generated_by":"app:loupe:save"}
```

- 대상 확인(3.4)과 `expected_version`은 필수다. 지금 `tombstone_record`는 둘 다 하지 않는다(`src/kb/write/record.py:194-211`). FW3이 편집기 경로에 더한다.
- `reason`은 500자 이하다. 비밀이 있으면 격리 없이 422로 거절한다(7.2).
- tombstone의 `change`는 `save`만 받는다. 자동 삭제가 없다는 요구를 지킨다. 이것은 표시 규칙이고 허가가 아니다.
- 결과: `status=dead`, 기본 읽기에서 빠지고 id 조회는 200이다(`C:140`). 본문은 지워지지 않는다. loupe의 휴지통은 `status=dead`인 first_party 기록이다.
- tombstone은 지금 나가는 엣지를 닫지 않는다(`src/kb/project/apply.py:381-387`). FW5가 tombstone된 기록의 `LINKS_TO`, `PART_OF`, `ABOUT`, `PROMOTED_FROM`을 `eff_status=dead`로 투영해 백링크에서 뺀다. 복원하면 새 판의 링크가 다시 연다.
- **복원**은 `PUT`에 `expected_version=<tombstone 판>`, `change=save`다. tombstone 판의 `content_sha`가 tombstone 본문의 해시라 무연산으로 건너뛰지 않고(`src/kb/core/ledger.py:274-277`), 투영이 `status=active`로 되살린다(`src/kb/project/apply.py:357`). 3.4의 타입·민감도·격리 확인은 마지막 `record.put` 판 기준이다(3.4 "죽은 머리").
- **물리 삭제**는 HTTP에 없다. TTY `kb redact <id> --reason`뿐이다(`A:585`).
- 열린 연구 실행이 있는 `TopicSpec`은 tombstone할 수 없다. 409 `research_running`이다.

### 5.6 판 이력

- 판 목록: `GET /v1/nodes/{id}/history`의 `versions`(`C:1195-1197`). 지금 판 행은 `version`, `label`, `status`, `recorded_at`, `expired_at`이다(`C:1203`). FW1이 `actor`, `claimed_author`, `generated_by`, `payload_sha`를 더한다(호환 추가).
- 옛 판 본문: `GET /v1/nodes/{id}/body?as_of_observed=<그 판의 recorded_at>`(`src/kb/serve/http.py:92`, `C:233`).
- 판 되돌리기는 그 내용으로 새 판을 쓰는 것이다(`change=save`, `L 5.3`).
- 민감도가 오른 ID의 옛 판은 숨는다(`C:1197`). `secret` 판의 본문은 gold에 들어가지 않는다(`src/kb/project/apply.py:352-353`).

### 5.7 메모를 주제로 승격

메모는 바뀌지 않는다. 새 `TopicSpec` 기록 하나를 만들고 `PROMOTED_FROM` 엣지로 메모를 가리킨다. loupe는 승격과 동시에 연구를 시작하므로(`L 6.1`) `research:{"run_id":…}`를 주면 같은 커밋에서 6.1의 연구 요청까지 쓴다. 승격은 스풀하지 않는다(2.2).

```http
POST /v1/records/f-memo2k4q6m8n1p0r5s9t2wxab/promote
Authorization: Bearer kbt_e_<토큰>

{"idempotency_key":"loupe:p:f-memo2k4q6m8n1p0r5s9t2wxab:v4","change":"save","to":"topic","memo_version":4,
 "research":{"run_id":"0b7e3c52-6a19-4f0e-9d4b-8f1a2c3d4e5f"},
 "record":{"title":"유튜브 쇼츠","body":"쇼츠 형식의 정책, 수익화, 추천, 제작 관행",
           "props":{"slug":"youtube-shorts","aliases":["YouTube Shorts","쇼츠","Shorts"],"domain":["A","B","D"],
                    "parent":"e:topic:youtube","exclude":["쇼츠 광고 집행"],"export_llm":false,"export_query":false}}}
```

```http
HTTP/1.1 201 Created

{"id":"f-spec5m7n9p1q3r5s7t9v1w3x5y","version":1,"seq":190260,"replayed":false,"unchanged":false,"projected":true,
 "spooled":false,"held":false,"write_ref":null,"payload_sha":"5e21…","quarantined":false,"warnings":[],"reason":null,
 "actor":"app:loupe","claimed_author":"user:sagae","generated_by":"app:loupe:save",
 "promoted_from":{"id":"f-memo2k4q6m8n1p0r5s9t2wxab","version":4},
 "research":{"topic":"e:topic:youtube-shorts","run":"t-q2w3e4r5t6y7u8i9o0p1a2s3d4","state":"queued",
             "status_url":"/v1/topics/f-spec5m7n9p1q3r5s7t9v1w3x5y/research"}}
```

- 메모는 3.4 확인을 지나야 한다. `memo_version`이 현재 판과 다르면 409 `version_conflict`다.
- 서버가 `record.type=TopicSpec`과 `links`의 `PROMOTED_FROM`을 넣는다. 요청에 `type`이나 `PROMOTED_FROM`이 있으면 400이다.
- **승격은 공개가 아니다.** 새 spec의 `sensitivity`를 생략하면 잠금 안에서 확인한 원본 메모의 현재 민감도를 그대로 물려받는다. 명시한 값도 원본보다 낮으면 403 `declassify_requires_review`다. 위 예의 원본이 `private`이면 spec·티켓·주제·실행도 `private`이고 `export_llm`·`export_query`는 `false`다. `true`를 보내면 400이다. 원본의 민감도를 낮추려면 먼저 사람 증명을 거친 `declassify`를 하거나, 원본을 그대로 두는 `publish`를 쓴다(5.10, 6.8). 승격의 새 ID·생략한 민감도·동시 연구 요청으로 우회하지 못한다(FW6).
- 예산 장치가 없으면(6.4) 승격은 성공하고 `research`는 `{"state":"budget_unavailable"}`다. 승격 기록만 남는다.
- loupe의 8초 되돌리기(`L 6.1`)는 멈춤과 spec tombstone 두 호출이다. 승격 기록은 원장에 남는다.
- **ADR-0004와 다른 점.** ADR-0004는 `Topic -LINKS_TO-> Note`에 `props.role=promoted_from`을 적었다(`D4:199`). 지금 기록의 `links`는 `{rtype, dst}`만 받는다(`src/kb/write/record.py:68-71`). 전용 `rtype`을 쓴다.

### 5.8 자동 저장, 판 묶기, 증가 한도

원장은 덧붙이기만 하므로 커밋한 판을 합칠 수 없다(`A:357`). 묶기는 커밋 전에 해야 한다.

| 안 | 내용 | 비용 [추론] |
|---|---|---|
| 1. 그대로 | 1.5초 무입력마다 판(`L 5.2`) | 판이 수천 개가 되고 판 목록이 쓸모없어진다 |
| **2. 묶은 판(채택)** | 1.5초 자동 저장은 loupe IndexedDB 초안(`L 5.4`)에만 간다. KB에는 30초 무입력, 초점 이탈, 탭 닫기, 계속 입력 중 5분마다, 명시 저장 때만 판을 쓴다 | 검토 추정: 하루 8시간, 1~2분마다 한 판, 20~50 KB 문서면 하루 240~480판, 원장 5~25 MB/일이고 gold `content`에 같은 양이 더해진다. 연 2~9 GB이고 재구축 재생과 C:·E: 사본이 이것을 물려받는다 |
| 3. KB 초안 저장소 | 원장 밖에 KB가 초안을 받고 주기적으로 판을 낸다 | first_party 본문의 사본이 원장 밖에 생긴다. 비밀 탐지, `kb redact` 처리 목록(`A:587-596`), 백업 범위, 민감도 필터를 새 저장소마다 다시 정해야 한다. `ops.db`는 잃어도 되는 저장소라(`A:608`) 초안을 잃는다. 얻는 것은 기기 사이 초안 동기화 하나다 |

**결정.** 안 2. 초안 영역은 loupe의 기기 안 저장소이고 KB 밖이다. IndexedDB의 same-origin 격리는 같은 UID의 로컬 프로세스에 대한 보호 경계가 아니며, localhost 출처 탈취와 브라우저 프로필 접근의 잔여 위험은 6.8에서 명시적으로 수용한다. KB는 판을 서버에서 합치지 않는다. loupe는 판 목록에서 같은 `actor`, `generated_by` 계열이 10분 안에 이어진 판을 한 묶음으로 접어 보인다. 이 묶음은 읽기 쪽 표시이고 저장되지 않는다.

**바이트 한도 [설정값].** `change`와 무관하다. 클라이언트가 무엇을 신고하든 같은 한도다.

| 대상 | 한도 | 넘으면 |
|---|---|---|
| 토큰별 원장 증가 | 최근 24시간 32 MB | 429 `byte_quota_exceeded`, `Retry-After`는 창이 풀리는 시각 |
| 기록별 원장 증가 | 최근 24시간 8 MB | 같음 |

- 증가량은 원장에서 센다: 그 `actor`(또는 그 기록)의 최근 24시간 이벤트 `payload` 바이트와 `raw/fp` 객체 크기의 합이다. 원장이 진실이므로 서버를 다시 띄우거나 `ops.db`를 잃어도 한도가 풀리지 않는다. FW4가 계산에 필요한 색인을 정한다.
- 확인은 멱등 재생 확인 뒤, 쓰기 잠금 안에서 한다(2.3). 합계에는 아래의 `pending`·`held` 예약을 더한다. `failed` 예약은 더하지 않는다.

**원칙: 디스크에 남은 바이트는 지울 때까지 센다. 하루 한도와 보유 상한은 따로다.** 편집기 경로가 디스크에 남긴 바이트는 상태와 상관없이 물리적으로 지울 때까지 어느 한 예산에 든다. 단계별로 따로 세면 단계 밖에 남는 사본이 샌다(3판의 `.failed/` 누수, `src/kb/core/spool.py:83-98`). 그러나 실패한 본문을 하루 한도에 넣으면, 게이트 경합 중 낡은 판 1 MiB `PUT` 32번이 그 토큰의 모든 쓰기를 7일 동안 429로 막는다. 그래서 예산을 둘로 나눈다.

| 예산 | 세는 것 | 세지 않는 것 | 넘으면 |
|---|---|---|---|
| (a) 하루 받기 한도(위 표, 토큰 32 MB·기록 8 MB) | `committed`(원장의 최근 24시간 증가) + `pending`·`held` 예약 + 이 요청 | `failed` 본문과 그 사본. **실패한 본문은 하루 한도를 막지 않는다** | 429 `byte_quota_exceeded` |
| (b) 보유 상한(토큰별 64 MiB·200건, 편집기 경로 전체 256 MiB·400건) [설정값] | 원장 밖 디스크에 남은 모든 바이트: `pending`, `held`, `failed`, `.failed/` 사본, `dlq` 사본. 24시간 창과 상관없이 purge 전까지 | `committed`(원장 쪽 바이트는 (a)와 원장 보존 규칙이 묶는다), `purged` | 아래 3번: 먼저 그 토큰의 오래된 `failed`를 지우고, 지울 것이 없을 때만 503 `spool_full` |

**스풀과 보류의 예약 [설정값].** 게이트 시간 초과로 스풀하는 쓰기(202 `spooled`)와 first_party 게이트 보류(202 `held`)도 두 예산을 쓴다. 원장 쓰기 잠금 없이 일어나므로 따로 예약한다.

1. 게이트 대기가 끝나면 한도 잠금(`KB_HOME/run/fpapi-quota.lock`, `flock`)을 잡는다. 원장 게이트와 다른 잠금이고 짧게 쥔다. 잠금 순서: 한도 잠금은 늘 가장 안쪽이다. 한도 잠금을 쥔 채 게이트를 기다리지 않는다.
2. (a) 하루 받기 한도: 원장의 최근 24시간 증가(읽기 스냅숏, 게이트 불필요) + `pending`·`held` 예약 바이트 + 이 요청의 스풀 파일 바이트(본문 포함)를 토큰별, 기록별로 위 표와 비교한다. `failed` 예약은 더하지 않는다. 넘으면 아무것도 쓰지 않고 429 `byte_quota_exceeded`다.
3. (b) 보유 상한: `purged`가 아닌 모든 비확정 예약(`pending`, `held`, `failed`) + 이 요청을 토큰별, 전체로 상한과 비교한다. 넘으면 한도 잠금 안에서 6번의 purge를 그 토큰의 가장 오래된 `failed`부터 넘지 않을 때까지 돌린다(전체 상한이면 모든 편집기 토큰의 가장 오래된 `failed`부터). loupe는 그 초안을 기기에 갖고 있으므로(5.9 초안 규칙: `failed`는 초안을 지우는 조건이 아니다) 잃는 내용이 없다. 지울 `failed`가 남지 않았는데도 넘으면(나머지가 모두 `pending`, `held`) 아무것도 쓰지 않고 503 `spool_full`, `Retry-After`다.
4. 예약 파일 `spool/refs/<write_ref>.json`(`{state:"pending", tok_id, actor, subject, kind, bytes, idem_keys, created_at}`)을 fsync하고, 그다음 스풀 파일을 쓴다. 둘 다 한도 잠금 안이다. 202는 두 파일이 모두 내구 저장된 뒤에만 나간다.
5. 상태 바꾸기: 재적재가 원장에 넣으면 예약은 `committed`가 되고 그 바이트는 원장 쪽에서 센다. 재적재가 거부되면 예약은 `failed`가 되고, 본문은 `spool/in/.failed/`에 남는다. 그 `bytes`는 (a)에서 빠지고 (b)에는 purge까지 남는다. 편집기 경로의 `dlq(kind=spool_reload)` 행에는 본문을 넣지 않고 `write_ref`와 `code`만 둔다. 다른 사본이 생기면 그 크기도 예약의 `bytes`에 더한다.
6. **purge.** `failed` 본문은 7일 [설정값] 남긴 뒤 지우고, 3번의 보유 상한에 닿으면 더 일찍 지운다. purge는 한도 잠금 안에서 본문(`.failed/` 사본과 그 밖의 사본)을 지우고 디렉터리를 fsync한 뒤 예약을 `purged`로 바꾼다. 그 사이에 죽으면 예약이 남아 (b)에서 계속 세고, 다음 purge가 본문이 없는 것을 보고 `purged`로 바꾼다. 더 세는 쪽으로만 틀린다. `purged` 예약은 상태 조회용 메타데이터만 남기고 30일 뒤 지운다.
7. **사용자 버리기.** `DELETE /v1/writes/{ref}`(2.2)다. 발급한 토큰만 부를 수 있고(5.9 소유 규칙), 상태가 `failed`일 때만 6번의 purge를 그 참조에 바로 돌려 200 `{"state":"purged"}`다. `pending`, `held`는 409 `write_in_flight` **새**다. 재적재와 겹치지 않게 하기 위해서이고, 그 쓰기는 `committed`나 `failed`로 끝난다. `committed`, `purged`는 200이고 아무것도 하지 않는다. 그 밖은 404다. loupe가 자기 초안을 버리는 것(5.9 초안 규칙 4)은 KB 호출이 아니고, 그 초안에 `failed` 참조가 있으면 이 호출을 함께 부른다.
8. **충돌 복구는 한도 잠금 안이다.** 재적재 순회는 예약 상태를 바꿀 때마다 한도 잠금을 잡는다. 스풀 파일이 없는 `pending` 예약은 `failed`, `code:"lost_before_spool"`이 되고 본문이 없으므로 바로 `purged`다. 원장에 같은 키가 있는 `pending` 예약은 `committed`가 된다. 4번이 예약과 스풀 파일을 같은 잠금 안에서 쓰므로, 복구는 막 예약만 쓰고 스풀 파일을 아직 쓰지 않은 살아 있는 쓰기를 보지 않는다.
9. 재적재도 (a)를 다시 본다. 예약이 있는 항목은 자기 예약을 빼고 센다. 예약 없이 들어온 스풀 항목(이 규칙 전에 쓴 것, 다른 통로)이 편집기 토큰의 (a)를 넘기면 `failed`, `code:"byte_quota_exceeded"`다. 이 항목도 그때 예약을 만들어 6번의 purge까지 (b)에서 센다.

- 결과: 게이트 경합 중 낡은 판의 1 MiB `PUT`을 되풀이하면 `failed` 본문이 (b)를 채우고, (b)에 닿을 때마다 그 토큰의 가장 오래된 `failed`가 지워진다. 디스크는 토큰당 64 MiB, 전체 256 MiB를 넘지 않고, 같은 토큰의 정상 쓰기는 (a)에 걸리지 않는다. 남은 비용은 그 `failed` 참조들이 7일보다 일찍 `purged`가 되는 것이다.
- 남는 틈: 한도 잠금 밖에서 같은 토큰이 원장에 막 커밋하는 쓰기는 스냅숏에서 빠질 수 있다. 넘치는 양은 쓰기 동시 처리 2 × 요청 상한 2 MiB = 4 MiB 이하다 [추론].
- 예약 파일은 `spool/` 아래에 있으므로 원장처럼 서버 재시작과 `ops.db` 손실에도 남는다.
- 최악 경우는 바이트로만 묶인다: 토큰 하루 32 MB가 원장에 들고 gold `content`에 같은 양이 들어 하루 약 64 MB, 연 약 23 GB다 [추론]. 검토의 무거운 날 추정(5~25 MB/일)은 한도 안이다.
- 1판의 "30초 하한이 증가를 묶는다"는 틀렸다. 토큰별 분당 30판, 판당 1 MiB면 하루 약 43 GB까지 갈 수 있었다(검토 M1). 하한은 3.5의 예의 규칙으로만 남는다.

**sLLM 추출 큐.** 지금은 `agent:*`가 아닌 first_party 판이 판마다 민감 범위 큐에 들어간다(`src/kb/extract/tick_stage.py:15-25`). `app:loupe` 판도 들어가고 자동 저장 판마다 로컬 sLLM 추출이 돈다. FW3이 바꾼다.

- `TopicSpec`, `Review`는 큐에 넣지 않는다. 정의와 결정이고 사실이 아니다(`D4:179`, 6.5).
- `Page`, `Note`는 넣는다. 사용자 기록을 로컬 sLLM으로만 분류하는 ADR-0003 3장 경로이고(`src/kb/extract/tick_stage.py:16-17`), 문서와 메모를 검색 가능한 관계로 잇는 것이 저장소 목적이기 때문이다. 다만 참조를 `<id>`로 합쳐 기록마다 최신 판 하나만 처리한다.
- `change=auto` 판(`on_behalf_of` 없음)은 넣지 않는다. 사람이 쓴 내용이 아니다.

### 5.9 스풀된 쓰기와 초안

게이트 시간 초과(202 `spooled`)나 보류(202 `held`)면 응답에 `write_ref`가 있다. `write_ref`는 스풀 파일 이름(이벤트 해시, `src/kb/write/engine.py:115-116`)이고 5.8의 예약 파일 `spool/refs/<write_ref>.json`이 그 상태를 쥔다. 예약 파일의 메타데이터는 `committed`, `purged`가 된 뒤 30일 남긴다 [설정값]. `failed`의 본문은 5.8의 purge가 지울 때까지 보유 상한에 든다.

```http
HTTP/1.1 202 Accepted

{"id":"f-7vfz3b2k4q6m8n1p0r5s9t2wxa","version":null,"seq":null,"replayed":false,"unchanged":false,"projected":false,
 "spooled":true,"held":false,"write_ref":"w-6b1f0c…","payload_sha":"3c9e…","quarantined":false,"warnings":[],
 "reason":"gate_timeout","actor":"app:loupe","claimed_author":"user:sagae","generated_by":"app:loupe:autosave"}
```

`GET /v1/writes/{ref}`:

```json
{"data":{"ref":"w-6b1f0c…","state":"failed","id":"f-7vfz3b2k4q6m8n1p0r5s9t2wxa","version":null,"code":"version_conflict"}}
```

| `state` | 뜻 | 원본 |
|---|---|---|
| `pending` | 스풀이나 보류에 있다 | `spool/in`, `spool/fp-held` |
| `committed` | 원장에 들어갔다. `version`이 있다 | 원장의 같은 멱등 키 |
| `failed` | 재적재가 거부됐다. `code`는 `version_conflict`, `idem_conflict`, `not_found`, `byte_quota_exceeded`, `lost_before_spool`, `create_conflict` 중 하나. 본문은 `.failed/`에 남고 지울 때까지 보유 상한(5.8 (b))에 든다. 하루 받기 한도(5.8 (a))에는 들지 않는다 | `spool/in/.failed/`, `dlq(kind=spool_reload)`(`A:679`, 본문 없음), 예약 파일 |
| `purged` | `failed` 본문을 지웠다(7일 경과, 보유 상한, `DELETE`). 보유 상한에서 빠진다. `code`는 남는다 | 예약 파일 |

**소유 규칙.** `GET /v1/writes/{ref}`는 예약 파일의 `tok_id`가 요청 토큰의 `tok_id`와 같을 때만 200이다. `tok_id`는 토큰을 만들 때 매기는 비밀이 아닌 일련 ID이고 `api-tokens`의 해시 줄에 함께 둔다(3.3). 다른 토큰(같은 라벨의 회전된 토큰 포함), `viewer`, 무토큰, 없는 참조, 기한이 지난 참조는 모두 같은 404 `not_found`다. `held` 참조는 이벤트의 멱등 키 해시라(`src/kb/write/engine.py:111-112`) 맞힐 수 있으므로 이 규칙이 필요하다. 소유자일 때 대상 확인은 대상의 머리 유무로 나뉜다.

- 만들기 참조이고 상태가 `pending`, `held`, `failed`, `purged`: 소유(`tok_id`)만으로 판정하고 예약 파일의 `state`, `code`, `id`를 준다. 대상 ID의 머리를 읽지 않는다. 그래서 `pending`은 다른 기록의 존재에 대해 아무것도 알리지 않는다(5.1 "스풀된 만들기의 충돌"). 그 `id`는 202 응답에 이미 있었고 내용은 싣지 않는다.
- 편집·tombstone의 참조, 또는 `committed`가 된 만들기: 3.4를 지금 머리에 적용한다. 통과하지 못하면 404이고 `id`, `version`을 싣지 않는다(5.1의 재생 규칙과 같다).
- `DELETE /v1/writes/{ref}`도 같은 소유 규칙을 쓴다.

**실패 본문 회수(Q12).** `GET /v1/writes/{ref}?include=body`는 발급한 `editor` 토큰의 `tok_id`가 같고 `state=failed`일 때만 저장된 초안의 `record`(본문·제목·속성·링크)와 `payload_sha`를 `data`에 더한다. 기본 조회는 계속 본문을 주지 않는다. 편집·tombstone 참조는 현재 대상의 3.4도 통과해야 한다. 만들기 실패는 자기 요청 사본만 돌려주며 대상 머리나 충돌한 다른 기록은 읽지 않는다. 저장된 사본 자체가 `secret`·격리이면 소유자에게도 404다. 같은 라벨의 회전 토큰·다른 토큰·숨은 대상은 `include`와 상관없이 404이고 본문·해시가 없다. 본문 회수와 purge는 같은 한도 잠금으로 경쟁을 막는다.

- 소유·가시성 확인을 통과한 `purged` 참조의 `include=body`는 **410 `content_removed`**(기존 본문 삭제 코드)이고 본문을 싣지 않는다. `include` 없는 조회는 200 `state=purged`를 유지한다. 참조 메타데이터까지 만료됐으면 기존처럼 404다. `failed`·`purged` 밖의 상태에서 `include=body`는 400 `bad_param`이다. 회수 가능 기간은 최대 7일이며 보유 상한·사용자 버리기로 먼저 purge될 수 있다(5.8). 회수 경로가 있어도 아래 초안 보존 규칙은 유지한다(FW4).

**loupe의 초안 규칙.** 초안은 아래 중 하나일 때만 지운다.

1. 그 초안 내용에 대한 200·201 응답을 받았다.
2. 그 초안의 `write_ref`가 `committed`다.
3. 판 이력에 그 초안의 `payload_sha`와 같은 판이 있다.
4. 사용자가 버렸다.

`/v1/changes`에 그 ID가 나타났다는 것만으로는 지우지 않는다. 두 탭 경우: 탭 A가 202 `spooled`를 받고, 탭 B가 v2를 바로 쓴다. A의 재적재는 `version_conflict`로 실패한다. A의 초안은 남아 있고, `write_ref`가 `failed`가 되면 loupe가 5.4의 비교 화면을 띄운다. 초안은 탭이 아니라 초안 ID로 저장하고, 탭 사이에는 BroadcastChannel로 상태만 나눈다(`L 5.3`).

### 5.10 메모의 지식베이스에 반영(사용자 동작 `publish`)

사용자 답: "기본은 private를 생각하고, 메모를 지식베이스에 반영하기 버튼이 눌렸을 때, 해당 메모의 정보들을 llm으로 정제후, kb에 반영하는 루트를 생각하고 있음." 단순 저장이나 주제 승격은 이 동작을 실행하지 않는다.

1. **로컬 준비(토큰만).** loupe의 단추는 `POST /v1/actions`에 `{action:"publish", target:<Note ID>, expected_version:<현재 판>, idempotency_key:<키>}`를 보낸다(`reviewer` 범위). 3.4와 비밀 탐지를 통과한 메모만 고정한 판으로 준비한다. 예약과 작업 상태를 내구 저장한 뒤 **202** `{action_id,state:"preparing",status_url}`와 `Location: /v1/actions/{action_id}`, `Retry-After: 1`을 돌려준다. 접수 목표는 1초 이내다. **이 POST는 로컬 sLLM 준비만 허가하며 private 내용은 외부로 한 바이트도 보내지 않는다.** 엔진 선택·API 필요성 판단도 로컬에서 한다. 짧고 단순한 정제·서식 정리·노트 분할·별칭 추출은 로컬 경로로 끝낼 수 있다. 준비 후보와 원본은 `private`다.
2. **외부 전송 전 첫 번째 사람 확인.** 외부 정제가 도움이 된다고 판단해도 E1 선택기는 전송을 시작하지 않는다. KB는 해당 메모 판만으로 외부 요청 본문 전체를 로컬에서 직렬화해 고정하고 `external_payload_sha = sha256(실제로 전송할 UTF-8 요청 본문 바이트)`를 계산한다. 프롬프트에 실리는 메모 제목·본문·속성·문맥과 선택 엔진/모델·요청 매개변수가 모두 그 바이트에 들어가며 다른 private 기록·링크된 private 제목은 넣지 않는다. 전송할 private 값은 고정한 본문에만 담고 URL·헤더·텔레메트리·시험 호출로 따로 보내지 않는다. 계획 내용과 엔진, 전송할 내용의 미리보기는 발급 reviewer 토큰의 상태 조회에만 보인다. 원본이나 프롬프트·엔진·매개변수를 바꾸면 새 해시·동의가 필요하다. 사람 확인 전에 엔진을 시험 호출하거나 외부 LLM으로 정제 필요성을 판단하는 일도 금지한다.
   - `POST /v1/actions/challenge {action_id,action:"publish_external_refine"}`는 6.8의 reviewer 인증·안전한 신뢰 저장소 검사를 거쳐 **메모 ID, 메모 판, external_payload_sha, action="publish_external_refine"**에 묶인 120초짜리 1회용 consent challenge를 만든다. `action_id`·선택 엔진/모델도 함께 묶고 loupe는 전송할 내용을 확인 화면에 보인다. 사용자 답 **"버튼 누르면 외부 허용"은 이 WebAuthn 사용자 확인 단계로 구현한다.** 토큰, 버튼 신고, `change`, 기존 사용자 인용만으로 동의를 대체하지 않는다.
   - `POST /v1/actions/{id}/external-refine {challenge_id,assertion,idempotency_key}`가 WebAuthn 서명·UV·RP ID/origin·카운터·도전·전송 해시·현재 메모 판을 검증한다. **검증에 성공하기 전에는 어떤 외부 엔진도 호출하지 않는다.** 증명이 없으면 403 `external_consent_required`, 잘못되면 403 `review_unverified`, 판·내용 변경/만료는 409 `review_stale`이며 외부 호출은 0건이다. 성공은 동의 기록과 도전 소비를 잠금 안에 원자적으로 남기고 작업을 202로 접수한다. 상태는 `preparing`, `refinement_mode=external_consented`, `external_refine.status=consented`로 바꾸며 완료 뒤 새 결과를 `ready`로 낸다. 증명은 고정한 요청 본문 한 번의 전송만 허가하고, `internal` 기록 공개 권한은 주지 않는다.
   - 작업자는 실제 전송 직전에도 신뢰 저장소·원본 가시성·메모 판·비밀 탐지와 고정 바이트의 해시를 검사하고 동의 기록이 일치해야 D5 예산을 예약해 외부 어댑터로 보낸다. SDK의 숨은 재시도·자동 엔진 전환은 끈다. 다시 전송하려면 새 동의가 필요하며 같은 키 재생은 추가 전송 없이 첫 작업만 가리킨다. 불확실한 전송은 6.4의 예약을 유지한다. 동의가 없으면 로컬 준비 결과만 유지하거나 `external_consent_required`로 멈춘다. 외부 엔진·예산이 없거나 E1/D5가 미배포면 외부로 보내지 않고 로컬로 대체한다. 동의·엔진·전송 해시는 provenance에 남긴다.
3. **결과 공개 전 두 번째 사람 확인.** 로컬 또는 검증된 외부 정제 결과를 `internal` `Note`·`Page` 후보와 정상 게이트의 주장 후보로 나눈다. 후보는 확인 전까지 `private`다. 사용자는 결과를 본 뒤 `POST /v1/actions/challenge {action_id,action:"publish"}`로 별도 WebAuthn 확인을 한다. 이 도전은 원본 ID·판·동작과 **확정할 결과별 타입·민감도·정확한 본문 해시**에 묶인다. 외부 전송 동의 증명을 이 확인에 쓰거나 그 반대로 쓰지 못한다. 외부 정제를 시작하면 앞서 발급한 로컬 결과용 도전은 무효다. `/execute`에서 이 두 번째 확인이 성공해야 `internal` 기록과 서버가 넣은 `PROMOTED_FROM`을 쓴다. 클라이언트가 주장·인용·엣지를 직접 넣는 길은 열지 않는다.
4. **공개 결과의 경계.** 사람 증명이 승인한 정제 결과만 민감도를 낮춘 별도 기록이 된다. 이 증명과 결과 해시는 원장에 남고, `PROMOTED_FROM` 자체는 민감도 상속의 예외 권한이 아니다. 그 기록에서 추출한 주장 후보는 공개된 결과를 first_party 원본으로 삼아 정상 first_party·인용 게이트를 지난다. 원본 메모의 비공개 문장·복사 근거를 끌어오거나, 사실 검증 없이 `supported`로 만들지 않는다. 원본 메모를 직접 근거로 삼는 다른 파생 주장·근거는 계속 3.6의 최댓값 규칙을 따른다. 공개 결과에서 비공개 원본으로 가는 링크는 읽기 범위 밖이면 ID·제목·판도 숨긴다.
5. 원본 메모의 본문·민감도는 바꾸지 않는다. 결과를 직접 `public`으로 내리려면 별도의 `declassify` 사람 확인이 필요하다. 준비 후보의 저장과 실행은 기존 first_party 게이트, 비밀 거절, 인증된 앱별 멱등 키, 요청·바이트 한도를 그대로 지난다. 준비 후보를 디스크에 보유하는 바이트도 5.8의 보유 상한에 포함한다. LLM 정제는 쓰기 잠금 밖에서 하고, 실행 시 원본 판과 결과 해시를 잠금 안에서 다시 확인한다. 재시도는 같은 실행 결과를 돌려주며 결과 기록이나 추출 요청을 중복 생성하지 않는다(FW9).

**준비 상태 조회(Q7).** `GET /v1/actions/{id}`는 발급 `reviewer` 토큰의 `tok_id`가 같은 요청만 읽는다. 다른 토큰(회전 포함), 숨은 대상, 없는 ID는 같은 404다. 읽기 봉투 `data`는 `{action_id, action, target, expected_version, state, created_at, expires_at, candidates, engine, cost_usd, duration_ms, code, refinement_mode, external_refine}`다. `refinement_mode`는 `local_only` 또는 `external_consented`다. `external_refine`은 `{status,external_payload_sha,engine,request_preview}`이며 status는 `not_needed`, `consent_required`, `consented`, `unavailable` 중 하나다. `consent_required`는 아직 외부 전송이 없다는 뜻이고 요청 미리보기도 private다. 후보는 `private`이며 현재 원본 가시성과 신뢰 저장소 안전 검사를 적용한다.

| `state` | 상태 조회가 주는 것 | 전이·상한 [설정값] |
|---|---|---|
| `preparing` | `candidates:[]`, 현재 선택한 `engine` 또는 `null`, 아직 모르는 비용·시간은 `null` | 로컬 준비와 동의 뒤 외부 준비 각각 접수 후 큐 대기 포함 120초 이내 완료. 사람 동의를 기다리는 시간에는 외부 작업을 접수하지 않는다. 넘으면 `failed`, `code=prepare_timeout` |
| `ready` | `candidates`에 타입·본문·민감도·해시, `engine:{kind:local 또는 external,backend,model}`, `cost_usd`(보고된 USD 십진 문자열; 로컬은 `"0"`, 보고 불가 `null`), `duration_ms`(정수, 큐 대기 포함) | 완료 뒤 15분간 확인 가능. 로컬 결과는 `refinement_mode=local_only`이며 외부 권장 시 `external_refine.status=consent_required`도 낸다. 동의 없이 로컬 결과만 공개할 수 있다. 외부 동의 검증 뒤에만 `preparing`으로 돌아가며 새 결과의 두 번째 확인이 필요하다. `expires_at`에 만료 시각 |
| `failed` | 후보 없음, 고정 오류 `code`, 알려진 엔진·비용·소요 시간만 | 자동으로 다시 외부 호출하지 않는다. 로컬 결과도 없고 외부가 필요하면 `code=external_consent_required`로 멈춘다. 새 준비 키도 먼저 로컬만 처리하며 외부 전송에는 새 동의가 필요하다 |
| `expired` | 후보와 본문을 제거한 상태·시각·엔진·비용 메타데이터만 | `ready` 기한 초과, 원본 판 변경 또는 실행 완료. 새 도전·실행은 409 `review_stale`이며 성공한 실행 키의 재생은 예외 |

준비 요청의 같은 멱등 키는 같은 `action_id`와 접수 결과를 재생하고 LLM 작업을 더 만들지 않는다. 준비 중 결과 공개용 도전·실행은 409 `write_in_flight`다. 외부 전송 동의는 고정한 전송 계획이 있는 `ready`에서만 발급하며 만료된 결과에서는 409 `review_stale`다. 시간 초과 뒤 외부 호출 결과가 불확실하면 6.4의 `uncertain` 예약을 유지하고, 늦게 온 결과로 후보를 공개하거나 만료를 되돌리지 않는다. `executed`는 준비 중/미실행이면 `false`다. 성공하면 준비 상태를 `expired`, `executed:true`로 바꾸고 확정 결과를 `result`로 같은 조회에 덧붙인다. 같은 실행 키의 결과 재생은 후보 만료로 지우지 않는다. 준비 후보의 본문은 실행 또는 만료 때 제거하고 상태 메타데이터는 30일 보존한다. `release`·`declassify` 준비는 LLM이 없어 기존 201이며 같은 조회·소유 규칙을 쓴다(FW9).

## 6. 주제에서 연구 요청으로

### 6.1 한 번의 호출

loupe의 동작은 "이 주제를 KB에 조사해 달라" 하나다. 엔진, 예산, 상한은 KB가 정한다.

```http
POST /v1/topics/f-spec5m7n9p1q3r5s7t9v1w3x5y/research
Authorization: Bearer kbt_e_<토큰>

{"idempotency_key":"loupe:r:f-spec5m7n9p1q3r5s7t9v1w3x5y:0b7e3c52-6a19-4f0e-9d4b-8f1a2c3d4e5f",
 "run_id":"0b7e3c52-6a19-4f0e-9d4b-8f1a2c3d4e5f","change":"save","expected_version":2}
```

```http
HTTP/1.1 201 Created
Location: /v1/topics/f-spec5m7n9p1q3r5s7t9v1w3x5y/research

{"spec":"f-spec5m7n9p1q3r5s7t9v1w3x5y","spec_version":2,"topic":"e:topic:youtube-shorts",
 "run":"t-q2w3e4r5t6y7u8i9o0p1a2s3d4","existing":false,"state":"queued","seq":190311,"replayed":false,
 "status_url":"/v1/topics/f-spec5m7n9p1q3r5s7t9v1w3x5y/research"}
```

**쓰기 잠금 안에서 하는 일.** 확인과 이벤트가 한 트랜잭션이다. 이벤트는 100개 이하라 한 게이트 보유 안에서 원자적이다(`src/kb/write/engine.py:11-12`). 스풀하지 않는다(2.2).

1. spec 대상 확인(3.4)과 `expected_version`.
2. 예산 장치 확인(6.4). 없으면 409 `budget_unavailable`이고 아무것도 쓰지 않는다.
3. 그 주제에 열린 실행이 있으면 새로 만들지 않고 200, `existing:true`, 그 실행을 돌려준다. 이때도 `research.request` 이벤트(아래)를 그 요청의 멱등 키로 쓴다. 결과가 원장에 남아야 재생이 같은 실행을 가리킨다.
4. 없으면 같은 커밋에 쓴다.
   - `research.request` **새 이벤트 종류**: 멱등 키 = 요청 키, `payload = {spec, spec_version, run, outcome: "opened"|"joined"}`. 이 요청의 첫 결과이고, 3번의 합류에서도 같은 모양으로 쓴다.
   - `ticket.open`: kind=topic, `spec`, `spec_version`, `run_id`. 실행 ID는 멱등 키에서 결정적으로 만든다. 지금 `ticket_id()`는 임의 uuid7이라(`src/kb/core/ids.py:136-137`) 재시도가 실행을 둘 만들 수 있다. `topic` 글은 `e:topic:<slug>`이고 `reason`은 고정 문구 "loupe 연구 요청"이다. spec 본문은 티켓에 싣지 않는다. 문장 병합(Jaccard, `A:1220`)은 쓰지 않는다. 주제 ID가 같으면 같은 주제다.
   - `entity.put Topic e:topic:<slug>`(처음이면 생성, 있으면 `status=active`). 시드어는 별칭 표로 간다(`D4:178`). 이 엔티티는 `origin=first_party`, `sensitivity`는 spec의 현재 판과 같다(기본 `private`). 외부 출처 엔티티로 만들지 않는다. 그래야 `export_llm=false`면 수집 프로필이 그 라벨과 별칭을 외부 LLM에 내지 않는다. `export_llm=true`면 6.6이 정한 칸만 보인다.
   - `edge.put PART_OF`(부모), `edge.put DEFINES`(spec → 주제), `edge.put REQUESTS_ABOUT`(실행 → 주제, 기존 엣지 타입).

- **재생.** 같은 요청 키의 재시도는 `research.request` 이벤트를 찾아 그 `run`을 돌려준다(`replayed:true`, `existing`은 `outcome`대로, `state`는 그 실행의 지금 상태). 합류했던 실행 A가 그 사이 닫혔어도 새 실행을 만들지 않는다. 오류 응답(409 `budget_unavailable`, 503 `gate_busy` 등)은 아무것도 쓰지 않았으므로 재시도가 처음부터 다시 판단한다. 재생 전에 spec의 가시성을 본다(5.1).
- 이 경로는 ADR-0004 TP1의 `kb_request(kind=topic)`과 `kb topic add --from-ticket`(`D4:192`)과 같은 함수를 부른다. 진입 함수가 하나라 주제 생성 규칙이 두 벌로 갈라지지 않는다. 지금 `open_ticket`은 병합 확인을 잠금 밖에서 하고 따로 커밋하므로(`src/kb/ticket/__init__.py:149-164`) 이 경로에 그대로 쓰지 않는다.
- **명시적 요청 기록.** `research.request` 이벤트가 "이 spec 판으로 조사해 달라"는 명시적 기록이다. `actor=app:loupe`, `on_behalf_of=user:sagae`(주장)이다. 다른 세션이 `kb_put`으로 쓴 spec도, 내용을 바꾸지 않은 채 이 호출로 연구를 요청할 수 있다. 1판처럼 "사람이 다시 저장해 작성자를 바꾼다"는 길은 내용이 같으면 무연산이라(`src/kb/write/engine.py:163-178`) 성립하지 않았고, 작성자를 허가에 쓰는 것이라 버렸다.
- **ADR-0004의 `proposed`.** ADR-0004는 확인 없이 들어온 에이전트 주제 기록을 `proposed`로 두고 수집을 돌리지 않는다(`D4:198`). 이 ADR에서 그 확인은 연구 요청 이벤트이고, 돈을 쓰는 허가는 6.4의 예산이다. 요청 이벤트는 허가가 아니라 기록이다.
- **연구 메타데이터도 상속한다.** `ticket.open`, `research.request`와 실행 기록, `Topic` 엔티티·별칭·연결 엣지는 모두 해당 `TopicSpec`의 현재 민감도 이상으로 투영한다. 티켓 민감도를 `internal`로 고정하는 지금 투영(`src/kb/project/apply.py:884-886`, 검토 근거)을 FW6에서 고친다. `private` 주제는 처음부터 `internal` 노드를 만들지 않으며, slug·제목·실행 ID·상태도 일반 HTTP 목록/검색과 MCP 티켓 목록에 새지 않는다. spec의 민감도를 높이면 이미 열린/닫힌 티켓·실행과 주제도 재투영하고, 완료 전의 읽기에도 3.6의 현재 원본 가시성 검사를 적용한다. `export_query`는 생략해도 `false` 강제이고 `true`는 400이다.
- `TopicSpec`을 연구 중에 고치면(`title`, `aliases`, `domain`, `exclude`, `parent`, `export_*`, `sensitivity`) 서버가 같은 쓰기에서 `entity.put` 새 판과 위 메타데이터의 민감도를 동기화한다. 옛 라벨은 별칭으로 남는다(`D4:413`).
- 같은 `slug`의 `Topic`이 다른 spec에 묶여 있으면 409 `slug_taken`이다.
- 엔진은 KB가 고른다. 결정적 경로가 먼저이고, 유료 과제는 과제 종류별 결과 기준 라우터가 팔을 고른다(`D4:1015`). ADR-0004의 외부 작업 공간(`D4:202-203`)은 loupe에서 고르지 않는다(12장 질문 3).

### 6.2 멈춤

```http
POST /v1/topics/f-spec5m7n9p1q3r5s7t9v1w3x5y/research/t-q2w3e4r5t6y7u8i9o0p1a2s3d4/stop
Authorization: Bearer kbt_e_<토큰>

{"idempotency_key":"loupe:x:t-q2w3e4r5t6y7u8i9o0p1a2s3d4","change":"save"}
```

```json
{"spec":"f-spec5m7n9p1q3r5s7t9v1w3x5y","topic":"e:topic:youtube-shorts","run":"t-q2w3e4r5t6y7u8i9o0p1a2s3d4",
 "state":"cancelled","topic_status":"paused","seq":190330,"replayed":false}
```

- 같은 커밋에서 `ticket.close`(새 닫힘 상태 `cancelled`)와, 다른 열린 실행이 없으면 주제 `status=paused`(`D4:188`)를 쓴다. 새 유료 과제를 꺼내지 않는다. 이미 보낸 호출은 끝나고 정산된다. 수집기는 지우지 않는다.
- 다시 시작은 새 `run_id`로 `research`를 부르는 것이다. 같은 spec 판이어도 멈춘 실행은 닫혔으므로 새 실행이 생긴다. 1판의 키(`loupe:r:<spec>:v<n>`)는 멈춘 뒤 같은 판의 요청을 첫 응답의 재생으로 돌려 주제가 멈춘 채로 남았다(검토 H3).
- `cancelled`는 티켓 상태 목록(`A:1220`)에 더하는 값이다. FW6이 티켓 스키마와 `kb_ticket_list`에 반영한다.

### 6.3 요청 상태 읽기

`GET /v1/topics/{id}/research`는 읽기 경로다. 봉투는 읽기 규칙(`C:82-107`)을 따르고 범위는 3.6과 같다. `editor`·`reviewer`만 `private` 실행을 보며, 다른 읽기 경로는 `internal` 이하다. spec이 3.4를 통과하지 못하면 404다.

```json
{"data":{"spec":"f-spec5m7n9p1q3r5s7t9v1w3x5y","topic":"e:topic:youtube-shorts","state":"in_progress",
  "run":{"id":"t-q2w3e4r5t6y7u8i9o0p1a2s3d4","status":"in_progress","opened_at":"2026-11-04T08:00:00Z"},
  "engines":[{"kind":"deterministic","collectors":5},{"kind":"llm","task":"extract","arm":"local:sllm","calls":120}],
  "cost":{"month_usd":"0.84","budget_usd_month":"10.00","reported":true,"as_of":"2026-11-04T09:15:00Z"},
  "results":{"accepted_claims":42,"edges":61,"needs_review":3,"since":"2026-11-04T08:00:00Z",
             "list_url":"/v1/nodes/e:topic:youtube-shorts/edges?direction=in&rtypes=IN_TOPIC",
             "review_url":"/v1/nodes/e:topic:youtube-shorts/edges?direction=in&rtypes=IN_TOPIC&include_unverified=true"},
  "discovery":"narrowed","discovery_reason":"private_topic_registered_sources_only",
  "pending_hosts":0,
  "failures":[{"stage":"fetch","source":"src:yt-help-shorts","code":"http_403","at":"2026-11-04T08:40:00Z"}]}}
```

| 필드 | 원본 | 근거 |
|---|---|---|
| `state` | `queued`, `in_progress`, `paused`, `cancelled`, `done`, `unanswerable`, `blocked_policy`, `budget_unavailable` | `A:1220`, `D4:188`, 6.2, 6.4 |
| `engines` | 그 주제에 귀속된 실행 기록의 엔진, 과제, 팔, 호출 수. 결정적 수집기 수는 `COLLECTS_FOR` 활성 엣지 수 | `D4:435-449`, `D4:421` |
| `cost` | `ops.db`의 `topic:<id>` 합계와 주제 상한. 보고가 없으면 `cost:null`, `reported:false` | `D4:430`, `D4:437` |
| `results` | `IN_TOPIC` 엣지 건수와 링크. 건수이고 점수가 아니다 | `D4:463` |
| `discovery`, `discovery_reason` | `private`는 `"narrowed"`, `"private_topic_registered_sources_only"`. 다른 주제는 내보내기 허용 범위대로 `"standard"` 또는 `"narrowed"`와 제한 이유 | 6.6 |
| `pending_hosts` | 사용자 승인을 기다리는 새 호스트 후보 수. 승인은 `kb topic approve`(TP3)이고 loupe는 수만 보인다 | `D4:247-275`, `D4:1813` |
| `failures` | 그 주제 수집기의 최근 실패(`fetch_log`, `dlq`) 최대 20건. 내부 주소와 호스트 이름은 빼고 소스 ID로만 준다 | `A:617-628` |

- 비율, 점수, 추천을 내지 않는다(CLAUDE.md 지침 5).
- loupe는 45초마다 이 경로를 읽는다(`L 6.2`).

### 6.4 유료 연구의 허가: KB 예산

유료 연구를 허가하는 것은 KB가 가진 예산뿐이다. 작성자, `change`, 토큰 라벨은 허가에 쓰지 않는다(3.2).

**예약.** 유료 호출 하나마다 KB 예산 장부가 한 트랜잭션에서 세 단위를 함께 예약한다. 하나라도 모자라면 호출을 보내지 않는다.

| 단위 | 한도 | 원본 |
|---|---|---|
| 주제 | 주제 월 상한 `budget_usd_month`(기본 $10) | `D4:175`, `D4:438`, TP5 |
| 전체 | HTTP로 연 주제 전체의 월 상한 $30 [설정값] | 이 ADR. 12장 질문 7 |
| 엔진 | 엔진별 속도 플래그의 오늘 상한과 주기 예산 | `D4:966-1013`, D5 |

- 예약과 정산은 기존 함수(`src/kb/extract/budget.py:131`, `:147`)를 넓힌다. 동시 요청은 장부 잠금으로 줄을 세운다.
- **예약 키는 `(호출 ID, 시도 번호)`다.** 한 시도는 한 예약이다. `sending` 전에 끝난 시도를 다시 할 때만 같은 예약을 쓴다(보내지 않았으므로). `sending`이 기록된 시도를 다시 보내는 것은 언제나 새 시도 번호이고 새 예약이다. 새 예약도 세 단위의 남은 한도를 지나야 하므로, 앞 시도가 `uncertain`으로 잡고 있는 돈을 재시도가 다시 쓰지 못한다. 두 시도가 모두 과금되면 두 예약이 각각 정산된다. 자동 재전송은 이 규칙 안에서만 한다.
- **반환은 보내지 않은 것이 증명될 때만이다.** 지금 `release`도 "호출하지 않고" 돌려주는 경우만이다(`src/kb/extract/budget.py:165-166`). 예약은 `reserved → sending → settled | uncertain` 상태를 가진다.
  1. 연결을 열기 전에 `sending`을 장부에 내구 기록한다.
  2. `sending` 기록 전에 끝난 호출(예산 부족, 로컬 검증 실패, 연결 전 오류)만 `release`로 돌려준다.
  3. 응답이 있으면 응답의 사용량으로 `settle`한다.
  4. `sending` 뒤 응답 시간 초과, 연결 끊김, 프로세스 종료는 `uncertain`이다. 제공자가 요청을 받고 과금했을 수 있다. 예약 금액은 세 단위(주제·전체·엔진) 모두에 그대로 잡혀 있고 다른 호출이 그 돈을 쓰지 못한다.
  5. `uncertain`은 제공자의 사용량·비용 자료와 맞춰 정산한다(D5의 엔진 장부). 과금이 없다고 확인되면 반환하고, 과금이 확인되면 그 금액으로 정산한다. 7일 안에 맞추지 못하면 예약 금액으로 정산하고 반환하지 않는다 [설정값]. 제공자별로 호출 단위 대조가 되는지는 [미확인]이고 D5가 정한다. 호출 단위로 못 맞추는 제공자는 기간 합계로 맞추고, 남는 차이를 반환하지 않는다.
  6. 재시작 때 `sending` 상태로 남은 예약은 `uncertain`으로 본다. `reserved` 상태로 남은 예약만 보내지 않은 것이 증명되므로 반환한다.
- 결정적 수집은 돈이 들지 않는다. 결정적 경로의 양은 기존 일정과 예의 규칙(`A:791-805`)이 묶는다.
- **예산 장치가 없으면 막는다.** 주제 비용 귀속(TP5, `D4:1815`)과 엔진 장부(D5, `D4:1801`)가 배포되기 전에는 `research`가 409 `budget_unavailable`이다. 1판은 TP1만 기다렸고 그때 주제 상한은 존재하지 않았다(검토 B3).
- 연구 요청 하루 5회(3.5)는 홍수 방지이고 지출을 묶지 않는다.

### 6.5 결과 검토

loupe는 연구 결과를 사람에게 받기·버리기로 고르게 한다(`L 6.3`).

- **방향만 준 연구의 결과는 사람 검토를 거치지 않는다**(사용자 결정 2026-11-04). 주장의 `verification`은 인용 게이트가 지금처럼 자동으로 정한다(`A:508`, `A:943-966`). loupe의 받기·버리기는 이 결과를 바꾸지 않는다.
- `props.decision`으로 한 받기·버리기는 `editor` 범위의 first_party `Review` 기록이다(4.2). 서버가 `REVIEWS` 엣지로 대상에 잇는다. 이는 loupe의 화면 선택이며 KB 기본 읽기와 게이트를 직접 바꾸지 않는다. 아래 `verdict` 틀림 제보만 자동 재검증을 시작한다.
- 의도가 불명확해 시스템이 올린 HITL과 사용자가 시작하는 공개·해제 동작은 6.8의 별도 경로에서 사람 증명을 받는다. 일반 연구 결과의 `Review`는 이 경로가 아니다.

```http
POST /v1/records
Authorization: Bearer kbt_e_<토큰>

{"idempotency_key":"loupe:c:3e9a1c70-5d2b-4f8e-a1b6-9c0d7e2f4a58","change":"save",
 "record":{"type":"Review","title":"검토: c-8k2p4q7m1xab","body":"",
           "props":{"target":"c-8k2p4q7m1xab","decision":"accept","topic":"e:topic:youtube-shorts"}}}
```

**틀린 주장 제보(Q9).** `POST /v1/records`에서 `editor`가 `type:Review`, `props:{target:<주장 ID>,verdict:"reject",note:<이유>,source_url:<선택 URL>}`를 보낸다. `note`는 비어 있지 않은 500자 이하 글이다. `source_url`은 선택이며 공개 출처의 절대 HTTP(S) URL 하나만 받는다. 최상위 `record.source_url`과 인용·주장 직접 제출 금지는 그대로다. 이 URL은 검증할 출처 후보일 뿐 증거나 사실로 자동 승격하지 않는다.

- 서버는 쓰기 잠금 안에서 대상 주장의 현재 가시성을 확인하고, first_party `Review`와 `REVIEWS` 엣지, 그 리뷰 ID·판에 묶인 재검증 티켓을 함께 쓴다. 같은 키 재생은 티켓을 더 열지 않는다. 티켓은 `kb_request`와 같은 요청 함수/URL 검증을 쓰지만 에디터에게 범용 티켓 생성 권한을 주지는 않는다. URL을 가져오는 경로는 기존 수집 정책·robots·거부 호스트·비밀 탐지를 지난다(FW6).
- 제보 자체는 주장 문장·인용·`verification`·가시성·생존 상태를 바꾸거나 숨기지 않는다. 게이트가 기존 근거와 새 출처 후보를 자동으로 재확인한 뒤 정상 규칙으로 결과를 반영한다. 6.8의 의도 미해결 신호가 남을 때만 HITL이 된다. 일반 틀림 제보는 사람 확인 대기열에 올리지 않는다.
- 리뷰의 `note`와 선택 URL을 보존하고 `GET /v1/nodes/{id}/reviews?cursor=`의 `data.items`에 `{id,version,verdict 또는 decision,note,source_url}`로 낸다. 일반 읽기 범위와 3.6을 적용하므로 `private` 리뷰는 `editor`·`reviewer`만 보고 목록·총수에서도 숨긴다. 기본 `private`를 티켓·제보 메타데이터도 상속하고, 메모·사유를 외부 LLM으로 보내지 않는다. 이 조회가 loupe의 주장별 검토 목록이다(FW6).

### 6.6 외부로 나가는 것

| 대상 | `export_llm=false`(기본) | `export_llm=true` |
|---|---|---|
| 외부 LLM 프롬프트(발견, 관계 분류, 산문 과제) | 아무것도 싣지 않는다. 주제의 분류, 중복, 관계 후보는 로컬 모델로 한다(`D4:466-507`) | `title`, `aliases`, `exclude`, `domain`. 비밀 탐지를 다시 거친다 |
| `TopicSpec.body`(범위 서술) | 로컬만 | 로컬만. first_party 본문은 로컬 sLLM에만 간다(`A:766`) |
| 수집 프로필 `kb_ticket_list` | 이 주제의 실행 티켓을 내지 않는다. 수집 에이전트는 외부 LLM이다(`src/kb/serve/mcp_collect.py:130-139`) | 낸다. 티켓 `topic`은 `e:topic:<slug>`, `reason`은 고정 문구다 |

| 대상 | `export_query=true`(`internal`·`public` 기본) | `export_query=false`(`private` 고정) |
|---|---|---|
| 공개 출처 검색어(Wikidata 검색, 피드·사이트맵 발견, `D4:207-246`) | `title`, `aliases`를 검색어로 보낸다. LLM이 아니라 공개 API 질의다 | 보내지 않는다. 기존 레지스트리와 앵커만으로 발견한다 |

- 내보내기 허가는 spec의 필드이고 그 판에 기록된다. 이 값도 `editor` 토큰을 쥔 쪽이 정하므로 "사람이 허가했다"의 증명이 아니라 기록이다. 1판은 범위 서술 외의 짧은 필드를 늘 외부 LLM에 보냈다. ADR-0004 T.1의 같은 규칙(`D4:205`)도 고친다(12장 질문 2).
- **MCP 세션은 `internal`을 읽는다.** 일반 세션의 `kb-mcp`는 `internal` first_party를 읽고 그 내용은 Claude에 닿는다. 사용자가 2026-11-01에 확정한 규칙이다(`docs/adr/0002-user-decisions.md:56`, `:65-67`). loupe의 새 기록은 모두 기본 `private`이므로 Claude Code 세션이 찾지 못한다. 명시적으로 `internal`로 만든 기록과 사람 확인을 거쳐 공개된 결과만 `kb_search`로 찾을 수 있다. `export_llm`은 KB가 스스로 부르는 외부 LLM에만 적용되고, 사용자가 연 세션의 읽기는 막지 않는다.
- **`Topic` 엔티티와 slug.** 6.1이 만드는 `e:topic:<slug>`는 `origin=first_party`이고 spec과 같은 민감도다. slug는 ID 안에 들어가지만 사람이 고른 글이므로 `title`과 같은 내보내는 글로 본다. `export_llm=false`면 slug도 `e:topic:<slug>`도 외부 LLM 프롬프트와 수집 프로필(`kb_ticket_list`, 수집 프로필의 검색·조회)에 싣지 않는다. `export_query=false`면 검색어로도 쓰지 않는다. slug는 식별자이므로 비밀이 있으면 거절이다(7.2).
- **`export_llm=true`일 때 수집기가 보는 것.** 수집 프로필은 지금 first_party를 내지 않으므로, 허가를 켜도 `Topic`이 보이지 않는다. 그래서 허가된 주제만 좁게 연다. spec의 현재 판이 `export_llm=true`이고 3.4를 통과하는 `Topic` 엔티티는 수집 프로필에서 다음 칸만 보인다: ID `e:topic:<slug>`, 라벨(spec `title`), `aliases`, `exclude`, `domain`, 상태(`active`, `paused`). 통로는 `kb_ticket_list`의 그 주제 실행 티켓(`topic`, 고정 `reason`)과 수집 프로필의 그 엔티티 조회다. spec의 ID, 본문, 그 밖의 속성, 작성자, 링크, 그리고 다른 first_party 기록은 보이지 않는다. 모든 칸은 내보내기 직전에 비밀 탐지를 다시 거친다. 허가를 끄거나 spec이 tombstone·격리되면 다음 읽기부터 숨는다.
- **비공개 주제 연구(Q10).** `private` 주제는 등록된 소스·기존 스냅샷·앵커만 대조하고 로컬에서 처리한다. 등록 소스의 정해진 수집 경로를 지키며 주제의 제목·slug·별칭·범위를 질의로 외부에 보내지 않는다. 새 소스 발견 검색과 외부 LLM 호출은 하지 않는다. 결과가 적어도 공개 범위를 자동으로 낮추거나 `export_*`를 켜지 않는다. 6.3의 `discovery:"narrowed"`와 이유를 항상 낸다. 넓은 발견은 별도 `declassify` 사람 확인 뒤의 후속 연구다. `publish`의 외부 정제 동의는 이 연구에 전용하지 않는다(FW6).
- **KMS.** KB는 비밀 값을 받지 않는다. KMS 참조 문자열(이름)은 글로 저장하고 풀지 않는다. 그 문자열도 비밀 탐지를 지난다.

### 6.7 양 상한 [설정값]

| 대상 | 상한 |
|---|---|
| 열린 연구 실행이 있는 주제 수 | 20 |
| 연구 요청 | 하루 5회(3.5) |
| 시드어 | 20개, 각 100자 |

### 6.8 의도가 불명확할 때의 HITL과 사용자 동작

**범위(사용자 확정 2026-11-04).** HITL 목록 질문에 대한 사용자 답: "의도가 명확하지 않다고 판단할때가 맞을 듯." 시스템은 기존 자동 해석·판정으로 사용자의 의도를 스스로 해소하지 못할 때만 HITL 항목을 만든다. 아래는 기존 장치가 내는 구체적인 **미해결 신호**와 처리 규칙이며, 작업 종류만으로 사람 검토를 요구하는 고정 목록이 아니다.

| 미해결 신호(`kind`) | HITL을 올리는 조건 | 사람 해결과 영향 |
|---|---|---|
| `topic_ambiguity` | 주제 intake에서 동음이의어 등으로 엔티티/Wikidata 후보가 여러 개이고, `TopicSpec`의 본문·별칭·범위에 후보를 가를 단서가 없어 자동 해석이 끝나지 않음 | `select`(후보 ID), `clarify`(범위 보충), `reject`. 선택/보충을 주제 정의와 intake에 반영한다. 다른 세션이 제안했다는 이유만으로 올리지 않는다 |
| `source_policy` | 후보 소스가 ADR-0004 T.3의 자동 등록 기준(기존 호스트, 약관 `allowed`/`no_clause`, robots 허용, 피드·사이트맵·API·JSON-LD)을 벗어나 자동으로 등록 의도를 확정할 수 없음 | `approve`, `reject`. `source.approved` 또는 거절 기록을 기존 `kb topic approve` 함수로 쓴다. 약관·robots의 명시적 금지를 우회하지 않는다 |
| `liveness_unresolved` | H01~H11 근거가 충돌하거나 부족해 자동 생존 판정이 결론에 이르지 못함(`R_LIVENESS_UNKNOWN` 포함) | `confirm`(근거의 제안 상태), `reject`, `defer`. `survival.verdict`와 관련 보류를 갱신한다. 결론에 이른 근거 묶음은 자동 처리하며 `dead`·`superseded`·`removed`라는 상태만으로 HITL을 올리지 않는다 |
| `gate_unresolved` | `R_VALUE_MISMATCH`·`R_ALIAS_MISMATCH`·`R_SUBJECT_CONTEXT` 보류를 함의 판정(`A:963`)도 `supported`로 해소하지 못함 | `accept`, `reject`. 문장·인용·출처·`verification`은 불변이고 `review_state: user_accepted \| user_rejected`만 쓴다. 받은 주장은 `verification=needs_review, review=user_accepted`로 보인다. 선택 동작이며 수집 전체를 멈추지 않는다 |

- 시스템은 항목에 해소를 시도한 기제, 미해결 이유, 후보와 근거를 남긴다. 자동으로 해소되면 항목을 닫는다. 같은 신호·대상·판의 항목은 중복 생성하지 않는다.
- **나머지는 자동이다.** 방향만 준 주제 연구의 모든 결과, T.3 안의 소스 등록, 명확한 주제 intake, 결론에 이른 생존 근거, 함의 판정이 해소한 보류는 HITL을 거치지 않는다. 인용 게이트·first_party 게이트·예산·비밀 규칙은 그대로 적용한다.

**사용자가 시작하는 동작.** `release`(secret/격리 오탐 해제), `declassify`(`private` → `internal`·`public`, `internal` → `public`), `publish`(5.10의 메모 정제·반영)는 시스템이 올리는 HITL 항목이 아니다. 사용자가 원할 때 `POST /v1/actions`로 `{action, target, expected_version, idempotency_key}`를 준비한다. `declassify`는 목표 `sensitivity`도 받는다. `release`는 기존 해제 함수와 이전 민감도를 쓰며 내용은 응답에 싣지 않는다. 비밀/격리 대상에 대한 이 예외는 `release` 준비·실행만이고 다른 쓰기의 404 규칙은 유지한다. 두 종류 모두 아래 사람 증명 없이는 실행할 수 없다. `publish`의 로컬 준비는 reviewer 토큰만으로 가능하지만, 외부 전송과 결과 공개는 5.10의 서로 다른 두 WebAuthn 증명을 각각 먼저 검증해야 한다. `kb redact`(물리 삭제)는 TTY에만 남긴다.

**사람이 했다는 증명(B1).** 작성자·`change`·TTY·토큰 소지만으로 사람을 증명하지 않는다. HITL 해결과 사용자 동작 실행은 모두 `reviewer` 범위에 더해 **동작마다 WebAuthn 사용자 확인(user verification)**과 보호된 reviewer 신뢰 저장소를 요구한다. 기존 TTY `kb review`, `kb topic approve`, `kb secret release`도 해당 사람 결정의 수동 실행은 같은 증명을 거치며, TTY만으로 우회하지 않는다. 자동 판정 경로는 위 미해결 신호 규칙을 따른다.

1. **신뢰 저장소.** 현재 배치에서는 사용자가 `sudo`로 설치한 `/etc/sagae-kb/reviewers`만 신뢰한다(파일 `root:root`, 0644; 디렉터리 `/etc/sagae-kb`와 상위 경로도 root 소유, 비특권 쓰기 금지). 신뢰 저장소는 `rp_entries:[{rp_id,allowed_origins}]` 목록과 각 자격 증명의 공개 키·자격 증명 ID·`rp_id`를 갖는다. **현재 RP ID는 `localhost`, 허용 origin은 `http://localhost:4812`로 등록한다.** loupe는 이 origin으로 사람 확인을 열며 IP 리터럴 origin으로 리디렉션하지 않는다. 이 선택은 loupe의 브라우저 검토 실측에 따른 계약이다. 포트는 origin에만 들어가고 RP ID에는 들어가지 않는다. 추후 모바일 HTTPS용 두 번째 RP ID·origin 추가도 등록과 같은 `sudo` 특권 단계다. 자격 증명은 RP ID 하나에 묶이므로 RP ID를 추가하면 그 RP ID용 인증기를 다시 등록해야 하며 기존 키를 복사해 쓰지 않는다. KB 서비스 UID와 PC 에이전트 UID는 파일과 디렉터리를 쓸 수 없어야 한다. 홈 디렉터리의 0600 파일은 같은 UID의 키 교체를 막지 못하므로 신뢰 근거로 쓰지 않는다. 심볼릭 링크·그룹 권한·ACL을 통한 교체도 허용하지 않는다.
2. **등록과 폐기.** `POST /v1/reviewer/enroll`은 브라우저 `navigator.credentials.create`의 등록 후보만 만든다. 사용자가 후보 자격 증명과 RP ID·origin을 확인하고 `sudo kb reviewer enroll --request <등록 ID>`로 설치해야 신뢰된다. 폐기도 `sudo kb reviewer revoke --credential <ID>`로 root 소유 파일을 원자적으로 갱신하는 별도 특권 단계다. HTTP·KB 프로세스·일반 TTY 명령은 이 파일을 변경하거나 새 키를 활성화할 수 없다. 인증기 비밀 키는 인증기를 떠나지 않는다. 서명 카운터와 1회용 도전 상태는 별도 운영 상태에 두며 신뢰 키 등록 근거로 쓰지 않는다.
3. **안전 확인과 이전.** KB는 시작 시와 사용자 동작 준비·도전 발급·실행마다 소유권과 파일/디렉터리의 실제 쓰기 가능 여부를 확인한다. 파일 누락·읽기 실패·KB UID 또는 에이전트 UID의 쓰기 가능·검사 중 경로 교체를 발견하면 HITL 해결과 사용자 동작을 모두 503 `review_trust_unavailable`로 거절하고 아무 변경도 하지 않는다. 상태 보고는 8.1의 단일 `/v1/meta.write.hitl` 모양을 따른다. 경로·키·자격 증명 ID는 싣지 않는다. ADR-0004 P의 KB writer 전용 VM 이전 뒤에는 그 VM 안에 저장하고 PC 에이전트는 쓰기 접근을 갖지 않는다. 등록·폐기의 특권 단계는 이전 뒤에도 유지한다.
4. **도전과 확인.** HITL은 `POST /v1/hitl/challenge {item, action, params}`, 사용자 동작은 `POST /v1/actions/challenge {action_id,action}`다. **두 challenge 경로 모두 loupe serve만 쥔 reviewer 토큰을 요구한다.** 쿠키·origin·브라우저의 WebAuthn 요청만으로 challenge를 발급하지 않는다. `publish_external_refine`은 5.10의 메모 ID·판·정확한 전송 해시에, `publish`는 확정 결과 해시에 묶이며 서로 대체할 수 없다. KB는 `action_sha = sha256(정규화한 종류, 대상 ID와 현재 판/상태, 동작, 매개변수, 외부 전송이면 external_payload_sha, 결과 공개면 준비된 결과별 해시·타입·민감도)`에 묶인 1회용 도전을 발급하고 120초 뒤 버린다. 브라우저는 `navigator.credentials.get`(`userVerification:"required"`)으로 서명하고 loupe는 대상·동작·공개 결과를 확인 화면에 보인다.
5. **실행.** HITL은 `POST /v1/hitl/{item}/resolve {action, params, challenge_id, assertion, idempotency_key}`, 사용자 동작은 `POST /v1/actions/{id}/execute {challenge_id, assertion, idempotency_key}`다. KB는 보호된 저장소의 현재 공개 키로 서명·UV 플래그·서명 카운터 증가·도전·`action_sha`를 확인한다. 인증기 응답의 RP ID 해시는 그 자격 증명에 등록한 `rp_id`와 같아야 하고 origin은 그 RP 항목의 `allowed_origins`와 정확히 일치해야 한다. 목록에 없는 RP/origin, 서로 다른 RP의 자격 증명·도전 조합은 거절한다. 하나라도 틀리면 403 `review_unverified`이고 아무것도 쓰지 않는다. 대상 판·상태나 준비 결과가 바뀌면 409 `review_stale`다. 확인과 도전 소비, 대상 확인, 사건 기록은 쓰기 잠금 안에서 원자적으로 한다. 같은 증명으로 다른 동작이나 바뀐 결과를 승인하지 못한다.
6. **기록과 재생.** 성공은 항목별 상태 이벤트 또는 사용자 동작 결과를 한 커밋에 쓴다. `actor=user:sagae`, `generated_by=app:<라벨>:hitl` 또는 `app:<라벨>:action`이고 payload에 `{item 또는 action_id, action, prior_state, action_sha, cred_id, assertion_sha, 결과 해시}`를 남긴다. 외부 전송 동의도 별도 `publish_external_refine` 사건으로 증명·메모 판·전송 해시를 남기고 결과 공개 사건과 구별한다. 이것이 HTTP에서 `actor=user:sagae`가 되는 예외다(3.2). 멱등 이름공간은 인증된 앱의 `app:<라벨>`(5.1)이며 이벤트의 `user:sagae` 귀속으로 합치지 않는다. 같은 키의 재시도는 첫 결과만 돌려준다. 재생 전에는 현재 신뢰 저장소와 대상 가시성을 다시 확인하며 새 도전 없이 새 변경을 만들지 않는다.

- **남는 위험.** 이 설계는 같은 UID가 reviewer 키를 바꿔 UV를 꾸민 서명을 넣는 우회를 막는다. 다만 현재 KB 코드·원장·운영 상태를 같은 UID가 직접 바꾸거나, root 권한을 얻거나, 확인 화면을 속여 사용자가 다른 동작을 승인하게 하는 공격까지 막지는 못한다. WebAuthn은 인증기 사용자 확인을 증명하고 화면의 의미를 보증하지 않는다. writer 전용 VM은 PC 에이전트의 직접 변경 범위를 줄이지만 신뢰 저장소의 특권 관리자와 사용자 확인은 계속 신뢰해야 한다.
- **localhost 출처 탈취의 수용 위험.** loupe가 멈춘 동안 다른 로컬 프로세스가 같은 포트를 열어 같은 origin의 스크립트를 제공하면 IndexedDB 초안을 읽고 WebAuthn 확인 창을 띄울 수 있다. 다만 HITL/사용자 동작/외부 전송 동의의 유효한 KB challenge는 loupe serve만 보관하는 reviewer 토큰이 있어야 발급된다. 토큰을 훔치지 않은 외부 페이지는 유효한 challenge를 얻어 KB에 동작을 승인시킬 수 없으며, 임의 WebAuthn 창 자체는 KB 승인 증거가 아니다. 같은 UID가 토큰을 훔치는 경우는 위 보장 밖이다. IndexedDB 초안도 브라우저 프로필의 디스크 파일을 같은 UID가 읽을 수 있으므로 로컬 동료 프로세스에 대한 비밀 저장소로 보장하지 않는다. 이 로컬 머신의 잔여 위험을 수용한다.
- **loupe 쪽 완화 권고.** 다른 프로세스가 포트를 점유하면 시작을 거부하고, 초안을 보이기 전에 KB가 발급한 serve identity를 신뢰된 loupe 경로에서 검증하도록 권고한다. 이는 loupe가 구현할 권고이며 이미 있는 보안 기능으로 간주하지 않는다. 악성 동일 origin 스크립트가 검사를 생략하거나 같은 UID가 디스크를 직접 읽는 공격까지 막지는 못한다. 뒤에 HTTPS RP ID로 옮기면 포트 점유만으로 인증서·서버 신원을 흉내 내는 범위가 줄지만 같은 UID의 프로필·토큰 접근까지 해결하지는 않는다.
- **목록 읽기.** `GET /v1/hitl?kind=<미해결 신호>&cursor=`는 `reviewer` 범위다. 항목 ID, 신호, 대상 ID, 미해결 이유, 후보·근거 링크, 제안 상태, 만든 시각을 낸다. 사용자 동작은 이 목록에 올리지 않는다. 사용자 동작 준비의 후보는 그 `reviewer`에만 보이며, 격리 해제는 ID·타입·규칙 ID·시각만 내고 내용을 내지 않는다. 다른 대상에도 3.6의 가시성을 적용한다.
- **라이브러리.** 서버 WebAuthn 검증은 직접 만들지 않고 유지보수 중인 라이브러리(후보 `py_webauthn`)를 쓴다. 버전·라이선스·의존성은 FW9에서 1차 출처로 확인한다 [미확인]. 인증기가 없거나 신뢰 저장소가 안전하지 않으면 사람 동작을 열지 않고 `/v1/meta`에 이유를 낸다. TTY를 인증 대체 수단으로 쓰지 않는다.

### 6.9 연구 호출 상한과 주입 방어의 근거(Q8)

아래 ADR-0004 줄은 2026-11-04 검토 때 읽은 판 기준이다. 절 이름과 코드·시험 위치도 함께 적어 줄이 밀려도 근거를 찾게 한다.

- **K-c의 기존 경계.** ADR-0004 **10장 L1295~1301**은 호출마다 예산 예약, 정의의 `maxTurns`, 작업별 과제 수·실행 시간 40분, 엔진별 일·월 상한을 정한다. **9장 L1258**은 `kb_ingest_validate` 검증 반복 3회 규칙이다. `tests/agentrun/test_tools_scope.py:10-47`은 도구 집합과 정의의 `maxTurns`를 검사한다. 이 근거는 실행 전체의 실제 LLM/도구 호출 수를 엔진·재시도에 걸쳐 합산하는 하드 상한의 구현·시험 증명은 아니다.
- **K-c 미결 항목과 담당.** 소유자는 **FW6와 ADR-0004 E1/D5**다. 연구 실행별 호출 수 상한의 단위·기본값·재시도/엔진 전환 합산·동시 예약·초과 시 중단을 정하고 서버가 강제해야 한다. 현재 해당 전용 시험은 없으므로 FW6의 계획 시험 `tests/fpapi/test_research_call_cap.py`로 확인하고 FW7에 근거를 제출한다. 수치나 시험 통과를 이 문서에서 만들어 내지 않는다. 완료 전 해당 유료 에이전트 연구 경로는 409 `budget_unavailable`로 닫으며, 기존 결정적/로컬 경로도 자기 예산·양 상한을 그대로 지킨다.
- **K-d의 기존 방어.** ADR-0004 **6.2 L847~856**의 도구 허용 목록과 수집 경로, **6.3 L861~866**의 비신뢰 입력 규칙·인용 게이트를 적용한다. 도구 결과·웹 원문·티켓 내용은 지시가 아니라 데이터다. 인용 게이트 `src/kb/gate/quote.py:37-39`는 문장·인용의 주입 패턴을 검사해 **`E_INJECTION`으로 거절·격리**한다. `tests/gate/test_quote.py:67-79`, `tests/ingest/test_claims.py:89-98`, `tests/extract/test_injection.py`가 기존 시험 근거다. 이는 알려진 패턴에 대한 방어이며 모든 주입이나 추가 호출 유도를 막는다는 보증은 아니다. 루프 폭주는 위 K-c 상한도 함께 요구한다. 이번 문서 수정에서는 시험을 실행하지 않았다.

## 7. 비밀 탐지, 오류, 경고

### 7.1 거절인가 격리인가

| 기준 | 거절 | 격리(지금) |
|---|---|---|
| 원장 | 저장 전에 끝난다. 비밀이 원장, CAS, `spool/in`, `spool/fp-held`, 멱등 키 열 어디에도 남지 않는다 | 비밀 판이 덧붙이기 전용 원장에 영구히 남는다(`A:357`). 지우려면 TTY `kb redact`이고(`A:585`), 봉인 세그먼트 재봉인과 restic `rewrite`·`prune`까지 간다(`A:587-596`) |
| 사본 | 없다 | 원장 사본이 C:, E:로 간다(`A:1271`) |
| 사람 | 편집기 앞에 사람이 있다고 가정할 수 있고 바로 고친다 | 기록이 화면에서 사라진다(`L 5.5`) |
| 잃는 것 | 없다. 내용은 편집기와 loupe 초안에 남는다 | 없다 |

이 표는 내용 칸(제목, 본문, 속성 값)의 선택이다. 식별자 칸(멱등 키, ID, 타입, 속성 이름, tombstone 사유)은 선택이 없다. 모든 통로에서 거절이고 값을 되풀이하지 않는다. 그 칸은 원장 열과 투영 키에 그대로 남아 격리해도 숨지 않는다. 같은 규칙을 다른 워커가 ADR-0001 7.9에 적고 있다.

**결정.** 내용 칸은 HTTP 편집기 경로에서 기본 거절이다. 원장이 덧붙이기 전용이므로 거절된 쓰기만 원장에 닿지 않고, 격리는 지우는 비용을 나중으로 미룰 뿐이다. 다른 통로(MCP `kb_put`, inbox, `kb put`, `kb intake`)는 내용 칸에 격리를 유지한다. 그 통로는 사람이 그 자리에 없을 수 있고 거절하면 내용을 잃는다(`A:575`). ADR-0001 7.9(`A:575`)에 HTTP 예외를 더하는 변경이라 사용자 승인이 필요하다(12장 질문 6).

**오탐.** 사용자가 "비밀이 아니다"를 고르면 loupe는 `on_secret: "quarantine"`으로 다시 보낸다. 지금 규칙대로 격리 저장되고, 해제는 6.8의 사용자 동작 `release` 또는 같은 사람 증명을 거치는 TTY `kb secret release <id>`다(`A:575`). 이 선택은 `change=save`만 받는다. 이것은 실수 방지 규칙이고 허가가 아니다.

### 7.2 무엇을 언제 검사하나

- **검사 대상과 처리**(편집기 경로): 서버가 덧붙이는 값(`PROMOTED_FROM` 대상, 티켓 고정 문구)은 검사할 필요가 없다.

| 칸 | 비밀이면 | `on_secret=quarantine`일 때 |
|---|---|---|
| 멱등 키, `record.id`, `record.type`, `props`의 이름, tombstone `reason`, `TopicSpec.props.slug`, 연구 요청·멈춤의 문자열 필드 | 422 `secret_detected`, 저장 없음, 값 없음 | 같다. 격리하지 않는다 |
| `title`, `body`, `props`의 값, `links` | 422 `secret_detected`, 저장 없음 | 격리 저장(`sensitivity=secret`, 7.4) |

- **다이제스트 칸 규칙(지금 코드).** 식별자 검사(`scan_key`, `src/kb/write/secrets_scan.py:257-269`)는 `:`로 나눈 칸 가운데 16~128자 소문자 16진수뿐인 칸을 다이제스트로 보고 뺀다. 바로 앞 칸 이름의 **마지막 낱말**이 비밀값의 이름(`key`, `token`, `secret`, `password`, `pass`, `pwd`, `auth`, `credential`, `cred`, `pat`, `access`, `bearer`, `api` 등, `:232-243`)이면 빼지 않는다. `api-token-rotation`은 마지막 낱말이 `rotation`이라 다이제스트이고, `github_token:<hex>`는 검사한다.
  - **작성기가 붙인 꼬리.** KB 작성기(intake, harvest, inbox)가 키의 마지막 칸을 내용 해시로 직접 붙였으면 그 칸은 앞 칸 이름과 상관없이 늘 뺀다(`digest_tail=True`, `:263`, `src/kb/write/record.py:39-47`, 지금 호출은 `src/kb/write/inbox.py:187`). 그래서 `inbox:api-token-rotation:<sha32>` 같은 서버 키는 거절되지 않는다.
  - **호출자가 고른 키.** MCP `kb_put`과 HTTP 편집기 경로의 키는 꼬리 예외 없이 위의 칸 규칙만 받는다. 앞 칸 이름이 평범한 16진수 칸은 다이제스트로 빠진다.
  - **알려진 놓침.** 평범한 이름 칸 뒤의 16진수만의 비밀은 잡지 못한다. 예: `api_key:v1:<hex>`는 바로 앞 칸이 `v1`이라 그 16진수를 뺀다. 접두어가 있는 비밀(`ghp_`, `sk-ant-`, `AKIA` 등)은 16진수만의 칸이 아니라 늘 검사한다(`:264-265`).
  - loupe 키는 이 놓침에 기대지 않도록 다이제스트 칸을 쓰지 않는다(5.1 편집 키의 `r<n>`).
- **속성 이름.** 지금 코드는 `props`의 모든 이름(중첩 포함)을 식별자로 검사해 거절한다(`src/kb/write/record.py:50-58`, `:143-144`). 키, ID, 타입, 사유도 같다(`:141-142`, `:187`, `:246-248`).
- **검사 시점**: 큰 본문 CAS, 스풀, 보류, 원장, 멱등 재생 조회보다 앞이다(2.3). 키 안의 비밀이 재생 조회나 `event.idem_key` 열에 닿지 않게 하기 위해서다.
- **경로 힌트 거절**: `props`의 `source_path`와 경로 힌트 키(4.2)는 400이다. 편집기 경로의 탐지는 경로를 받지 않는다(`source_path=None`). 지금 `scan_record`는 경로 허용 목록을 쓰지 않고 `props.source_path`를 읽지 않는다(`src/kb/write/secrets_scan.py:270-277`). 편집기 경로의 400은 그 수정에 기대지 않는 두 번째 막이다.
- **진단은 입력을 되풀이하지 않는다**: 편집기 경로의 모든 오류 `detail`은 고정 문구다. 지금 일부 거부 메시지는 입력값을 싣는다(`src/kb/write/record.py:92`, `:95`, `:98`, `:101`, `src/kb/write/author.py:36`). 편집기 경로는 코드별 고정 문구로 바꿔 답한다. 처리 중 예외의 문자열도 찍지 않는다(`src/kb/serve/http.py:654-655`). 경로와 코드, 예외 종류만 남긴다. 경고 `link_not_id`, `link_dangling`은 값 대신 본문 안 순번만 준다.
- **위치 표기**: `hits`의 필드는 이름이 아니라 순번이다. 속성 이름 자체가 비밀일 수 있기 때문이다(`iter_strings`는 이름을 경로에 넣는다, `src/kb/write/secrets_scan.py:211-221`). 구간은 코드포인트(`start`, `end`, 계약의 단위 `C:1157`)와 UTF-16(`start_u16`, `end_u16`, loupe의 JS 문자열 단위)을 함께 준다.

### 7.3 비밀 거절 예

```http
POST /v1/records
Authorization: Bearer kbt_e_<토큰>

{"idempotency_key":"loupe:c:9d2e7f10-0b6a-4c3e-8f51-7a4b2c9d0e13","change":"autosave",
 "record":{"type":"Note","title":"배포 메모","body":"내일 배포.\nOPENAI_API_KEY=<20자 이상 고엔트로피 값>\n","sensitivity":"internal"}}
```

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{"type":"https://kb.local/problems/secret-detected","title":"secret detected","status":422,
 "detail":"비밀로 보이는 값이 있어 저장하지 않았다","code":"secret_detected","instance":"/v1/records",
 "hits":[{"field":"record.body","rule":"kb-env-high-entropy","start":6,"end":67,"start_u16":6,"end_u16":67},
         {"field":"record.props[2].value","rule":"generic-api-key","start":0,"end":40,"start_u16":0,"end_u16":40}],
 "stored":false}
```

- 규칙 ID만 주고 값은 주지 않는다(`src/kb/write/secrets_scan.py:15`). FW3이 `scan_record`가 버리던 필드와 구간을 돌려주게 고친다(`src/kb/write/secrets_scan.py:224-239`).
- `stored:false`는 원장, CAS, 스풀, 보류 어디에도 쓰지 않았다는 뜻이다.

### 7.4 격리 저장 예(사용자가 오탐을 고른 경우)

```http
POST /v1/records
Authorization: Bearer kbt_e_<토큰>

{"idempotency_key":"loupe:c:9d2e7f10-0b6a-4c3e-8f51-7a4b2c9d0e13","change":"save","on_secret":"quarantine",
 "record":{"type":"Note","title":"배포 메모","body":"...(사용자가 오탐이라고 고른 같은 본문)...","sensitivity":"internal"}}
```

```http
HTTP/1.1 201 Created

{"id":"f-q8w2e4r6t8y0u2i4o6p8a0s2d4","version":1,"seq":190402,"replayed":false,"unchanged":false,"projected":true,
 "spooled":false,"held":false,"write_ref":null,"payload_sha":"c0d1…","quarantined":true,"sensitivity":"secret",
 "warnings":["secret_detected:kb-env-high-entropy"],"reason":null,
 "actor":"app:loupe","claimed_author":"user:sagae","generated_by":"app:loupe:save"}
```

- 키는 7.3의 거절된 요청과 같다. 거절은 아무것도 쓰지 않았으므로 같은 만들기 키를 다시 쓸 수 있고, 한 초안이 한 ID로 남는다(5.1).
- 이 ID는 읽기에서 404이고(`A:574`), 편집기 쓰기에서도 404다(3.4). 해제 전까지 loupe가 고치거나 지우지 못한다. 응답을 잃고 같은 요청을 다시 보내도 재생 대신 404다(5.1). loupe는 이 404를 "격리됐거나 없음"으로 보이고, 해제는 내용 없는 6.8의 사용자 동작 또는 같은 증명을 거치는 터미널 경로로 안내한다.
- 식별자 칸(멱등 키, ID, 타입, 속성 이름, 사유)에 비밀이 든 경우는 격리 저장을 받지 않는다. 그 값은 원장 열에 그대로 남기 때문이다. `on_secret=quarantine`이어도 422로 끝난다(7.2).

**loupe가 해야 할 것.**

1. 거절이면 "저장 거절: 비밀로 보이는 값"을 띄우고 `hits` 구간을 가린다. 값을 화면 밖(알림, 로그, 텔레메트리)으로 보내지 않는다. 초안 저장소와 편집기 이력에서 그 내용을 지운다(`L 5.5`).
2. 선택지: 값을 지우고 KMS에 옮긴 뒤 다시 저장, 오탐이면 격리 저장, 버리기.
3. 격리 저장 뒤에는 "이 기록은 이제 loupe에서 보이지 않습니다. 해제하려면 본인 확인이 필요합니다"를 알리고 ID와 판만 남긴다. 6.8의 `release` 또는 같은 사람 증명을 거치는 TTY `kb secret release <id>`로 안내한다.
4. 같은 내용을 다른 키로 다시 보내 거절을 피하려 하지 않는다.
5. 붙여넣기처럼 큰 덩어리는 저장 전에 `?dry_run=1`로 검사할 수 있다. 응답은 `{"would_reject":true,"hits":[…]}`이고 아무것도 쓰지 않는다.

### 7.5 오류

모든 `detail`은 고정 문구다(7.2).

| status | `code` | 언제 | loupe가 보일 말 [설정값] | loupe의 행동 |
|---|---|---|---|---|
| 400 | `bad_json` **새** | JSON이 아님 | 저장 요청이 깨졌습니다 | 버그로 기록 |
| 400 | `schema_invalid` | 필드 오류, `change` 없음, 외부 사실 필드, 경로 힌트 키 | 저장할 수 없는 값이 있습니다 | 해당 필드 표시 |
| 400 | `bad_param` | 허용 밖 쿼리 | 같음 | 버그로 기록 |
| 401 | `token_required`, `token_invalid` | 토큰 없음, 틀림, 만료, 폐기(`src/kb/serve/http.py:610-616`) | KB 쓰기 권한이 없습니다. 토큰을 다시 설정하세요 | 쓰기 중지, 초안 보존 |
| 403 | `scope_denied` **새** | `viewer` 토큰으로 쓰기 | 같음 | 같음 |
| 403 | `type_not_allowed` **새** | 새 기록의 타입이 네 타입 밖 | 이 종류는 편집기에서 만들 수 없습니다 | 버그로 기록 |
| 403 | `sensitivity_not_allowed` **새** | `secret` 요청 | 이 공개 범위는 쓸 수 없습니다 | 선택지에서 뺌 |
| 403 | `declassify_requires_review` **새** | `PUT`·승격이 민감도를 낮춤(3.6, 5.7) | 공개 범위를 낮추려면 검토 확인이 필요합니다 | 6.8 `declassify`로 안내 |
| 403 | `external_consent_required` **새** | private 외부 정제 요청에 전송 전 WebAuthn 동의 없음(5.10) | 외부 정제에 먼저 본인 확인이 필요합니다 | 로컬 결과 사용 또는 전송 내용 확인 뒤 동의 |
| 403 | `review_unverified` **새** | 외부 전송 동의·HITL 해결·사용자 동작의 WebAuthn 확인 실패(5.10, 6.8) | 본인 확인에 실패했습니다 | 다시 확인 |
| 404 | `not_found` | 없는 ID, 3.4 실패, 숨은 대상의 재생(5.1), 남의 쓰기 참조(5.9) | 문서를 찾을 수 없습니다 | 목록 새로고침 |
| 409 | `version_conflict` | 5.4, 같은 만들기 키에 다른 내용·귀속(5.1) | 다른 곳에서 먼저 고쳤습니다 | `payload_sha`가 같으면 확정, 다르면 비교 화면 |
| 409 | `idem_conflict` | 같은 키, 다른 내용이나 귀속 | 저장 충돌. 다시 저장합니다 | 새 키로 1회 재시도 |
| 409 | `redacted_payload` | 지운 본문과 같은 내용(`src/kb/write/engine.py:15-16`) | 삭제된 내용과 같아 저장할 수 없습니다 | 저장 중지 |
| 409 | `write_in_flight` **새** | `pending`·`held` 쓰기 참조의 `DELETE`, preparing 동작의 도전·실행(5.8, 5.10) | 아직 처리 중입니다 | 끝날 때까지 기다림 |
| 409 | `review_stale` **새** | HITL·사용자 동작의 대상 판/결과 변경 또는 준비 만료(5.10, 6.8) | 항목이 바뀌었습니다 | 목록 새로고침 |
| 409 | `research_running` **새** | 열린 실행이 있는 spec의 tombstone | 조사 중인 주제입니다. 먼저 멈추세요 | 주제 화면 |
| 409 | `budget_unavailable` **새** | 6.4 | KB가 아직 이 조사를 받을 수 없습니다 | 요청 단추 잠금, 상태 표시 |
| 409 | `slug_taken` **새** | 6.1 | 같은 이름의 주제가 있습니다 | 기존 주제로 이동 |
| 410 | `content_removed` | 소유자가 `purged` 쓰기 참조에 `include=body` 요청(5.9) | 보관한 초안 본문이 삭제됐습니다 | 로컬 초안이 있으면 사용 |
| 413 | `body_too_large` **새** | 4.5 | 문서가 너무 큽니다(1 MiB) | 나누기 제안 |
| 415 | `unsupported_media_type` **새** | JSON 아님 | 버그 | 버그로 기록 |
| 422 | `secret_detected` **새** | 7.3 | 저장 거절: 비밀로 보이는 값 | 7.4 |
| 428 | `expected_version_required` | 판 없이 편집 | 버그 | 판을 읽고 1회 재시도 |
| 429 | `too_many_requests`, `write_rate_limited` **새**, `byte_quota_exceeded` **새** | 3.5, 5.8(스풀 예약 포함) | 저장이 잠시 밀렸습니다 | `Retry-After` 뒤 재시도, 초안 보존 |
| 503 | `review_trust_unavailable` **새** | reviewer 신뢰 저장소가 없거나 안전하지 않음(6.8) | 본인 확인을 사용할 수 없습니다 | 사람 동작 잠금, `/v1/meta` 이유 표시 |
| 503 | `not_ready`, `gate_busy` **새**, `spool_full` **새** | 시작 중, 승격·연구 요청의 게이트 시간 초과, 스풀 상한(5.8) | KB가 바쁩니다 | `Retry-After` 뒤 재시도, 초안 보존 |

성공이지만 아직 안 읽히는 경우: 202 `held:true`, `reason:"offsite_path_missing"`(`src/kb/write/engine.py:38`), 202 `spooled:true`, `reason:"gate_timeout"`(`src/kb/write/engine.py:237`), 200/201 `projected:false`(`C:1409`). 앞의 둘은 `write_ref`가 있다(5.9).

### 7.6 경고

| 경고 | 뜻 | loupe |
|---|---|---|
| `secret_detected:<규칙 ID,…>` | 격리 저장(7.4)에서만 | 7.4 |
| `link_not_id:<순번>` | 모양이 맞지 않는 위키 링크(4.6) | 빨간 링크 |
| `link_dangling:<순번>` **새** | 모양은 맞는데 대상이 없음(4.6) | 빨간 링크 |

### 7.7 공개 비밀 규칙 계약(Q1)

FW1은 **`docs/contracts/first-party-secret-rules-v1.json`**에 `version`, 탐지 규칙 ID·패턴·플래그·키 다이제스트 예외, 코드포인트/UTF-16 구간 정의와 **합성 시험 벡터**를 공개한다. 실제 비밀·사용자 자료·설치 경로별 허용 목록은 싣지 않는다. 벡터는 식별자/내용 칸의 차이, 다이제스트 예외, 속성 이름, 한글·보조 평면 문자 구간, 허용/거절/격리 선택의 기대 결과를 담는다. 이 파일은 FW1의 배포 산출물이며 이 문서 수정에서 생성한 파일이 아니다.

- `/v1/meta.write.secret_rules`의 `version`은 규칙 집합 식별자(첫 판 `fp-secret-rules-v1`), `sha`는 그 파일을 UTF-8 정규 JSON으로 직렬화한 바이트의 SHA-256 소문자 64자리다. 실제 해시는 FW1이 계산하며 임의 값을 적지 않는다. 서버 배포 규칙과 계약 파일의 판·해시는 반드시 같아야 하고, 바뀌면 새 판을 낸다. 공개 artifact와 일치하지 않으면 FW1은 편집기 경로를 준비 완료로 광고하지 않는다(8.1).
- 브라우저 사전 검사는 **선택 사항인 안내**다. 서버와 다른 정규식 엔진을 쓰거나 규칙을 내려받지 못해도 서버 검사를 대신하거나 생략하지 않는다. 최종 권한·비밀 판정은 서버가 한다. 사전 검사의 경고만으로 오탐 해제·격리 해제를 승인하지 않는다.
- `POST /v1/records?dry_run=1`과 `PUT /v1/records/{id}?dry_run=1`은 계속 제공한다. 인증·대상 확인·형식·크기·비밀 검사를 하되 원장·CAS·스풀·보류·추출 큐·영속 캐시에 요청을 남기지 않는다. 로그·오류·추적에도 입력을 싣지 않고 메모리에서만 처리한다. 정상 검사는 200 `{would_reject,hits,secret_rules:{version,sha}}`이며 입력·본문·제목·속성 이름·비밀값을 되풀이하지 않는다. `hits`는 7.2의 순번·규칙 ID·구간만 준다. 전송 전에 멈추는 브라우저 검사와 달리 dry-run은 요청을 loupe serve와 KB 메모리에 전달한다(FW1/FW3).

## 8. 편집기용 읽기

추가 읽기는 연구 상태(6.3), 쓰기 참조(5.9), 사용자 동작 준비 상태(5.10), 주장별 리뷰(6.5)다. 나머지는 지금 계약(`C` 4장)으로 된다.

| 화면 | 요청 | 근거 |
|---|---|---|
| 문서·메모 목록 | `GET /v1/nodes?origin=first_party&types=Page,Note&sort=…&cursor=` | `src/kb/serve/http.py:87` |
| 주제 목록 | `GET /v1/nodes?types=TopicSpec` | 같음 |
| loupe가 쓴 것만 | `author=app:loupe` 필터 | `src/kb/serve/http.py:63` |
| 팔레트 검색, 링크 자동 완성 | `GET /v1/search?q=&kinds=record,entity&types=Page,Note,TopicSpec` | `C:1211`, `C:1099`, `src/kb/serve/http.py:63`, `:97` |
| 팔레트 접두어 일치 | `GET /v1/nodes?types=TopicSpec&filter=label:prefix:<q>` | `C:1070`, `src/kb/read/nodes.py:372-375`. `label`이 거를 수 있는 열인지 [미확인], FW1이 확정 |
| 열기 | `GET /v1/nodes/{id}?include=body,backlinks,edges` | `C:1155-1157` |
| 긴 본문 | `GET /v1/nodes/{id}/body?start=&max_chars=` | `C:1157` |
| 판 이력 | `GET /v1/nodes/{id}/history` | `C:1195-1197` |
| 옛 판, 시점 보기 | `…/body?as_of_observed=<RFC 3339>`, `/v1/nodes/{id}?as_of_observed=` | `C:227-233` |
| 주제 지도 이웃 | 주제마다 `GET /v1/nodes/{id}/neighbors` | `C:1180`, `src/kb/serve/http.py:93` |
| 다른 곳의 변경 감지 | `GET /v1/changes?origin=first_party&cursor=`를 30~60초마다 | `C:1285-1302` |
| 승격 관계 | `GET /v1/nodes/{id}/edges?direction=in&rtypes=PROMOTED_FROM` | `src/kb/serve/http.py:91` |
| 쓰기 가능 여부 | `GET /v1/meta`의 새 `write` 칸(FW1) | `src/kb/read/catalog.py:189-193` |

- 읽기 범위는 토큰이 없거나 `viewer`면 `internal` 이하이고, 인증된 `editor`·`reviewer`면 소켓·TCP 모두 `private` 이하다(3.3, 3.6). 이 범위는 기록 본문/get, 충돌 diff와 409 `current`, 이력/판 목록/옛 판, 변경 피드, 백링크·엣지·이웃, nodes 목록·검색 모두에 동일하게 적용한다. 각 읽기는 현재 원본 가시성도 다시 보며 `secret`·격리는 어느 토큰에도 내지 않는다(FW4/FW5).
- **휴지통 목록(Q11).** `GET /v1/nodes?origin=first_party&status=dead&types=Page,Note,TopicSpec,Review`는 `editor` 범위에서 tombstone된 기록을 돌려준다. 서버는 첫 생성 때 저장한 인증된 앱 `created_app`이 요청 앱의 `app:<라벨>`과 같은 기록으로 자동 제한한다. 사람 증명으로 `actor=user:sagae`가 된 생성도 그 요청 앱을 별도로 기록하므로 원래 앱의 휴지통에 들어간다. 토큰 회전 뒤 같은 앱 라벨은 이어받지만 다른 앱의 휴지통으로 넓히는 필터는 허용하지 않는다. 마지막 `record.put` 판의 3.4 민감도·격리·redact 확인을 통과한 대상만 내고, 페이지 수·총수에도 숨은 대상을 넣지 않는다. `status=dead` 필터를 이 경로에 쓸 권한이 없으면 403 `scope_denied`다. 일반 목록의 기본 tombstone 제외와 5.5의 복원 규칙은 유지한다(FW4/FW5).
- 쓴 직후 `projected:false`면 읽기가 한 tick 늦을 수 있다. loupe는 응답의 `version`을 믿고, 읽기에서 그 판이 보일 때까지 로컬 사본을 보인다.
- `internal` 기록은 사용자가 연 Claude Code 세션에서도 읽힌다(6.6).

### 8.1 쓰기 기능 상태의 단일 모양(Q13)

`GET /v1/meta`는 기존 읽기 봉투의 `data.write`에 아래 모양을 낸다. 이 절이 `write` 필드의 단일 정의이며 3.6·6.8·7.7·FW1/FW9는 이를 참조한다.

```json
{"fp_gate":true,
 "editor_routes":["POST /v1/records","PUT /v1/records/{id}"],
 "private_open":true,
 "hitl":{"available":true,"trust_store":"ready",
         "rp_ids":[{"rp_id":"localhost","allowed_origins":["http://localhost:4812"],"registered":true}]},
 "secret_rules":{"version":"fp-secret-rules-v1","sha":"<배포한 계약 파일의 SHA-256>"}}
```

- `fp_gate`는 원장 `meta.fp_open`의 불리언이다. `editor_routes`는 실제 켠 일반 편집기 경로를 `"METHOD /v1/..."` 문자열 배열로 내며 위 두 항목은 모양 예시다. 2.2 중 배포된 편집·연구·쓰기 참조·리뷰 조회를 열거하고 reviewer 전용 경로는 넣지 않는다. 미배포면 빈 배열이다.
- `private_open`은 FW2/FW4/FW5의 private 쓰기와 8장의 모든 읽기·파생물 민감도 검사가 함께 준비됐을 때만 `true`다. 준비 전에는 `false`이며 loupe는 새 기록 만들기를 막고, `internal`로 조용히 저장하지 않는다.
- `hitl.available`은 FW9 배포, 안전한 신뢰 저장소와 등록된 자격 증명이 모두 있을 때만 `true`다. `trust_store`는 `ready`, `missing`, `unreadable`, `unsafe` 중 하나다. 안전하지 않으면 `available:false`, `rp_ids:[]`이며 사람 동작은 503이다. `rp_ids`는 보호된 저장소의 `{rp_id,allowed_origins,registered}` 목록만 내고 키·파일 경로·자격 증명 ID는 내지 않는다. loupe는 자기 origin에 맞는 RP 항목의 `registered`도 확인한다. 미배포 FW9나 자격 증명 미등록도 `available:false`다.
- `secret_rules`는 7.7의 규칙 판·해시만 낸다. 계약 파일이 아직 배포되지 않았으면 `{version:null,sha:null}`이고 편집기 쓰기 경로를 광고하지 않는다. 예시의 해시 설명 문자열은 실제 응답 값이 아니며 배포 시 64자리 소문자 16진수여야 한다. 상태 조회는 비밀 입력이나 reviewer 키를 노출하지 않는다(FW1/FW9).

## 9. 작업 패키지

공통:

- 검증 명령은 저장소 래퍼 `ops/bin/dev pytest <대상>`이다(`ops/bin/dev:1-3`). `uv`를 직접 부르지 않는다. 계약과 `oasdiff`는 `ops/bin/contract-check`만 돌린다(`ops/bin/contract-check:1-7`).
- 시험 대상은 **새로 만드는 시험 파일과 함수 이름**으로 지정한다. 지금 있는 시험에 맞는 `-k` 필터(`history`, `types`, `socket_activation`, `big_body`)는 새 일 없이 통과하므로 쓰지 않는다.
- `tests/mcp/test_claude_real.py`는 실제 `claude -p`를 부르므로 패키지 명령에 넣지 않는다(`D4:1790`).
- 새 시험 디렉터리는 `tests/fpapi/`다. 임시 `KB_HOME`과 실제 Unix 소켓으로 돈다. `ops/bin/dev`는 운영 `KB_HOME`을 `KB_LIVE=1` 없이 거부한다(`ops/bin/dev:5-10`).
- 정확성이 핵심인 쓰기 게이트 코드는 구현 수준으로 만들고 리드 수준 검토와 FW7의 Codex 교차 검토를 붙인다(CLAUDE.md 지침 7 적용 기준).

| WP | 내용 | 인수 조건 | 검증 명령 |
|---|---|---|---|
| FW1 | 계약 0.4.0: OpenAPI에 2.2의 기본 편집·연구·쓰기 참조 경로(등록·HITL·사용자 동작은 FW9), 요청·응답 스키마, 7장 오류 코드, `editor` 범위, `change`, `on_secret`, `write_ref`. `/v1/meta.write`는 8.1의 단일 모양. `history.versions[]`에 `actor`, `claimed_author`, `generated_by`, `payload_sha`. 6장 "HTTP 쓰기 없음"(`C:1380`)과 7장 쓰기 메서드(`C:1453`) 개정. fixture 11종: 만들기, 편집, 충돌, 숨은 대상 404, tombstone, 승격, 비밀 거절, 격리 저장, 스풀 참조, 연구 요청, 연구 상태 7.7의 규칙 artifact·버전·실제 SHA-256·합성 벡터와 8.1의 단일 meta 스키마. | `oasdiff`가 읽기 경로에 파괴 변경 0. fixture 11종이 스키마 검증 통과. `filter=label:prefix:`가 동작하거나 대안이 계약에 적힘 공개 파일·서버 판/해시 일치, dry-run에서 원장·CAS·스풀·로그 입력 잔여 0, meta의 준비 전/후 모든 필드 스키마 검증. | `ops/bin/contract-check && ops/bin/dev pytest tests/fpapi/test_secret_rules_contract.py tests/fpapi/test_contract_fixtures.py -q` |
| FW2 | 타입: `schemas/types/Page.json`, `TopicSpec.json`, `Review.json`, `edge-PROMOTED_FROM.json`, `edge-DEFINES.json`, `edge-REVIEWS.json`. 티켓 상태 `cancelled` 4.2의 title_locked 불리언·타입별 추가 키 정책·선택 slug·Review verdict/source_url. | 네 타입이 정의 타입. `TopicSpec.props`, `Review.props` 위반과 경로 힌트 키가 `schema_invalid` Note/Page의 허용된 추가 키는 유지하고 TopicSpec/Review 미지 키는 400, title_locked 형식 오류 400, 생략 slug가 한국어 제목과 독립적으로 결정적. | `ops/bin/dev pytest tests/fpapi/test_fp_types.py -q` |
| FW3 | 쓰기 핵심: `author.resolve`의 `http` 전송과 귀속 표(3.2), 카드 표시의 `app:` 규칙, 대상 확인(3.4, 잠금 안), 처리 순서(2.3: 탐지와 대상 확인을 CAS 앞으로, 낡은 판 확인을 무연산 앞으로), 편집기 경로 비밀 탐지(7.2: 기록 전체와 메타데이터, 경로 힌트 거절, 순번 위치, UTF-16), `on_secret=quarantine`, 고정 오류 문구, `tombstone_record(expected_version, 대상 확인, 사유 탐지)`, 구조화 `VersionConflict.current`, `unchanged`, 크기 상한, 위키 링크 모양(4.6, 편집기 경로만), sLLM 큐 규칙(5.8), `dry_run` | 새 시험이 전부 통과: `change` 3종의 귀속, `actor`가 `user:sagae`가 되지 않음, `source_path` 거절, `props.source_path='x.png'`가 든 키를 거절, 키·사유·속성 이름의 비밀 거절 뒤 원장 `seq`·CAS·`spool/in`·`spool/fp-held` 변화 0, 오류 본문에 입력 문자열 없음, `Learning`·격리 대상 PUT·tombstone이 404이고 `current` 없음, first_party 네 타입의 `private`는 `editor`로 편집 가능, 낡은 판 + 같은 내용이 409, 복원 후 `status=active`, `[[Shorts]]`·`[[c-suite]]`가 엣지 없음, `TopicSpec` 판이 sLLM 큐에 없음, `Page` 자동 저장 판 여럿이 큐 참조 하나. 만들기 키에 `change`가 없고, 응답을 잃은 `autosave` 만들기 뒤 같은 초안의 `save` 만들기가 409 `version_conflict` + `current`이고 같은 초안의 기록이 하나뿐. 키·ID·타입·속성 이름·사유·slug의 비밀은 `on_secret=quarantine`이어도 422이고 응답에 값이 없음, `inbox:api-token-rotation:<sha32>` 꼴 작성기 키는 통과하고 HTTP 키는 통째로 검사, `…:r12` 편집 키는 통과. 격리된 기록을 CLI로 tombstone한 뒤 같은 키 만들기·낡은 `PUT`이 404이거나 `current`에 본문·제목·`payload_sha`가 없음. 키 K로 저장 뒤 `kb redact`, 민감도 상향, 격리 각각에서 K 재생이 404이고 본문에 `id`·`version`·`payload_sha`·`seq`가 없음. 토큰 A와 B(다른 라벨)가 같은 키 K로 만들면 서로 다른 기록 둘이 생기고 B의 응답이 A의 것과 구별되지 않음(충돌·재생 없음), 원장 `idem_key`가 `h\0<actor>\0K` 꼴, MCP `kb_put`과 inbox의 NUL 든 키가 400, 기존 통로의 전역 재생 시험이 그대로 통과, 만들기 ID가 원장 `meta` 없이 (actor, 키)로 재계산되고 내보낸 세그먼트로 다시 만든 원장에서 같은 키 재시도가 재생 | `ops/bin/dev pytest tests/fpapi/test_write_core.py tests/fpapi/test_secret_editor.py tests/fpapi/test_target_checks.py tests/fpapi/test_wikilink_shape.py tests/fpapi/test_replay_visibility.py tests/fpapi/test_idem_namespace.py -q && ops/bin/dev pytest tests/write -q` |
| FW4 | HTTP: 2.2 경로, 쓰기 경로의 Bearer 필수(소켓 포함), `editor` 범위, 토큰 만들기(TTY)·라벨 유일·만료·회전·폐기·마지막 사용, 요청 수 상한(3.5), 원장 기준 바이트 한도(5.8)와 색인, 쓰기 동시 2, `write_ref`, `GET`·`DELETE /v1/writes/{ref}`, 스풀 예약·`failed` purge(5.8), 본문과 예외 문자열을 남기지 않는 오류 처리. 무토큰 읽기 범위 유지, 인증된 소켓 읽기의 private 범위 적용 3.3의 분리 토큰과 인증된 소켓 읽기, 5.9의 실패 본문 회수, 8장의 앱별 휴지통. | 소켓에서 토큰 없는 `POST` 401, `viewer` 403, 만료·폐기 토큰 401. 같은 라벨 두 번째 만들기 거부. 바이트 한도가 `change=save`로도 걸리고 서버 재시작 뒤에도 유지. 재시도가 한도에 걸리지 않음. 두 탭 스풀 경우에 `write_ref`가 `failed`, `version_conflict`. 로그와 응답에 토큰 값·요청 본문 없음. 게이트를 쥔 채 스풀 경로로 한도를 넘게 보내면 넘는 요청이 429이고 `spool/in`에 파일이 늘지 않음, 스풀 상한에서 503 `spool_full`, 재적재·실패 뒤 예약이 합계에서 빠짐, 예약과 스풀 사이 종료를 흉내 낸 뒤 `lost_before_spool`. 낡은 판 1 MiB `PUT`을 게이트를 쥔 채 되풀이하면 하루 한도 429가 나지 않고 보유 상한에서 그 토큰의 오래된 `failed`부터 지워지며 디스크가 64 MiB를 넘지 않음, 지울 `failed`가 없을 때만 503 `spool_full`, 복구 순회와 스풀 쓰기를 동시에 돌려도 살아 있는 예약이 `lost_before_spool`이 되지 않음. 머리가 없는 새 기록의 참조가 소유자에게 `pending`·`failed`로 보임. 토큰 B가 추측한 만들기 키로 스풀한 참조가 A의 `private`·`secret` 기록 유무와 상관없이 같은 응답이고, 같은 ID에 숨은 머리와 보이는 머리가 있을 때 재적재가 둘 다 `create_conflict`. 같은 키라도 actor가 다르면 ID가 다름 다른 `tok_id`(회전된 같은 라벨 포함), `viewer`, 무토큰의 `GET /v1/writes/{ref}`가 없는 참조와 같은 404 `private`: `editor`가 쓰고 읽음, 무토큰·`viewer`·MCP `kb_search`·`kb_get`·`kb-collect`에서 없음, `private` spec의 `export_llm=true`가 400, `private`→`internal` `PUT`이 403 `declassify_requires_review`, `secret` 요청이 403, 네 타입 모두 빠진 `sensitivity`가 `private`, `private` spec의 `export_query=true`도 400이고 생략은 `false` editor/reviewer 소켓에서 본문·current·판 이력·changes·backlinks/edges/neighbours·목록/검색 모두 private 가시성이 같음. 무토큰은 internal 이하, 잘못된 Bearer는 401. 실패 본문은 발급 tok_id만 회수, purge 뒤 body 요청은 410 content_removed, 타인·격리·숨은 대상은 404. 휴지통은 created_app만 보이고 회전 토큰도 같은 앱이면 보임. | `ops/bin/dev pytest tests/fpapi/test_failed_write_body.py tests/fpapi/test_private_read_routes.py tests/fpapi/test_trash.py tests/fpapi/test_private_scope.py tests/fpapi/test_http_write.py tests/fpapi/test_token_lifecycle.py tests/fpapi/test_byte_quota.py tests/fpapi/test_spool_quota.py tests/fpapi/test_write_ref.py -q && ops/bin/dev pytest tests/http -q && ops/bin/dev pytest tests/mcp -q --ignore=tests/mcp/test_claude_real.py` |
| FW5 | 투영: `raw/fp` 큰 본문을 `content`에 넣고 문단 색인을 연다, 객체가 없으면 `projected=false`, tombstone된 기록의 나가는 사용자 링크를 `dead`로(5.5). 파생 주장·복사 근거·색인의 first_party 원본 최댓값 상속, 민감도 상향 시 기존 파생물 재투영, 완료 전 모든 읽기의 현재 원본 가시성 검사(3.6) | 100 KB `Page`가 `/body`로 200, 전문 검색에 걸림, `secret`이면 없음, `raw/fp` 객체를 지운 시험에서 격리 이벤트 0, tombstone 뒤 백링크에서 빠짐, 재구축이 증분과 같음. `internal` Note에서 이미 추출한 주장·복사 근거를 만든 뒤 Note를 `private`로 높이면 재투영 전/후와 재시작/재구축 뒤 모두 MCP·일반 HTTP·CLI의 검색/FTS·목록·직접 본문·이력/옛 시점·엣지/백링크/이웃·변경 피드·내보내기에 문장·인용·근거가 없고 직접 조회는 404/`not_found`. 원본 둘 중 하나만 `private`여도 최댓값 적용, `editor`만 허용 범위에서 읽음 | `ops/bin/dev pytest tests/fpapi/test_fp_big_body_read.py tests/fpapi/test_tombstone_edges.py tests/fpapi/test_derived_sensitivity.py -q && ops/bin/dev pytest tests/read -q` |
| FW6 | 승격과 연구: `promote`(연구 포함), `research`, `research/{run}/stop`, `GET …/research`, 한 트랜잭션의 확인과 이벤트(6.1), 결정적 실행 ID, `cancelled`, `DEFINES`, `REQUESTS_ABOUT`, spec 편집 시 `entity.put` 동기화, `Review`와 `REVIEWS`, 세 단위 예산 예약(6.4), `budget_unavailable`, `export_llm`·`export_query`(6.6), 수집 프로필 티켓 숨김, spec 민감도의 연구 티켓·주제·실행 기록 상속과 갱신, 원본 민감도를 물려받는 승격(5.7). **ADR-0004 TP1, TP5, D5 뒤** 4.2 slug 기본값, 6.5 틀림 제보·리뷰 목록·재검증 티켓, 6.6 비공개 발견 제한, 6.9 K-c 미결 상한(FW6/E1/D5 담당). | 연구 → 멈춤 → 연구(같은 spec 판)가 새 실행을 만든다. 같은 키 재시도가 실행을 하나만 만든다. 동시 요청 두 개가 열린 실행 하나로 끝난다. 예산 장치가 없으면 409이고 원장 변화 0. 주제·전체·엔진 중 하나가 모자라면 유료 호출 0. `export_llm=false` 주제의 글이 외부 어댑터 요청 본문과 `kb_ticket_list`에 없음. 상태 응답에 비율·점수 필드 없음. 요청 B가 열린 실행 A에 합류하고 A가 닫힌 뒤 B 재생이 A를 돌려주고 새 티켓 0. `sending` 뒤 응답 시간 초과를 흉내 내면 예약이 남아 같은 한도의 다음 유료 호출이 거부되고, `sending` 전 실패만 반환되고, 제공자 사용량 자료로 정산된다. `sending` 뒤 재전송이 새 `(호출 ID, 시도 번호)` 예약을 잡고, 남은 한도가 모자라면 재전송이 일어나지 않음. `export_llm=true` 주제는 수집 프로필에서 ID·라벨·`aliases`·`exclude`·`domain`·상태만 보이고 spec 본문·ID는 없음. `export_llm=false` 주제의 `Topic` 엔티티가 `origin=first_party`이고 slug·라벨·별칭이 수집 프로필 응답에 없음. `private` spec의 티켓·주제·실행 기록이 모두 `private`이고 처음부터 `internal` 노드 0, 일반 HTTP 목록/검색·MCP 티켓 목록에 slug·실행 정보 없음. 연구 도중/완료 뒤 spec을 `private`로 높여도 기존 메타데이터가 즉시 숨음. `private` 메모를 민감도 생략으로 승격하면 spec과 메타데이터 모두 `private`, `export_query` 생략은 `false`, `true`는 400, 낮은 민감도 명시는 403이고 쓰기 0 verdict reject가 주장 상태를 직접 바꾸지 않고 같은 트랜잭션의 재검증 티켓 하나만 생성. private 사유·URL 메타데이터가 외부 LLM/일반 목록에 없음. private 연구 외부 질의·LLM 호출 0, discovery narrowed와 이유 반환. K-c 전용 상한/재시도/엔진 전환 시험은 6.9의 계획 항목이며 완료 전 해당 유료 에이전트 경로 폐쇄. | `ops/bin/dev pytest tests/fpapi/test_claim_reports.py tests/fpapi/test_research_runs.py tests/fpapi/test_research_replay.py tests/fpapi/test_research_budget.py tests/fpapi/test_research_export.py tests/fpapi/test_research_sensitivity.py tests/fpapi/test_promote.py -q && ops/bin/dev pytest tests/topic -q` |
| FW7 | **Codex 교차 검토(쓰기 게이트).** FW3, FW4, FW6 구현 뒤, 운영 소켓에서 쓰기를 켜기 전. `codex` 에이전트, tier high. 입력: diff(`src/kb/serve/http.py`, `src/kb/write/author.py`, `src/kb/write/record.py`, `src/kb/write/engine.py`, `src/kb/write/secrets_scan.py`, `src/kb/commands/token.py`, 연구 경로)와 이 ADR 3, 5.8, 6.4, 7장. 볼 것: 무토큰 쓰기, 귀속을 허가로 쓰는 곳, 숨은 대상 누출, 외부 사실 우회, 비밀 탐지 우회와 잔여, 입력 되풀이, 멱등·판·실행 경쟁, 예산 우회, 바이트 한도 우회 | 지적마다 시험을 하나 더하거나 반박 근거를 남긴다. 의견이 갈리면 시험으로 가리고, 못 가리면 양쪽 근거를 사용자에게 보인다. 검토 기록 파일이 있다 | `test -s docs/reviews/0005-codex-fw7.md && ops/bin/dev pytest tests/fpapi tests/write tests/http tests/read -q && ops/bin/contract-check && ops/bin/dev pytest tests/mcp -q --ignore=tests/mcp/test_claude_real.py` |
| FW8 | 켜기: 사용자 승인 뒤 `kb-read.socket` 재기동, `editor` 토큰 발급 안내(사용자가 TTY에서), sagae-tools에 배포 계약 버전 통지(FW9 포함 0.5.0) | 임시 `KB_HOME` 끝단 시험(소켓 활성화 → 만들기 → 자동 저장 → 충돌 → 비밀 거절 → tombstone → 복원 → 승격 → 연구 상태)이 통과. 운영 쓰기는 사용자 입회 | `ops/bin/dev pytest tests/fpapi/test_socket_e2e.py -q` |

| FW9 | HITL·사용자 동작(6.8): `reviewer` 범위, 미해결 신호 기반 항목 생성/자동 해소, 특권 등록·폐기와 root 소유 신뢰 저장소 검증, WebAuthn 등록·도전·실행, 2.2의 HITL·등록·사용자 동작 경로, 기존 TTY 함수의 사람 증명, `review_state`, `release`·`declassify`·`publish`, publish 외부 전송 동의·E1/D5 엔진 선택과 예산·외부 API 필요성 우선 판단·토큰 절약용 로컬 sLLM·엔진 provenance·확인 결과 해시/PROMOTED_FROM(5.10), 계약 0.5.0 5.10 비동기 publish 접수·poll·timeout/expiry와 엔진/비용/시간 보고, 6.8의 RP별 origin 목록·자격 증명 재등록, 8.1 hitl 상태. 14.8 보완: 전송 전 publish_external_refine 동의와 결과 공개 전 publish 확인의 분리, localhost 잔여 위험과 loupe 완화 권고. | 토큰만 있고 확인이 없는 실행, 틀린 RP ID·origin·도전·`action_sha`, 카운터가 늘지 않은 확인, 만료 도전은 403 `review_unverified`이고 원장 변화 0. 대상 판/상태·후보 결과 변경은 409 `review_stale`. 저장소/디렉터리가 KB 또는 agent UID에 쓰기 가능하거나 키 교체·누락이면 HITL·사용자 동작 모두 503, `/v1/meta` 이유 표시. 같은 UID가 등록 후보만 제출해도 활성 키가 되지 않고 root 설치·폐기만 반영됨. 성공은 `actor=user:sagae`와 증명/결과 해시를 기록. 미해결 신호가 있을 때만 항목 생성, 자동 해소 시 닫힘, 일반 연구 결과는 HITL 없음. `gate_unresolved` 해결 뒤 문장·인용·`verification` 불변. 해제 준비에 격리 내용 없음. `publish` 준비 결과는 `private`, 메모 ID·판·실제 전송 해시에 묶인 WebAuthn 동의를 검증한 메모 내용만 외부 정제 허용, 다른 private 기록·링크된 private 제목 전송 0, 짧고 단순한 메모·서식 정리·노트 분할·별칭 추출은 토큰 절약용 로컬 처리, 길거나 추론이 많은 정제는 E1/D5 선택·예산 적용 및 엔진 없음/예산 소진 시 로컬 대체, 엔진 provenance 기록, 증명 전 공개 기록 0, 실행 뒤 원본은 `private` 유지하고 `internal` Note/Page만 PROMOTED_FROM으로 연결됨. 주장 후보는 정상 게이트, 원본 비공개 근거는 일반 읽기에 없음, 재생 중복 결과 0. TTY만으로 해제/민감도 낮추기 우회 불가 publish 접수 202와 action_id, 같은 키의 준비 작업 하나, preparing/ready/failed/expired 조회와 tok_id 소유 검사. 준비 120초 timeout·완료 뒤 15분 만료, 불확실한 외부 예약 유지. RP ID localhost/정확 origin만 허용, 다른 RP 자격 증명 거절, RP 추가·폐기는 root 특권 단계. reviewer 토큰만으로 준비하면 외부 어댑터 호출 0, 동의 없음/잘못됨/해시·판 변경/도전 만료 시 호출 0. 첫 동의로 internal 공개 불가, 두 번째 확인으로 외부 전송 불가. 재시도·엔진 전환·SDK 자동 재전송도 새 동의 없이 호출 0. reviewer 토큰 없는 challenge 요청은 401/403. | `ops/bin/dev pytest tests/fpapi/test_publish_async.py tests/fpapi/test_reviewer_rp.py tests/fpapi/test_hitl_webauthn.py tests/fpapi/test_hitl_items.py tests/fpapi/test_hitl_scope.py tests/fpapi/test_reviewer_trust.py tests/fpapi/test_publish.py -q && ops/bin/contract-check` |

**순서.** FW1 → FW2 → FW3 → FW4 → FW5 → (TP1, TP5, D5 뒤) FW6 → FW7 → FW8. FW9는 두 추가 결정이 확정되어 FW5 다음에 하고, 운영에서 켜기 전에 FW7의 Codex 교차 검토에 넣는다. FW6이 늦어지면 FW7은 FW3~FW5로 먼저 돌고 FW6 뒤 다시 돈다.

**바뀌는 것(모든 통로).** 낡은 `expected_version`은 내용이 같아도 409다(2.3). 식별자 칸(멱등 키, ID, 타입, 속성 이름, tombstone 사유)에 비밀이 있으면 격리가 아니라 거절이고 값을 되풀이하지 않는다(7.1, 7.2. ADR-0001 7.9 개정은 다른 워커가 한다). MCP `kb_put`과 inbox 호출자도 영향을 받는다.

**바꾸지 않는 것.** MCP `kb_put`, `kb_request`의 입력과 응답 모양, inbox, `kb put` CLI, 이 세 통로의 내용 칸(제목, 본문, 속성 값) 비밀 격리와 위키 링크 규칙, 무토큰 소켓 읽기 범위, 편집기 밖의 결정 14 (c), first_party 게이트, 원장 체인 규칙, 인용 게이트의 판정. 사람 결정의 TTY 입구에는 6.8의 증명을 적용한다.

## 10. 남길 KB 기록

이 ADR이 승인되면 리드가 `kb_put`으로 남길 결정 기록(코드와 문서로 알 수 없는 이유만):

- HTTP 쓰기의 귀속을 인증된 앱과 주장된 작성자로 나누고 허가에 쓰지 않는 이유(3.2).
- 유료 연구를 예산 세 단위의 예약으로만 허가하는 이유(6.4).
- HTTP 편집기 경로의 비밀 탐지를 거절로 둔 이유(7.1).
- 자동 저장을 KB 밖 초안 + 묶은 판 + 원장 기준 바이트 한도로 둔 이유와 추정 증가량(5.8).
- 주제 기록 타입을 `TopicSpec`으로 나눈 이유(4.1).

## 11. 이 판에서 버린 1판의 내용

| 1판 | 버린 이유 |
|---|---|
| `change=save`면 `actor=user:sagae` | 클라이언트 신고를 인증된 작성자로 적었다(14장 O-B2, X-1) |
| 현재 판 작성자가 `user:sagae`여야 연구를 연다(409 `spec_not_user_authored`) | 작성자를 허가에 썼고, 같은 내용 재저장은 무연산이라 성립하지 않았다(X-1, X-8) |
| `confirm_slug`, 주제 상한을 HTTP로 고정 | 연구 요청 개정 요구로 이미 빠졌고, 허가는 예산이 한다 |
| 연구 키 `loupe:r:<spec>:v<n>` | 멈춘 뒤 같은 판의 재요청이 재생됐다(O-H3, X-4) |
| 30초 하한이 증가를 묶는다 | 신고로 피할 수 있고 바이트 상한이 없었다(O-M1, X-6) |
| 짧은 필드는 외부 LLM에 늘 간다 | 내보내기 허가 없이 내부 글이 나갔다(O-M4, X-7) |
| 스냅샷 링크 `s-` | 스냅샷은 `n-`다(O-M3, X-9) |

## 12. 사용자 결정(외부 정제 질문 종결)

2026-11-04 사용자가 질문 도구에 직접 답했다(원문은 `docs/adr/0002-user-decisions.md` "loupe 쓰기 API 승인과 하위 결정").

| 이전 질문 | 결정 | 이 문서 |
|---|---|---|
| ADR 승인 범위 | "전체 승인 (Recommended)". FW1부터 설계 기본값으로 진행한다: 토큰 하루 32 MB, 연구 요청 하루 5회, v1 첨부 없음, 모든 통로의 낡은 판 409와 NUL 키 400, 식별자 비밀 거절. FW6은 ADR-0004 TP1·TP5·D5 뒤, FW8 운영 켜기는 사용자 입회 | 0장, 9장 |
| 1 공개 범위 | "private 전면 개방" | 3.6 |
| 2 ADR-0004 고침, 3 외부 작업 공간, 8 MCP·inbox 위키 링크 | 전체 승인으로 이 문서의 기본값을 쓴다: ADR-0004를 `TopicSpec`·`DEFINES`·`PROMOTED_FROM`·`export_llm` 기본 `false`에 맞춘다, `collect_mode=workspace`는 ADR-0004에 KB 운영 선택지로 남기고 loupe에서는 고르지 않는다, 정확한 링크 모양은 편집기 경로에만 둔다 | 4.1, 6.1, 4.6 |
| 4 첨부 | v1 첨부 없음(전체 승인) | 4.4 |
| 5 사람의 검토 | "HITL 적용해야 하는 항목들이 있고, 내가 방향만 제시했을 때, 알아내는 정보들은 굳이 HITL할 필요가 없어보이는데?" | 6.5, 6.8 |
| 6 비밀 탐지 예외 | 전체 승인 | 7.1 |
| 7 상한 | 전체 승인(기본값으로 시작) | 3.5, 5.8, 6.4, 6.7 |
| 9 외부 검색어 | "내보냄 (Recommended)". `export_query` 기본 `true`(`private` spec은 늘 `false`) | 6.6, 3.6 |
| HITL 목록 추가 답 | "의도가 명확하지 않다고 판단할때가 맞을 듯.". 미해결 신호가 있을 때만 시스템이 올린다. 사용자 공개·해제 동작과 분리한다 | 6.8 |
| 기본 민감도 추가 답 | "기본은 private를 생각하고, 메모를 지식베이스에 반영하기 버튼이 눌렸을 때, 해당 메모의 정보들을 llm으로 정제후, kb에 반영하는 루트를 생각하고 있음.". 모든 새 기록 기본 `private`, 메모는 사람 확인 뒤 정제 결과만 반영한다 | 3.6, 5.10 |

**외부 정제 엔진 결정(2026-11-04, 질문 도구의 사용자 답으로 승인·종결).**

질문 원문: "loupe에서 '지식베이스에 반영' 버튼을 누르면 private 메모를 LLM으로 정제해 KB에 올립니다. 이때 정제를 어떤 엔진으로 할까요?" 사용자 답 원문: "버튼 누르면 외부 허용". 이 답은 5.10의 **외부 전송 전 `publish_external_refine` WebAuthn 동의**로 구현한다. 단추를 눌렀다는 앱의 주장이나 reviewer 토큰 POST만으로는 동의가 아니다. KB 선택기는 외부 API 필요성을 로컬에서 먼저 판단하며, 짧고 단순한 메모·서식 정리·노트 분할·별칭 추출은 토큰 절약용 로컬 sLLM으로, 길거나 추론이 많은 정제는 전송 내용에 묶인 첫 번째 동의를 KB가 검증한 뒤 ADR-0004 E1/D5 예산과 비용·품질에 따라 고른 외부 엔진으로 처리한다. internal 공개 전에는 정제 결과 해시에 묶인 두 번째 WebAuthn 확인을 별도로 받는다. 같은 날 추가 사용자 지시 원문: "로컬 llm은 굳이 외부 api를 돌릴 필요 없는 케이스에 대해서 토큰 절약으로 접근되길 원함." 로컬은 publish의 프라이버시 기본값이나 대체 전용이 아니다. 외부 엔진이 없거나 예산이 소진되면 로컬 sLLM으로 대체한다. 다른 private 기록·링크된 private 제목은 보내지 않으며 private 외부 전송은 이 동작에서만 허용한다. 후보는 정확한 결과 해시를 묶은 WebAuthn 확인 전까지 private이고, 사용 엔진은 provenance에 남긴다(3.6, 5.10). 남은 사용자 질문은 없다.

## 13. loupe v2 가정과 요청에 대한 답

### 13.1 리드가 전한 판

`L 9.2(리드가 전한 판)`(K1~K10), `L 부록 A`(A1~A11), `L 6.4`(실행기)에 답한다. "받음"은 그대로, "고쳐서 받음"은 바꿔서, "받지 않음"은 이유와 함께 거절이다.

| 항목 | loupe 요청·가정 | 답 | 이유와 KB 규칙 | 이 문서 |
|---|---|---|---|---|
| K1 | first_party HTTP 쓰기, 쓰기 전용 소켓, `kb_put`과 같은 본문·응답, 갱신, 묘비, 복원 | 고쳐서 받음 | 쓰기는 생긴다. 소켓은 읽기와 같고 쓰기 경로는 토큰 필수다. 두 소켓은 같은 UID 0600이라 권한이 나뉘지 않는다(`src/kb/commands/serve.py:47-52`). 본문에 `change`, `on_secret`이 더해진다 | 2장, 3.1 |
| K2 | `first_party_open` 전환 시점과 `held` 기간의 뜻 | 받음(설명) | `first_party_open`은 보이는 first_party 노드가 있다는 뜻이고 게이트가 아니다(`src/kb/read/catalog.py:189-193`). 게이트는 원장 `meta.fp_open`이고 2026-11-01에 열렸다(`src/kb/write/engine.py:107-108`, `A:1271`). `held`는 `spool/fp-held`에 내구 보관됐고 `kb fp open` 때 원래 작성 시각으로 적재된다는 뜻이다(`A:675`). 지금 `held`가 나오면 사고다. `/v1/meta.write.fp_gate`와 `write_ref`를 더한다 | 5.9, FW1 |
| K3 | `Topic`, `Memo` 타입, `ABOUT`, `PROMOTED_FROM`, 주제-티켓 연결 | 고쳐서 받음 | 메모는 기존 `Note`(`D4:199`). 주제 기록은 `TopicSpec`이고 닻은 엔티티 `Topic`이다. `ABOUT`(기존)과 `PROMOTED_FROM`(새)을 받는다. 주제-티켓은 기존 `REQUESTS_ABOUT`로 잇는다 | 4.1, 4.2, 5.7, 6.1 |
| K4 | HTTP 티켓 생성, `/v1/ops/*` 밖 상태·단계·비용·상한·하위 실패 읽기, 취소 | 고쳐서 받음 | 범용 티켓 생성은 열지 않는다. 티켓은 세션 요청과 URL 제보 통로이고(`A:667`) loupe는 외부 사실을 내지 않는다. 연구 요청, 실행 멈춤, 상태 읽기를 둔다 | 6.1~6.3 |
| K5 | 검토 결정을 first_party 기록으로 받아 `verification`에 반영 | 고쳐서 받음 | 결정은 `Review` 기록으로 받는다. `verification`은 인용 게이트가 정하므로(`A:508`, `A:943-966`) 반영하지 않는다. 8판: 미해결 신호에 대한 HITL과 사용자가 시작하는 공개·해제 동작은 6.8의 사람 증명을 거친다. 검토 결정은 주장 문장·인용·`verification`을 고치지 않는다 | 6.5, 12장 질문 5 |
| K6 | 비밀 검사의 거절 선택지와 값 없는 위치 | 받음 | HTTP 편집기 경로는 기본 거절이고 순번 필드와 코드포인트·UTF-16 위치를 준다. 근거: 덧붙이기 전용 원장에서 거절만 비밀이 원장과 사본에 닿지 않는다(`A:357`, `src/kb/write/record.py:111-119`). 오탐은 명시적 격리 저장 | 7.1~7.4 |
| K7 | `[[...]]` 범위, 본문 최대 크기 | 받음 | `[[id\|label]]`, `[[c-…]]`, `[[n-…]]`은 `LINKS_TO`다. 종류별 정확한 모양만 받는다. 제목 링크는 loupe가 ID로 풀어 저장한다. 본문 1 MiB | 4.3, 4.5, 4.6 |
| K8 | 여러 주제의 이웃을 한 번에 | 받지 않음(지금) | 열린 주제 20개 이하이고(6.7) 동시 처리 16, 웜 p95 200 ms 안에서 주제마다 `/neighbors`를 부르면 된다(`A:1244-1245`). 쓰기 ADR의 범위 밖이다. 50개를 넘으면 읽기 계약 판에서 다시 본다 | 8장 |
| K9 | 팔레트의 first_party 검색, 접두어, 주제·메모 종류 | 고쳐서 받음 | `/v1/search`의 `kinds=record`, `types`와 `/v1/nodes`의 `filter=label:prefix:`. 타입 이름은 `Note`, `TopicSpec`. `label` 거르기는 FW1에서 확인 | 8장 |
| K10 | 자동 저장 판 묶기 | 고쳐서 받음 | KB는 커밋한 판을 합칠 수 없다. loupe 초안이 커밋 전에 묶고, KB는 `change`와 무관한 바이트 한도를 둔다. KB 초안 저장소는 두지 않는다 | 5.8 |
| A1 | `kb_put`과 같은 본문과 응답 | 고쳐서 받음 | `change`, `on_secret`, `unchanged`, `write_ref`, `payload_sha`, `quarantined`, `actor`, `claimed_author`, `generated_by`가 더해진다 | 2.4 |
| A2 | 읽기와 다른 소켓, 작성자 `user:sagae` | 고쳐서 받음 | 소켓은 같다. `actor`는 `app:loupe`이고 `user:sagae`는 주장된 작성자(`on_behalf_of`)로만 남는다 | 3.2 |
| A3 | 충돌이 현재 판과 본문을 돌려준다 | 고쳐서 받음 | 대상이 보이는 범위일 때만이다. 숨은 대상은 404이고 `current`가 없다 | 5.4, 3.4 |
| A4 | 묘비와 복원이 HTTP로 되고 복원은 새 판 | 받음 | tombstone은 대상 확인과 `expected_version` 필수, 복원은 `PUT` | 5.5 |
| A5 | 비밀 검사 거절, 값 없는 위치 | 받음 | K6과 같다 | 7.1~7.4 |
| A6 | `Topic`, `Memo`, `ABOUT`, `PROMOTED_FROM`을 받는다 | 고쳐서 받음 | K3과 같다. `editor`는 모르는 타입을 받지 않는다 | 4.1 |
| A7 | `[[c-…]]`가 주장 노드로의 `LINKS_TO` | 받음 | 주장 ID 모양(`c-` + base32 12자)을 통과한다 | 4.3, 4.6 |
| A8 | 티켓 생성, 상태·비용 읽기, 취소가 `/v1/ops/*` 밖에 생긴다 | 고쳐서 받음 | K4와 같다 | 6.1~6.3 |
| A9 | 에이전트 결과가 `needs_review`로 들어오고 검토 기록으로 판정이 바뀐다 | 받지 않음 | 검증은 인용 게이트가 정하고 게이트를 통과한 주장을 일괄 `needs_review`로 돌리지 않는다(`A:943-966`). 사람의 결정은 `Review`로 남는다 | 6.3, 6.5 |
| A10 | 문서 속성은 `record.props`에 두고 갱신으로 바꾼다 | 받음 | 전체 교체이므로 `props` 전체를 보낸다. 경로 힌트 키는 금지 | 4.2, 5.3 |
| A11 | 자동 저장 빈도에 KB 쪽 제한이 없다 | 받지 않음 | 판마다 전체 본문이 원장과 gold에 남는다(`A:354`, `src/kb/project/apply.py:353`). KB는 원장 기준 바이트 한도를 둔다 | 5.8 |
| 실행기 | 에이전트 실행기와 비용 상한이 KB 쪽에 있다 | 받음 | KB가 엔진을 고르고(`D4:1015`), 주제·전체·엔진 예산을 예약하며(6.4), 키는 쓰기 주체에만 있다(`D4:1772`). loupe는 상한을 보내지 않고 상태에서 읽는다 | 6.1, 6.3, 6.4 |

### 13.2 loupe 검토판의 번호 대응(Q14)

| 지금 판 | 13.1의 답 | 달라진 점 |
|---|---|---|
| N1 경로와 전송 | K1 | 같음 |
| N2 작성자, 사람 확인 | A2, 3.2 | 일반 저장의 사람 귀속은 loupe의 주장이다. 6.8의 HITL·사용자 동작은 KB가 사람 증명을 검증한다. 연구의 허가는 예산이고(6.4), 응답의 `state`가 `queued`, `budget_unavailable` 등을 준다 |
| N3 종류, 기록 ID와 노드 ID | K3 | 연구 응답이 `spec`(기록 ID)과 `topic`(노드 ID)을 함께 준다 |
| N4 편집, 묘비, 복원 | A4 | 묘비와 복원 모두 `expected_version` 필수 |
| N5 충돌 응답 | A3 | 보이는 대상일 때만 본문 |
| N6 오류와 경고 코드 | 7.5, 7.6 | `unchanged:true`와 현재 판 |
| N7 주제와 수집의 대응 | K4 | `collect_mode`가 빠졌다. 진행 값은 6.3 |
| N8 한도 | 4.5, 5.8 | 64 KB 너머 읽기는 FW5. 요청 한도(500자, URL 50개)는 연구 요청에 해당 없다 |
| N9 링크 | K7 | `links[]`와 본문 `[[...]]`가 겹치면 한 엣지(`src/kb/write/record.py:66-80`) |
| N10 `private` | 3.6 | **바뀐다(7판).** `editor`가 `private`를 읽고 쓴다. 다른 경로는 계속 못 본다 |
| N11 읽기 보강 | K8, K9 | 같음 |
| N12 멱등 키 | 5.1 | 256자, 기한 없음. 편집 키만 `change` 포함, 만들기 키는 초안 UUID뿐 |
| N13 비밀 규칙 공개 | 7.7 | FW1의 규칙 판·해시·합성 벡터, 선택 브라우저 검사와 권위 있는 서버 검사 |
| K-c 호출 수 상한, K-d 주입 방어 | 6.9 | 기존 근거와 시험 위치, 호출 수 하드 상한은 FW6/E1/D5 미결 |
| A1 HTTP 요청·응답 | A1 | 2.4의 추가 필드와 응답 모양 |
| A2 작성자·소켓 | A2 | 인증된 앱과 주장된 사용자 귀속을 분리 |
| A3 충돌 현재 판 | A3 | 보이는 대상만 `current`, 숨은 대상은 404 |
| A4 묘비·복원 | A4 | 둘 다 `expected_version` 필수 |
| A5 비밀 검사 "해소: 격리" | K6 | 기본 거절, 오탐 선택 때만 격리 |
| A6 `Topic`·메모 타입 | K3 | 기록은 `TopicSpec`·`Note`, 엔티티는 `Topic` |
| A7 주장 링크 | A7 | `[[c-…]]`는 `LINKS_TO` |
| A8 연구 상태 | K4 | 6.3의 실행·엔진·비용·제한 범위 |
| A9 문서 속성 | A10 | `record.props`, 전체 교체, 4.2의 속성 계약 |
| A10 같은 내용은 새 판 없음 | 2.3, 5.3 | 낡은 판은 같은 내용이어도 409 |
| A11 64 KB 너머 읽기와 비교 | 4.5 | FW5 뒤 같은 경로. 그 전에는 410 |
| A12 `[[id\|라벨]]` | K7 | 받는다 |
| A13 `fp_open` 열림 | K2 | 8.1의 `write.fp_gate`로 읽는다 |
| A14 멱등 키 | 5.1 | 기한 없음, actor별 키, 다른 내용 재전송은 충돌 |
| `L 6.3` 제출 전 검토, `L 6.4` sagae-tools 실행기 | 6.1, 6.5 | 개정 요구(엔진과 상한은 KB)와 어긋난다. KB 판단은 6장 |

클라이언트 요구와 loupe 초안은 sagae-tools가 전한 값이고 검증하지 않았다. sagae-tools가 확정본을 보내면 1장, 4장, 13장을 대조한다.

## 14. 검토 지적과 처리

`O-`는 Opus 리드 수준 검토(`review-0005.md`), `X-`는 리드가 전한 Codex 지적과 리드 결정 1~10이다. Codex 원문은 받지 못했고 리드의 정리로 받았다.

| ID | 지적 | 처리 | 위치 |
|---|---|---|---|
| O-B1 | `props.source_path`로 비밀 탐지 우회(검토 실행으로 적중 0 확인) | 편집기 경로에서 경로 힌트 키를 거절하고 탐지에 경로를 주지 않는다. 지금 코드 결함은 다른 워커가 고치는 중이라고 적었다. FW3 시험 | 4.2, 7.2, 1장 |
| O-B2 | `change=save`를 사용자 승인으로 취급, TTY 조건은 흉내 낼 수 있다 | `actor=app:<라벨>`, 주장된 작성자는 `on_behalf_of`. 귀속은 어떤 허가에도 쓰지 않는다. TTY는 실수 방지라고 적었다 | 3.2, 3.3 |
| O-B3 | FW6 출시 때 주제 상한이 없다 | FW6이 TP1, TP5, D5 뒤. 그 전에는 409 `budget_unavailable`. 세 단위 예약 | 6.4, 9장 |
| O-H1 | 409 `current`가 숨은 판을 누출 | 숨은 대상은 404이고 `current` 없음 | 3.4, 5.4 |
| O-H2 | PUT·tombstone에 대상 확인 없음, 사유 미검사 | 잠금 안 출처·타입·민감도·격리·지움 확인, 사유 비밀 탐지 | 3.4, 5.5, 7.2 |
| O-H3 | 같은 판에서 연구 재시작 불가 | 실행 ID, 멈춤은 실행을 닫는다 | 5.1, 6.1, 6.2 |
| O-H4 | 두 탭에서 스풀된 쓰기 유실 | `write_ref`, `GET /v1/writes/{ref}`, `payload_sha`, 초안 삭제 조건 | 5.9 |
| O-M1 | 증가 상한 없음, 사용자 판마다 sLLM 추출 | 원장 기준 바이트 한도, `TopicSpec`·`Review`·`auto` 제외, 기록별 합치기 | 5.8 |
| O-M2 | `change`가 키에 없어 충돌, 한도가 재시도를 막음 | 키에 `change`, 한도는 재생 확인 뒤, 같은 `payload_sha`면 확정 처리 | 2.3, 5.1, 5.4 |
| O-M3 | 위키 접두사 틀림(`s-`), `[[c-suite]]`, 공용 `_links` 변경 | 종류별 정확한 모양, `n-`, 편집기 경로만 적용, MCP·inbox는 질문 8 | 4.6, 12장 |
| O-M4 | ADR-0002:56은 결정이 아니다, 티켓 `topic`이 외부 LLM에 간다 | 리드 정정: `:65-67`에서 사용자가 확정했다. 확정으로 인용했다. 티켓 `topic`은 주제 ID와 고정 사유이고, `export_llm=false`면 수집 프로필에 내지 않는다 | 6.6, 1장 |
| O-M5 | 위치가 코드포인트라 JS에서 어긋남 | 코드포인트와 UTF-16을 함께 | 7.2 |
| O-L1 | 토큰: 막는 범위, 라벨 중복, 회전·만료·마지막 사용 없음 | 막는 것과 못 막는 것을 적었고 라벨 유일, 만료, 회전, 폐기, 마지막 사용을 더했다 | 3.3 |
| O-L2 | 64 KB 수정 보완: 객체 없음 처리, 409 본문 | `projected=false`, CAS에서 `current.body` | 4.5 |
| O-L3 | 예외 문자열 출력 | 편집기 경로는 고정 문구, 예외 문자열을 찍지 않는다 | 7.2 |
| O-L4 | 복원은 동작한다(근거 `ledger.py:274-277`) | 근거를 바꿔 적었다 | 5.5 |
| O-L5 | tombstone이 엣지를 닫지 않는다 | FW5가 나가는 사용자 링크를 `dead`로 | 5.5 |
| O-8 | `uv` 없음, `oasdiff`는 `contract-check`만, 기존 시험에 맞는 `-k`, FW7 기록 확인 없음 | `ops/bin/dev pytest`, `ops/bin/contract-check`, 새 시험 파일 이름, `test -s` | 9장 |
| X-1 | 작성자 귀속과 허가 | O-B2와 같고, 유료 연구는 예산(주제·전체·엔진 원자 예약, 재시도·동시 요청 포함)만 허가. FW6은 TP5, D5에 의존 | 3.2, 6.4, 9장 |
| X-2 | `source_path` 우회와 메타데이터 검사 | 경로 힌트 거절, 기록 전체 + 키·사유·속성 이름을 CAS·스풀·원장·재생 전에 검사, 입력을 되풀이하지 않음 | 2.3, 7.2 |
| X-3 | 숨은 머리 | 409·PUT·tombstone이 잠금 안에서 확인하고 404 | 3.4 |
| X-4 | 연구 멱등 | 실행 ID, 결정적 티켓 ID, 한 트랜잭션, 스풀 안 함 | 6.1, 6.2 |
| X-5 | 두 탭 202 스풀 초안 | 확정 전에는 초안을 지우지 않는 규칙 | 5.9 |
| X-6 | 증가 | `change`와 무관한 원장 기준 바이트 한도, 검토 추정 수치, sLLM 큐 규칙과 이유 | 5.8 |
| X-7 | 외부 LLM 노출 | `export_llm` 기본 `false`, 허가 없으면 로컬, MCP 세션의 `internal` 읽기를 명시 | 6.6 |
| X-8 | 무연산 순서(`engine.py:163`)와 변경 없는 에이전트 spec | 낡은 판 확인을 앞으로(모든 통로), 연구 요청 이벤트가 명시적 요청 기록 | 2.3, 6.1, 9장 |
| X-9 | 스냅샷 접두사 | `n-` | 4.3, 4.4, 4.6 |
| X-10 | 검증 명령 | O-8과 같다 | 9장 |

### 14.1 3회차: 2판 재검토(Opus `review-0005.md` Round 2b, Codex는 리드 경유)

| ID | 지적 | 처리 | 위치 |
|---|---|---|---|
| R3-1 (O-N2, Codex) | 스풀 경로가 바이트 한도를 건너뛰고 스풀 상한이 없다(`src/kb/core/spool.py:26-51`) | 202 전에 한도 잠금 안에서 원장 증가 + `pending` 예약 + 이 요청을 한도와 비교하고, 예약 파일을 fsync한 뒤 스풀한다. 스풀 상한은 토큰별 200건·64 MiB, 전체 400건·256 MiB이고 넘으면 503 `spool_full`. 적용 때 예약이 빠진다(실패는 4회차 R4-1이 바꿨다: 지울 때까지 센다). 재적재 실패 코드에 `byte_quota_exceeded`, `lost_before_spool` | 2.2, 2.3, 5.8 "스풀과 보류의 예약", 5.9 표, 7.5, FW4 |
| R3-2 (Codex) | 과금됐을 수 있는 호출의 예약을 시간 초과로 반환한다 | `reserved → sending → settled \| uncertain`. `sending` 전에 끝난 호출만 반환한다. `uncertain`은 세 단위에 잡힌 채 제공자 사용량·비용 자료로 맞추고, 7일 안에 못 맞추면 예약 금액으로 정산한다 | 0장 결정 7, 6.4, FW6 |
| R3-3 (Codex) | 열린 실행에 합류한 요청 B의 재생이 실행이 닫힌 뒤 새 실행을 만든다 | 새 실행이든 합류든 `research.request` 이벤트(요청 키 → 실행 ID)를 같은 커밋에 쓰고, 재생은 그 실행을 돌려준다. 오류 응답은 쓰지 않으므로 재시도가 다시 판단한다 | 6.1 3·4번, "재생", "명시적 요청 기록", FW6 |
| R3-4 (Codex) | 재생이 지금 가시성을 보지 않는다 | 재생 조회 바로 뒤, 잠금 안에서 대상의 3.4를 다시 본다. 숨었으면 ID·판·해시·참조가 없는 같은 404 | 2.3, 5.1 "재생도 가시성을 다시 본다", 7.4, 7.5, FW3 |
| R3-5 (O-N1) | 만들기 키에 `change`가 있어 응답을 잃은 자동 저장 뒤 `Ctrl+S`가 중복 기록을 만든다 | 만들기 키는 `loupe:c:<초안 UUID>`뿐이다. 같은 키에 다른 내용·귀속이면 `idem_conflict` 대신 409 `version_conflict` + `current`(보일 때만)이고 loupe는 `PUT`으로 잇는다. 예시 키를 모두 고쳤다 | 2.4, 5.1, 5.2, 6.5, 7.3, 7.4, 13.2 N12, FW3 |
| R3-6 (O-N3, Codex) | 키·ID·사유가 격리된다고 적었다(구현과 다르다) | 식별자 칸(멱등 키, ID, 타입, 속성 이름, tombstone 사유, slug)은 모든 통로에서 거절이고 값을 되풀이하지 않는다. 내용 칸(제목, 본문, 속성 값)은 편집기 경로에서 기본 거절이거나 선택 시 격리, 다른 통로에서 격리. 작성자가 만든 다이제스트 칸은 비밀로 보지 않는다. 속성 이름 거절은 아직 코드에 없어 FW3이 옮긴다 | 0장 결정 8, 1장 비밀 탐지 행, 5.1, 5.5, 7.1, 7.2 표, 7.4, 9장 "바뀌는 것"·"바꾸지 않는 것" |
| R3-7 (O-N4) | `GET /v1/writes/{ref}`에 소유 규칙이 없다 | 예약 파일의 `tok_id`가 요청 토큰과 같을 때만 200이다. 다른 토큰, 회전된 토큰, `viewer`, 무토큰, 숨은 대상은 없는 참조와 같은 404 | 2.2, 3.3 "토큰 일련 ID", 5.9 "소유 규칙", FW4 |
| R3-8 (O-N5) | `export_llm=false`일 때 `Topic` 엔티티의 출처와 slug 처리가 없다 | 엔티티는 `origin=first_party`이고 spec과 같은 민감도다. slug는 내보내는 글이라 `export_llm=false`면 외부 LLM과 수집 프로필에 싣지 않고, 식별자라 비밀이면 거절이다 | 6.1 `entity.put`, 6.6 "`Topic` 엔티티와 slug", FW6 |

### 14.2 4회차: 3판 재검토(Opus, Codex는 리드 경유)

| ID | 지적 | 처리 | 위치 |
|---|---|---|---|
| R4-1 (Codex, 같은 주제 두 번째) | 단계별 회계라 단계 밖에 남는 바이트가 샌다. `.failed/` 본문(`src/kb/core/spool.py:83-98`)이 예약을 풀고 디스크에 남는다. 버리기 동작이 정의되지 않았다, 복구가 살아 있는 쓰기와 겹친다(Opus LOW) | 원칙을 바꿨다: 편집기 경로가 디스크에 남긴 바이트는 상태와 상관없이 지울 때까지 센다. `committed`는 원장, 나머지(`pending`, `held`, `failed`, 사본)는 예약 파일로 센다. `failed` 본문은 7일·전체 128 MiB 상한의 purge가 본문과 예약을 함께 처리한다. `dlq`에는 본문을 넣지 않는다. 버리기는 `DELETE /v1/writes/{ref}`. 복구와 purge는 한도 잠금 안 | 2.2, 5.8 "원칙" 표와 1~9번, 5.9 상태 표 `failed`·`purged`, 7.5 `write_in_flight`, FW4 |
| R4-2 (Codex) | 새 기록의 쓰기 참조가 재적재 전 3.4 "존재"에 걸려 404다 | 머리가 없는 대상은 소유(`tok_id`)만으로 판정해 `pending`·`failed`를 준다. 머리가 생기면 3.4를 적용한다 | 3.4 끝 항목, 5.9 "소유 규칙", FW4 |
| R4-3 (Opus) | `sending` 뒤 재시도가 한 예약을 다시 써 이중 과금된다 | 예약 키는 `(호출 ID, 시도 번호)`. `sending` 뒤 재전송은 늘 새 시도이고 새 예약이 세 단위를 다시 지난다 | 6.4 "예약 키", FW6 |
| R4-4 (Opus) | 격리 기록을 CLI로 tombstone하면 tombstone 페이로드에 민감도가 없어 409 `current`가 tombstone 전 본문을 낸다 | 죽은 머리의 3.4 확인은 마지막 `record.put` 판 기준이고, tombstone된 대상의 `current`는 `{version, status}`뿐이다 | 3.4 "죽은 머리", 5.4, 5.5 복원, FW3 |
| R4-5 (Opus) | 서버가 만든 `inbox:api-token-rotation:<sha32>` 같은 키가 거절된다 | 작성기가 만든 키는 호출자가 고른 칸만 검사하고 작성기의 다이제스트 칸은 검사하지 않는다. 호출자가 통째로 고른 식별자는 전부 검사한다. 그래서 loupe 편집 키의 다이제스트 칸을 초안 개정 번호 `r<n>`으로 바꿨다 | 5.1 표와 키 항목, 5.3 예, 7.2 "누가 만든 칸인가", FW3 |
| R4-6 (Opus) | first_party `Topic`은 `export_llm=true`여도 수집기에 보이지 않는다 | `export_llm=true`이고 3.4를 통과하는 spec의 `Topic`만 수집 프로필에 ID, 라벨, `aliases`, `exclude`, `domain`, 상태를 낸다. 다른 칸과 기록은 내지 않는다 | 6.1 `entity.put`, 6.6 "`export_llm=true`일 때", FW6 |

### 14.3 5회차: 4판 재검토(Opus, Codex는 리드 경유)

| ID | 지적 | 처리 | 위치 |
|---|---|---|---|
| R5-1 (Opus) | 두 바이트 규칙이 충돌한다. `failed` 본문을 토큰 하루 32 MB에 넣으면 낡은 판 1 MiB `PUT` 32번이 그 토큰의 모든 쓰기를 7일 동안 429로 막는다 | 예산을 나눴다. (a) 하루 받기 한도는 `committed` + `pending`·`held`만 센다. 실패한 본문은 하루 한도를 막지 않는다. (b) 보유 상한(토큰 64 MiB·200건, 전체 256 MiB·400건)은 디스크에 남은 모든 바이트를 purge까지 센다. 상한에 닿으면 그 토큰의 가장 오래된 `failed`부터 지우고, 지울 것이 없을 때만 503 `spool_full`. Codex의 요구(남은 바이트는 늘 센다)는 (b)가 지킨다 | 5.8 "원칙" 표, 1~9번, "결과", 5.9 상태 표, FW4 |
| R5-2 (Codex) | 존재 오라클: 게이트 경합 중 추측한 만들기 키로 스풀하고 참조를 읽으면 그 ID의 숨은 머리 유무가 드러난다 | 편집기 경로의 만들기 ID는 원장의 비밀 소금과 (actor, 만들기 키)의 HMAC이다(6회차 R6-1이 소금을 없앴다). 다른 actor의 ID를 만들 수 없다. 만들기 참조는 확정 전에는 대상 머리를 읽지 않는다. 재적재 충돌은 보이든 숨었든 같은 `create_conflict`이고 3.4를 계산하지 않는 같은 경로다. 남는 것은 actor가 자기가 만든 기록의 자리를 확인하는 것뿐이고 새로 드러나는 내용이 없다 | 2.3, 3.4 예외 항목, 5.1 "만들기 ID", "스풀된 만들기의 충돌", "남는 것", 5.9 소유 규칙과 상태 표, FW4 |
| R5-3 (Opus) | 7.2의 속성 이름 설명이 낡았고, MCP 키를 통째로 검사한다는 설명이 코드와 다르다 | 실제 규칙을 적었다: 16진수만의 칸은 앞 칸 이름의 마지막 낱말이 비밀값 이름일 때만 검사하고, 작성기(intake, harvest, inbox)가 붙인 꼬리는 늘 뺀다. `api_key:v1:<hex>`는 알려진 놓침이다. 속성 이름은 코드에서 거절한다(`src/kb/write/record.py:50-58`, `:143-144`). R4-5의 "호출자 키는 전부 검사"는 이 규칙으로 바뀐다 | 1장 비밀 탐지 행, 5.1 키 항목, 7.2 "다이제스트 칸 규칙", "속성 이름" |

### 14.4 6회차: 5판 재검토(Opus, Codex는 리드 경유)

| ID | 지적 | 처리 | 위치 |
|---|---|---|---|
| R6-1 (Opus, Codex) | 5회차의 원장 `meta.record_id_salt`는 `kb verify chain`(meta가 재생에서 나온 값과 같아야 한다, `src/kb/core/ledger.py:579-584`)을 깨고, 내보낸 세그먼트로 다시 만든 원장에서 소금을 잃어 같은 키 재시도가 다른 ID로 중복 기록을 만든다. 회전과 복구도 정하지 않았다 | 소금을 없앴다(리드 결정). 만들기 ID는 `kb-record-id-editor-v1` 접두사와 (actor, 만들기 키)의 평범한 SHA-256이다. `actor`는 서버가 토큰에서 정하므로 비밀 없이도 다른 앱이 A의 이름공간에 ID를 만들 수 없다. 저장하는 비밀이 없어 검증, 백업, 회전, 복구할 것이 없다 | 5.1 "만들기 ID", 2.3, FW3 |
| R6-2 (Codex) | 멱등 조회가 전역이라(`src/kb/core/ledger.py:232-239`) A가 쓴 키 K를 B가 보내면 충돌하고 K가 쓰였다는 것이 드러난다 | 편집기 경로는 실효 키 `h\0<actor>\0<키>`로 저장하고 찾는다. 원장 조회 코드는 바꾸지 않는다. 다른 통로의 키는 그대로이고, 모든 통로에서 NUL 든 키를 400으로 막아 두 형식이 겹치지 않는다. FW3 시험 `test_idem_namespace.py` | 5.1 "멱등 키도 actor 이름공간이다", FW3 |
| R6-3 | 스풀된 만들기 충돌과 남는 신호 | 그대로 둔다: 충돌은 늘 `create_conflict`이고 3.4를 계산하지 않는다. 남는 신호는 actor가 자기 ID에 대해 아는 것뿐이고, 다른 actor는 같은 키를 보내도 다른 실효 키와 다른 ID가 된다 | 5.1 "스풀된 만들기의 충돌", "남는 것" |
| R6-4 (Opus LOW) | 7.2가 스캐너가 `source_path`를 읽는다고 적었다(낡음) | 지금 `scan_record`는 경로 허용 목록을 쓰지 않고 `source_path`를 읽지 않는다고 고쳤다. 편집기 경로의 400은 두 번째 막으로 남는다 | 1장 `source_path` 행, 7.2 "경로 힌트 거절" |
| R6-5 (Codex LOW) | NUL 키 400 규칙이 이미 NUL이 든 키의 재전송을 바꾼다 | 저장된 이벤트는 그대로이고 재전송만 400이다. 운영 원장 읽기 전용 조회: 이벤트 38,485건 중 NUL 키 0건(2026-11-04) | 5.1 "멱등 키도 actor 이름공간이다" |
| R6-6 (Opus LOW) | 라벨은 살아 있는 토큰 사이에서만 유일해, 폐기된 라벨을 다시 쓴 새 토큰이 같은 actor 이름공간을 이어받는다 | 같은 앱의 후속 토큰이고 다른 앱으로 새지 않으므로 받아들인다. 쓰기 참조는 `tok_id`로 묶여 이어받지 않는다 | 3.3 "라벨" |

### 14.5 7회차: 사용자 결정 반영(2026-11-04)

검토 지적이 아니라 사용자 답으로 바뀐 곳이다.

| ID | 사용자 답 | 처리 | 위치 |
|---|---|---|---|
| U7-1 | "전체 승인 (Recommended)" | 상태를 승인으로 바꾸고, 열린 질문 가운데 기본값이 있는 것은 그 값으로 확정했다 | 상태 줄, 12장 |
| U7-2 | "private 전면 개방" | `editor`·`reviewer`만 `private`를 읽고 쓴다. MCP, 에이전트, 다른 HTTP 범위는 계속 못 본다. `private`는 외부 LLM과 외부 검색에 가지 않는다. 당시 낮추기는 HITL로 제안했다. `secret`·격리는 그 위. 당시 타입별 기본 제안은 8판의 모든 새 기록 기본 `private`와 사용자 동작으로 대체했다 | 0장 결정 9, 3.1, 3.2 약속 5, 3.4, 3.6, 4.2, 7.5, 8장, FW4 |
| U7-3 | "HITL 적용해야 하는 항목들이 있고, 내가 방향만 제시했을 때, 알아내는 정보들은 굳이 HITL할 필요가 없어보이는데?" | 방향만 준 연구 결과는 자동. 당시 제안한 H1~H6 고정 목록은 8판의 미해결 신호 규칙으로 대체했다. 해결은 `reviewer` 범위와 동작마다의 WebAuthn 사용자 확인으로만 들어온다. 해결은 주장을 고치지 않고 보류·상태만 `user:sagae` 귀속으로 푼다 | 0장 결정 13, 2.2, 3.1, 3.2, 6.5, 6.8, 7.5, FW9 |
| U7-4 | "내보냄 (Recommended)" | `export_query` 기본 `true` 유지, `private` spec만 `false` 고정 | 6.6, 3.6, 12장 |

### 14.6 8회차: 추가 사용자 결정과 7판 Codex HIGH 반영(2026-11-04)

사용자 답 두 건은 질문 도구의 직접 답으로 승인됐다. 나머지 네 건은 7판(`3709306`) 검토 지적이며, 아래 위치는 8판 본문의 줄이다. 구현과 시험은 FW에서 수행하고 이 판에서는 문서만 수정했다.

| ID | 결정·지적 | 처리 | 본문 위치 |
|---|---|---|---|
| U8-A1 | HITL 답: "의도가 명확하지 않다고 판단할때가 맞을 듯." | 고정 항목을 미해결 신호 규칙으로 대체. 주제 모호성·T.3 밖 소스·결론 없는 생존 근거·함의 판정 미해결 보류만 올리고 나머지 연구 결과는 자동. 사용자 공개·해제 동작과 분리하고 둘 다 B1 증명 | 6.8 L781~808 (미해결 신호·사용자 동작·사람 증명), FW9 L989 |
| U8-A2 | 모든 새 기록 기본 `private`, 메모를 LLM 정제 후 지식베이스에 반영 | 기본값 확정, 정제 결과의 `internal` Note/Page와 정상 게이트의 주장 후보, PROMOTED_FROM, 원본 private 유지, 공개 결과 해시에 묶인 사람 증명. 외부 정제 엔진의 후속 사용자 승인은 아래 U8-A3와 12장에 반영 | 3.6 L275, 5.10 L614~622, 6.8 L797, 12장 L1038, FW9 L989 |
| R8-B1 (HIGH) | 같은 UID가 0600 reviewer 파일을 자기 키로 교체 | root 소유 파일·디렉터리를 신뢰 닻으로 고정, 특권 등록/폐기, 쓰기 가능/교체 시 HITL·사용자 동작 차단과 meta 보고, writer VM 이전 및 잔여 위험 명시 | 6.8 L797~806, FW9 L989 |
| R8-B2 (HIGH) | Note를 private로 높여도 옛 파생 주장·복사 근거가 internal로 남음 | first_party 원본 최대 민감도, 기존 파생물 재투영, 완료 전부터 모든 읽기 경로에서 숨김, FW5 회귀 시험 | 3.6 L272, 5.10 L621, FW5 L984 |
| R8-B3 (HIGH) | private 주제 slug가 internal 티켓을 통해 일반 목록·검색에 노출 | 티켓·주제·실행 메타데이터는 spec 민감도 상속, 처음부터 internal 노드 금지, 기존 실행도 동기화, private export_query false 고정, FW6 회귀 시험 | 3.6 L271, 6.1 L662~663, 6.3 L687, FW6 L985 |
| R8-B4 (HIGH) | 민감도 생략 승격으로 internal spec·외부 검색 생성 | 승격은 원본 민감도 상속, 낮은 값 거절, declassify/publish와 B1 증명만 하향 허용, FW6 회귀 시험 | 3.6 L274, 5.7 L516, 5.10 L614~622, FW6 L985 |
| U8-A3 (추가 승인) | 질문 도구 답(2026-11-04): "버튼 누르면 외부 허용". 추가 사용자 지시 원문: "로컬 llm은 굳이 외부 api를 돌릴 필요 없는 케이스에 대해서 토큰 절약으로 접근되길 원함." | 당시 publish 단추의 외부 동의 해석은 9판 추가 보완의 전송 전 WebAuthn 검증으로 구체화했다. 토큰 POST만으로는 전송하지 않는다. KB가 외부 API 필요성을 먼저 판단: 짧고 단순한 메모·서식 정리·노트 분할·별칭 추출은 토큰 절약용 로컬 sLLM, 길거나 추론이 많은 정제는 ADR-0004 E1/D5 예산과 수락 결과당 비용·품질로 외부 엔진 선택. 로컬은 publish의 프라이버시 기본값·대체 전용이 아니며, 외부 엔진 없음·예산 소진 시 대체도 유지. 다른 private 기록·링크된 private 제목 전송 금지, WebAuthn 결과 확인 전 후보 private 유지, 엔진 provenance 기록. private 외부 전송은 publish만 예외, 12장 질문 종결 | 0장 결정 9·14, 3.6, 5.10, 12장, FW9 |

### 14.7 9회차: loupe 구현 대조 질문 Q1~Q14(2026-11-04)

기준은 8판(`b82f5d3`)이며 loupe 검토 문서 2장의 질문과 리드 결정을 본문 규칙으로 반영했다. 아래 줄은 9판 본문이다. `Note`의 미지 키 허용은 실제 스키마를 따르는 Q5의 허용된 분기이며 Page 사용자 속성도 유지한다. Q9는 이전 URL 금지의 좁은 예외를 명시한다. 8판 후속 사용자 결정인 publish 외부 정제 허용은 유지하고, 14.8에서 전송 전 WebAuthn 동의를 필수로 보완한다. Q8 호출 수 하드 상한은 담당과 미배포 조건을 둔 미결 항목이다.

| ID | 질문 | 규칙·처리 | 본문 위치 |
|---|---|---|---|
| R9-Q1 | 비밀 규칙 공개·브라우저 검사 | FW1의 버전·해시·합성 벡터 계약, 선택 사전 검사, 권위 있는 서버 검사와 무저장·무반향 dry-run | 7.7 L989~995 |
| R9-Q2 | 소켓 private 읽기 | 인증된 editor/reviewer는 모든 편집기 읽기에서 private, 무토큰은 internal 이하, 잘못된 토큰은 401 | 3.3 L223, 8장 L1017 |
| R9-Q3 | 두 토큰의 발급·보관·선택 | 범위 하나씩 두 토큰·두 파일, KB TTY 한 번 출력, loupe가 경로 선택, reviewer 경로 고정 | 3.3 L226~227 |
| R9-Q4 | WebAuthn RP ID/origin | localhost와 명시한 loopback origin, RP별 허용 목록, 추가는 특권 단계와 RP별 재등록, resolve 교차 검사 | 6.8 L832~836, 8.1 L1022~1038 |
| R9-Q5 | Note.props와 미지 키 | title_locked 불리언, Note 스키마와 Page의 추가 속성 유지, TopicSpec/Review 미지 키 400 | 4.2 L302~307 |
| R9-Q6 | slug 생략 | spec ID 해시의 결정적 ASCII slug, 한국어 라벨 유지, 충돌은 slug_taken | 4.2 L308 |
| R9-Q7 | 비동기 publish 준비 | 202/action_id, reviewer poll, 네 상태·엔진·비용·시간, 준비 120초·확인 15분 | 5.10 L624~646 |
| R9-Q8 | K-c/K-d의 근거와 시험 | ADR-0004 정확한 절·줄과 기존 시험 연결. 연구별 호출 수 하드 상한은 FW6/E1/D5 미결, 배포 전 해당 경로 닫음 | 6.9 L845~851 |
| R9-Q9 | 틀림 제보 | Review verdict reject·note·선택 props.source_url, 자동 재검증 티켓과 리뷰 목록, 직접 숨김 없음 | 4.2 L305, 6.5 L781~785 |
| R9-Q10 | private 연구의 발견 범위 | 등록 소스와 로컬 처리만, 외부 질의/LLM 금지, narrowed와 이유 보고 | 6.3 L732, 6.6 L803 |
| R9-Q11 | 휴지통 | status=dead, editor의 created_app만, 마지막 put의 민감도·숨김 규칙 유지 | 8장 L1018 |
| R9-Q12 | 실패 초안 본문 회수 | 발급 tok_id의 include=body만, purge 뒤 410 content_removed, 숨은 대상은 404 우선 | 5.9 L611~613 |
| R9-Q13 | 단일 meta.write | 8.1에 fp_gate·editor_routes·private_open·hitl·secret_rules를 한 번 정의 | 8.1 L1022~1038 |
| R9-Q14 | 부록 A 번호 | 검토판 A1~A14에 맞춤, A11 긴 본문·A12 라벨 링크·A13 fp_open·A14 멱등 | 13.2 L1143~1177 |

### 14.8 9회차 추가 보완: 외부 전송 동의와 로컬 origin 잔여 위험(2026-11-04)

9판 재검토의 BLOCK 두 건을 보완했다. 외부 정제 허용이라는 사용자 결정은 유지하되, 사람이 동의했다는 증명은 전송 전에 검증하고 결과 공개 확인과 분리한다. 구현·시험 및 보완 후 재검토는 아직 하지 않았다.

| ID | 지적 | 처리 | 본문 위치 |
|---|---|---|---|
| R9-AH1 (HIGH) | reviewer 토큰 POST만으로 private 외부 정제가 사람 증명보다 먼저 실행됨 | 토큰 준비는 로컬만. 메모 ID·판·실제 전송 payload 해시·publish_external_refine에 묶인 첫 WebAuthn 동의 검증 후에만 외부 전송. 없으면 로컬/명확한 중단 상태, 결과 internal 공개는 별도 두 번째 확인. 사용자 동의 인용을 첫 단계에 대응 | 3.6 L275, 5.10 L624~646, 6.8 L828~837, 오류 L959, 12장 L1110 |
| R9-AM1 (MEDIUM) | 중지 중 localhost 포트 탈취로 같은 origin에서 초안 읽기·WebAuthn 유도 가능 | 유효한 challenge는 loupe serve의 reviewer 토큰 필수. 같은 UID의 토큰·브라우저 프로필 접근은 보장 밖인 수용 위험. loupe의 포트 점유 시 시작 거부·초안 전 serve identity 확인은 권고이며, 이후 HTTPS RP ID의 완화 범위도 명시 | 5.8 L537, 6.8 L835, L840~841 |
