# 선행 시스템과 최신 연구 동향

- 작성일: 2026-10-31
- 문서 성격: 시스템 설계 입력 문서. 지식 데이터가 아니므로 CLAUDE.md 지침 5의 금지 대상이 아니다.
- 목표: 직접 만들어야 하는 영역을 얇게 줄인다.

## 1. 핵심 결론

**질문 1. 출처 보존, 그래프, 시간성, MCP 반환, 지속 수집을 통째로 충족하는 기존 프로젝트가 있는가?**

없다. 다섯 가지를 모두 표방하는 프로젝트는 GBrain과 LongMemory 둘뿐이고, 둘 다 이 환경과 요구사항에서는 빈틈이 있다.

- **GBrain**: 키리스 실측에서 출처 반환, 명시적 대체(`--replaces`), MCP가 동작했다. 지속 수집 쪽은 git 동기화와 cron 사이클이 있지만 범용 웹·RSS·YouTube 수집기는 README에서 확인되지 않았다. 표면적이 매우 크고(full 162 도구) 판단 생성 기능이 많아 지침 5에 맞게 잘라내야 한다. [T8]
- **LongMemory**: 서류상 가장 가깝지만 README가 설명하는 재작성본은 미배포다. npm `1.3.3`은 재작성 전 코드다. 결정적 파서가 한국어 주장을 잘못 분류해 한국어 대체가 실패했다. 커넥터는 있으나 스케줄러는 없다. [T2]
- 나머지는 부분 충족이다. Graphiti는 시간성, Basic Memory는 Markdown 원본과 무-LLM 쓰기, Hindsight는 구독 기반 추출과 근거 추적, Cognee는 출처 원장과 충돌 검토, OpenViking은 소스별 watch가 강점이다.

**질문 2. LLM API 키 없이 쓸 수 있는가?**

쓸 수 있다. 경로는 세 가지다 (6절).

1. 서버는 저장만 하고 추출은 Claude Code 에이전트가 맡는다. Basic Memory, GBrain, MemPalace KG, Cognee `add_data_points`에서 실측으로 확인했다.
2. 구독 로그인 CLI를 LLM으로 연결한다. Hindsight `claude-code`, GBrain `claude-cli`가 이 방식이다. `claude -p`로 한국어 구조화 추출이 호출당 5~7초에 성공했다. [T7]
3. 로컬 소형 모델을 쓴다. Cognee GLiNER는 프로젝트가 스스로 demo라고 부르며, Graphiti GLiNER2는 엔티티 추출만 대체한다.

Graphiti처럼 쓰기마다 LLM을 여러 번 부르는 구조는 호출당 수 초가 곱해진다. 정책 문서가 전제하는 사용량은 "ordinary, individual usage"다. 지속 수집을 구독 호출에 얹을 때의 상한은 설계 시 별도 검토 대상이다. [S3]

**직접 만들어야 하는 얇은 영역 (10절)**

| 영역 | 이유 |
|---|---|
| 소스 단위 수집 운영(주기, 재시도, 사멸 감지) | 가장 가까운 OpenViking watch도 재시도·백오프·사멸 감지가 문서에 없고 모델 자격 증명을 요구한다. 시간형 그래프를 함께 갖춘 후보는 없다 [S36] |
| 저장 전 결정적 인용 검증 게이트 | 최상위 모델도 인용 링크는 94% 이상 유효하지만 주장의 사실 정확도는 39~77%다 [P10] |
| 한국어 대체 키 정규화 | 결정적 파서가 한국어에서 실패했다 [T2] |
| 외부 수집 데이터의 오염 경계 | 백그라운드 수집이 장기 기억 오염 경로로 측정됐다 [P14] |

## 2. 조사 방법과 표기

- `[S번호]`, `[P번호]`는 13절 출처 표의 항목이다. 표에 URL과 확인일이 있다.
- `[T번호]`는 5절 실측 기록이다.
- 증거 등급: **실측**(이번에 실행), **코드**(저장소 소스를 읽음), **문서**(공식 문서·README), **메타**(레지스트리·GitHub API 값만 확인).
- 사전 지식은 쓰지 않았다. 후보 메타데이터는 `gh api repos/<repo>`, `gh api repos/<repo>/releases/latest`, PyPI JSON, npm registry로 2026-10-31에 조회했다.
- GitHub 스타 수는 관심도일 뿐 품질 근거가 아니다. 2026년에 생긴 저장소 다수가 수만 스타를 기록하고 있어 그대로 신뢰하지 않았다.
- 벤더 작성 비교 글은 판단 근거에서 제외했다. 벤더 자체 벤치마크는 자체 보고임을 표시했다.

실측 환경과 격리:

- WSL2 Linux 6.18, 24 CPU, RAM 30GB, RTX 4080 SUPER 16GB. Python 3.13.18(uv), Node 26.13.0, Bun 1.4.4, Claude Code 2.1.314.
- 각 후보를 전용 venv와 격리된 `HOME`에서 실행했다. 내려받은 소스는 전용 디렉터리에 두고 Python은 `-I`로 실행했다.
- GPU와 로컬 LLM은 측정에 쓰지 않았다. 임베딩은 CPU다.
- `/tmp`가 16GB tmpfs이고 병렬 작업이 공유한다. 이 때문에 GLiNER 경로와 `cognee-mcp`는 측정하지 못했다. 처리량 수치는 다른 작업과 CPU를 공유한 상태의 값이다.

## 3. 후보 표

모든 행의 확인일은 2026-10-31이다. 유지보수 상태의 날짜는 GitHub `pushed_at`이다. 이슈 수는 `open_issues_count`로 열린 PR을 포함한다.

### 3.1 실측 후보

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| [GBrain](https://github.com/garrytan/gbrain) | v0.60.524.0 (측정은 HEAD 0.60.525.0) | 2026-10-31 | 매우 활발. 10-31 push, 일 단위 릴리스, ★31.4K, 이슈 845 | MIT | 높음. Bun 있음, PGLite로 Docker 불필요, 키리스 쓰기·검색·MCP 통과 | `autopilot --install`이 cron/systemd를 변경. npm 미배포. 임베딩 별도 프로바이더 필요. full 표면 156KB. 범용 웹·RSS 수집기 미확인 |
| [Hindsight](https://github.com/vectorize-io/hindsight) | v1.1.0 | 2026-10-21 | 매우 활발. 10-31 push, ★56.7K, 이슈 163 | MIT | 높음. pg0 임베디드 Postgres, ONNX 임베딩, 구독 프로바이더 | venv 1.1GB. MCP는 HTTP 전용이고 목록 69KB. `none` 모드는 청크 저장뿐. 소스 수집기 없음 |
| [Cognee](https://github.com/topoteretes/cognee) | v1.6.6, cognee-mcp 0.5.7(10-08) | 2026-10-29 | 매우 활발. 10-30 push, ★32.9K, 이슈 1067 | Apache-2.0 | 중상. SQLite, LanceDB, Ladybug 임베디드 | 기본 venv 1.2GB. GLiNER 경로는 torch 필요. `add_data_points` 데이터가 `recall`에 안 보임. 기본 임베딩 영어 모델 |
| [Graphiti](https://github.com/getzep/graphiti) | v0.31.2, MCP 1.1.3 | 2026-10-20 | 활발. 10-28 push, ★32.4K, 이슈 532 | Apache-2.0 | 중. falkordblite로 Docker 없이 라이브러리 구동 | 쓰기마다 LLM 필요. 구독 연결은 `LLMClient` 서브클래스 작성 필요. MCP는 참조 구현이며 URI 접속 방식. 신규 설치 시 `httpx` 누락 |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | v1.0.0 | 2026-10-29 | 활발. 10-30 push, ★4.4K, 이슈 83 | AGPL-3.0 | 높음. LLM 불필요, Markdown 원본, SQLite, MCP stdio | 임베딩 켠 대량 인덱싱이 느림. 기본 임베딩 영어 모델. 트랜잭션 시간축 없음. 수집기 없음 |
| [LongMemory](https://github.com/CaviraOSS/LongMemory) (구 CaviraOSS OpenMemory) | HEAD `8badf44` 미배포. npm 1.3.3, GitHub v1.3.0 | HEAD 10-18, npm 08-31, GitHub 2025-12-20 | 활발하나 1인 중심(nullure 198커밋), ★4.6K, 이슈 5 | Apache-2.0 | 서류 최상, 실측 중간 | 재작성본 미배포. 한국어 자동 대체 실패. MCP ingest에 유효시간 없음. 스케줄러 없음 |
| [MemPalace](https://github.com/MemPalace/mempalace) | v3.11.0 (repo 3.12.0) | 2026-10-14 | 활발. 10-31 push, ★60.2K, 이슈 818 | MIT | 중상. 시간형 KG 부품으로 유효 | 대화 기록 보관이 본업. `query_entity`가 `source_file`을 반환하지 않음. 벤치마크 정정 이력 [S14] |
| [local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp) | v2.4.3 | 2026-08-19 | 소규모. 10-30 push, ★15, 이슈 1 | MIT | 미평가. MCP 표면만 확인 | tmpfs 부족으로 기능 실측 못함 |

### 3.2 코드·문서 검토 후보

| 후보 | 최신 버전 | 릴리스 날짜 | 유지보수 상태 | 라이선스 | 이 환경 적합성 | 차단 요인 |
|---|---|---|---|---|---|---|
| [claude-mem](https://github.com/thedotmack/claude-mem) | v15.7.0 | 2026-10-30 | 매우 활발. ★106.6K, 이슈 140 | Apache-2.0 | 낮음. 코딩 세션 관찰 기록용 | 외부 소스 지식베이스가 아님. 설치가 `~/.claude`를 변경해 실행 금지 대상. 코드만 읽음 |
| [Graphify](https://github.com/Graphify-Labs/graphify) | v0.9.99 | 2026-10-30 | 매우 활발. ★139.6K, 이슈 1644 | Apache-2.0 | 낮음~중. 코드 그래프 중심 | 시간 모델 없음. 헤드리스 문서 추출은 API 키 필요 |
| [LightRAG](https://github.com/HKUDS/LightRAG) | v1.5.7 | 2026-09-02 | 활발. 10-29 push, ★40.4K, 이슈 427 | MIT | 중. `ainsert_custom_kg`로 구조 직접 쓰기 | 직접 쓰기는 복구 보장 밖(docstring 경고). 유효시간 없음. README에 MCP 언급 없음 |
| [Microsoft GraphRAG](https://github.com/microsoft/graphrag) | v3.3.0 | 2026-10-08 | 활발. 10-29 push, ★36.5K | MIT | 낮음 | 인덱싱 전 단계 LLM 사용 [S19]. 시간 모델은 공변량 수준. README가 demonstration 코드라고 명시 [S20]. Python <3.14 |
| [Mem0](https://github.com/mem0ai/mem0) | mem0ai 2.2.1 | 2026-09-25 | 활발. 10-30 push, ★68.1K, 이슈 892 | Apache-2.0 | 낮음~중 | ADD-only로 대체 없음 [S16]. 기본 임베딩 OpenAI. `infer=False` 쓰기 경로는 있음(코드) |
| OpenMemory (mem0) | 해당 없음 | 해당 없음 | `mem0ai/mem0` 현재 트리에 `openmemory` 경로 없음(`git/trees/main`) | 해당 없음 | 평가 불가 | 저장소에서 제거 또는 이동, 이동처 미확인 |
| [Letta](https://github.com/letta-ai/letta) | letta-code v0.34.36, PyPI letta 0.34.12 | 2026-10-31 / 10-12 | 개발은 letta-code로 이동, V1 서버는 `archive` 브랜치 [S17] | Apache-2.0 | 낮음. 에이전트 런타임 | 목적 불일치 |
| [OpenViking](https://github.com/volcengine/OpenViking) | v0.5.2.1 | 2026-10-27 | 매우 활발. ★41.2K, 이슈 1170 | AGPL-3.0 | 중. URL·sitemap·RSS 소스별 watch는 후보 중 가장 구체적 | 임베딩 모델과 tool-call 지원 VLM 자격 증명 필요 [S24]. 그래프가 아닌 가상 파일시스템 구조. 시간 유효성 문서 미확인. 미실측 |
| [qmd](https://github.com/tobi/qmd) | v2.8.3 | 2026-08-16 | 활발. 10-15 push, ★30.8K, 이슈 244 | MIT | 중. 검색 부품 | GGUF 모델 다운로드 필요. CJK는 문자 단위 분해 후 구문 질의 [S22] |
| [obsidian-wiki](https://github.com/Ar9av/obsidian-wiki) | v2026.10.4 | 2026-10-27 | 활발. ★3.6K, 이슈 4 | MIT | 중상. LLM Wiki 패턴 구현 | setup이 세션 훅 등록(`--no-hooks`로 회피). 시간 모델 없음 |
| [karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) | 릴리스 없음 | 07-23 push | 보통. ★2.6K, 이슈 10 | MIT | 중. 단일 스킬 | 그래프·시간 모델 없음 |
| [Zep](https://github.com/getzep/zep) | Community Edition 지원 종료 | 해당 없음 | CE는 `legacy/`로 이동 [S8] | Apache-2.0 | 낮음. Cloud 전제 | 자가 호스팅은 Graphiti만 해당 |

### 3.3 메타데이터·README만 확인한 후보

| 후보 | 버전·날짜 | 라이선스 | 메모 |
|---|---|---|---|
| [agentmemory](https://github.com/rohitg00/agentmemory) | v0.9.31, 10-26 | Apache-2.0 | ★30.0K. 키리스 BM25, 54 MCP 도구, iii-engine 런타임 의존 [S30] |
| [Engram](https://github.com/Gentleman-Programming/engram) | v3.6.0, 10-24 | MIT | ★7.7K. Go 단일 바이너리, SQLite+FTS5, 27 MCP 도구 [S31] |
| [supermemory](https://github.com/supermemoryai/supermemory) | server-v0.0.9, 10-12 | MIT | ★31.5K |
| [memU](https://github.com/NevaMind-AI/memU) | v1.5.1, 03-23 | NOASSERTION | ★14.6K, 릴리스 정체 |
| [MemMachine](https://github.com/MemMachine/MemMachine) | v0.4.0, 10-08 | Apache-2.0 | ★3.1K |
| [Memori](https://github.com/MemoriLabs/Memori) | v3.3.6, 05-28 | NOASSERTION | ★17.2K |
| [SimpleMem](https://github.com/aiming-lab/SimpleMem) | v0.3.0, 05-21 | MIT | ★3.9K |
| [SodaMem](https://github.com/SodaMem/SodaMem) | v0.1.1, 08-16 | Apache-2.0 | ★202. 근거 기반 시간 그래프 연구 구현 [P4] |
| [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | v12.4.0, 10-26 | Apache-2.0 | ★2.1K |
| [memvid](https://github.com/memvid/memvid) | v2.0.140, 05-27 | Apache-2.0 | ★17.3K |
| [khoj](https://github.com/khoj-ai/khoj) | 2.0.0-beta.28, 03-26 | AGPL-3.0 | ★37.9K, 08-02 이후 push 없음 |
| [beads](https://github.com/gastownhall/beads) | v1.3.2, 10-24 | MIT | ★28.3K. 이슈 추적 성격, 지식베이스 아님 |
| [TrustGraph](https://github.com/trustgraph-ai/trustgraph) | v2.8.17, 09-08 | Apache-2.0 | ★2.9K |
| [CocoIndex](https://github.com/cocoindex-io/cocoindex) | v1.0.26, 10-22 | Apache-2.0 | ★11.8K. 증분 처리 ETL 엔진 [S32] |
| [LangExtract](https://github.com/google/langextract) | v1.7.1, 10-08 | Apache-2.0 | ★39.2K. 문자 오프셋 근거 정렬 [S28] |
| [llm-graph-builder](https://github.com/neo4j-labs/llm-graph-builder) | v0.8.7, 07-23 | Apache-2.0 | Neo4j 전제 |
| [neo4j-graphrag-python](https://github.com/neo4j/neo4j-graphrag-python) | 1.23.0, 10-28 | NOASSERTION | Neo4j 전제 |
| [nano-graphrag](https://github.com/gusye1234/nano-graphrag) | v0.0.8, 2024-10-01 | MIT | 릴리스 정체 |
| [fast-graphrag](https://github.com/circlemind-ai/fast-graphrag) | 릴리스 없음 | MIT | 2025-11-01 이후 push 없음 |
| [HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG) | v1.0.0, 2025-02-27 | MIT | 연구 구현 |
| [RAGFlow](https://github.com/infiniflow/ragflow) | v1.0.0-rc3, 10-30 | Apache-2.0 | ★93.2K, 서비스형 RAG |
| [kg-gen](https://github.com/stair-lab/kg-gen) | 태그만 | 없음 | 2026-03-24 이후 push 없음 |
| [byterover-cli](https://github.com/campfirein/byterover-cli) | v3.16.1, 05-27 | NOASSERTION | 저장소 archived |
| [obsidian-skills](https://github.com/kepano/obsidian-skills) | 릴리스 없음, 09-15 push | MIT | ★50.5K. Obsidian용 Agent Skills [S33] |
| [mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) | 릴리스 없음, 08-31 push | MIT | ★4.5K. Obsidian 앱 연동 전제 |
| [claude_memory](https://github.com/codenamev/claude_memory) | v0.13.2, 06-27 | MIT | ★27. Ruby |
| [claude-brain](https://github.com/mikeadolan/claude-brain) | v0.3.1, 05-27 | MIT | ★38 |

## 4. 요구사항 충족 매트릭스

셀의 앞 단어가 증거 등급이다.

| 후보 | 출처 보존 | 그래프 | 시간성 | MCP 반환 | 지속 수집 | 서버측 LLM 없는 쓰기 | 한국어 |
|---|---|---|---|---|---|---|---|
| GBrain | 실측: `provenance`, `trust_tier`, `origin` 반환. 코드: `belief_events` 해시 체인 | 코드: 타입 링크, LLM 없는 auto-link, `link_relationships.valid_ranges` | 실측: `--replaces`가 `expired_at`, `superseded_by` 설정. 키리스 자동 모순 감지는 없음 | 실측: stdio 8 또는 162 도구 | 코드: `sync --watch`, autopilot, cycle. 범용 웹·RSS 미확인 | 실측 | 실측: 키워드 검색 동작 |
| Hindsight | 실측: `document_id`, `chunk_id`, `context`. 문서: `source_fact_ids`, `based_on` | 코드: 엔티티·메모리 링크 | 실측: 청크 모드는 `mentioned_at`만이고 시점 질의로 결과 불변. 문서: LLM 모드의 occurred 범위와 관찰 진화 | 실측: HTTP 36 도구 | 문서: mental model 일정 갱신. 소스 수집 없음 | 실측: 청크만 | 실측: 한국어 질의가 한국어 문서를 1위로 |
| Cognee | 코드: edge evidence 기본 켜짐, 해시 체인 원장은 옵트인 | 실측: 타입 DataPoint가 노드·엣지로 저장 | 코드: `conflicts`의 `time_varying`, TEMPORAL 검색 타입 | 코드: 6 도구, 미실측 | 코드: web_scraper의 APScheduler cron, improve 워터마크 | 실측: `add_data_points` | 미측정 |
| Graphiti | 코드·실측: 엣지의 `episodes`, 에피소드 `source_description` | 실측 | 실측: `valid_at`, `invalid_at`, `expired_at` 양시간축 | 코드: 13 도구, 참조 구현 | 없음. 라이브러리 | 실측: `add_triplet`도 LLM 2회 | 미측정 |
| Basic Memory | 문서: `source` 체크섬, OKF `sources`, PDF 페이지 locator | 실측: entity, observation, relation | 실측: `@effective`와 `--valid-at`. 트랜잭션 시간 없음 | 실측: stdio 12 도구 | 코드: 파일 변경 감지, 스킬. 수집기 없음 | 실측: LLM 없음 | 실측: FTS 동작, 기본 임베딩은 영어 |
| LongMemory | 코드: 불변 노드, 해시, `grounded_facts`, `audit_log` | 코드: 불변 엣지. 실측: 2천 건 후 edges=1로 희박 | 실측: 영어 통과, 한국어 실패 | 실측: stdio 13 도구 | 실측: 체크섬 재동기화. 코드: website, sitemap, rss 커넥터. 스케줄러 없음 | 실측 | 실측: 검색은 되나 주장 파싱 실패 |
| MemPalace | 코드: `source_file`, `source_drawer_id` 저장. 실측: 조회 응답에 미포함 | 실측: 트리플 | 실측: `supersede`, `as_of`, `timeline` | 실측: stdio 47 또는 light 3 도구 | 미확인 | 실측 | 실측: 한국어 대체 통과 |
| OpenViking | 문서: 인용 답변, watch의 `source_type` | 없음: 가상 파일시스템 계층 | 미확인 | 문서: MCP 연동 | 문서: `watch_interval`(분), `last_status`, `last_error`, `next_execution_time`, `is_active` | 없음: 모델 자격 증명 전제 | 미측정 |
| LightRAG | 코드: `source_id`, `file_path` | 코드 | 없음 | README 언급 없음 | 없음 | 코드: `ainsert_custom_kg` | 미측정 |
| claude-mem | 코드: 세션 관찰 기록 | 없음 | 코드: 타임라인 | 코드: search, timeline 등 | 코드: 훅 기반 세션 캡처만 | 없음: 관찰 추출에 LLM 사용 | 미측정 |

## 5. 실측 기록

### T1. Basic Memory 1.0.0

명령:

```bash
uv pip install 'basic-memory==1.0.0'                # 2.4초, venv 390MB
/usr/bin/time -v bm project add bench <kb2k>        # 합성 코퍼스 2,000 노트, 7.9MB
bm tool search '쇼츠' --mode text --page-size 100 --json
bm tool search '검색량' --mode text --items observation --valid-at 2026-03-01 --json
mcp_probe.py --call bm_search ... -- bm mcp         # 자작 stdio JSON-RPC 프로브
```

코퍼스는 한국어·영어 혼합 노트이고 노트마다 `@effective` 관찰 2개와 위키링크 관계 2개가 있다.

| 항목 | 값 |
|---|---|
| 인덱싱 2,000 노트 | 10분 44.51초, 최대 RSS 1,233,636KB, 종료 코드 0 |
| 조건 | 임베딩을 끄는 설정 키가 거부되어 기본값(fastembed `bge-small-en-v1.5`, batch 2, threads 8)으로 측정. 병렬 작업과 CPU 공유 |
| 결과 행 | entity 2,000, observation 4,000, relation 4,000, memory_time_index 4,000, 벡터 청크 10,000 |
| DB 크기 | 92.7MB |
| CLI 검색 | 호출당 3.8~4.8초(프로세스 시작 포함) |
| MCP | initialize 2.96초, 도구 12개, 목록 32,801바이트, `bm_search` 0.38초 후 0.07초, `bm_context` 0.09초 |
| valid time | `--valid-at 2026-03-01`은 전반기 값, `2026-09-01`은 후반기 값을 정확히 반환 |
| 한국어 FTS | `쇼츠`, `검색량`, `검색`, `월간 검색량`, 조사 포함 부분 문자열 `량은` 모두 100건(페이지 상한), `항목 00042`는 1건 |

### T2. LongMemory HEAD `8badf44`

명령:

```bash
npx pnpm@11.5.2 install --frozen-lockfile     # 9.7초, node_modules 178MB
npx prebuild-install                          # better-sqlite3, Node ABI 147 프리빌드 성공
npx tsc -p tsconfig.json                      # 4.1초
node lm_test.mjs dist/index.js t.db 2000
longmemory connectors add markdown --set root=...
longmemory connectors sync markdown           # 3회: 최초, 무변경, 변경 후
```

| 항목 | 값 |
|---|---|
| 배포 상태 | package.json `1.0.0`, MCP 서버 보고 버전 `0.0.0-phase.27`, CHANGELOG `[Unreleased]`. npm 1.3.3의 dist 구조는 HEAD와 다름 |
| 영어 대체 | strict는 180 seconds만 반환, historical(2024-06)은 60 seconds 반환. 통과 |
| 한국어 자동 대체 | strict가 180초와 60초를 함께 반환. 실패 |
| 한국어 `conflict_behavior: supersede` | 1000명이 500명보다 먼저 반환. 실패 |
| 원인 관찰 | 한국어 주장이 `kind=action, subject=user`로 파싱됨 |
| 처리량 | 2,000건 1.5초, 1,332.7건/초. strict recall p50 48.3ms, p95 65.4ms |
| 그래프 밀도 | nodes 2,004, edges 1 |
| 크기 | DB 18.98MB, RSS 316MB |
| MCP | initialize 0.35초, 도구 13개, 12,633바이트, ingest 0.05초, recall 0.01초 |
| 커넥터 | 무변경 재동기화는 새 노드 0개, 변경 후에는 새 노드 생성, strict recall은 새 내용만 반환 |
| 스케줄 | `sync.ts`에서 schedule, cron, watch, interval 검색 결과 없음. `docs/connectors.md`에서 cron, schedul 검색 결과 없음 |
| YouTube | 커넥터 상태 `starter`, `YOUTUBE_API_KEY` 필요 |

### T3. Graphiti 0.31.2 + falkordblite 0.11.0

스텁 LLM, 스텁 임베더, 스텁 리랭커로 그래프 기계부를 실제로 돌리고 LLM 호출을 계수했다. 스텁은 결정적 답을 돌려주므로 실제 모델의 호출 수와 다를 수 있다.

```bash
uv pip install 'graphiti-core[falkordblite]==0.31.2'
python -I gr_test.py g.db    # AsyncFalkorDB(dbfilename=...) + FalkorDriver
```

| 항목 | 값 |
|---|---|
| 신규 설치 결함 | `ModuleNotFoundError: No module named 'httpx'`. openai 3.42.0이 `httpx2`로 이동했고 graphiti-core는 `httpx`를 선언하지 않음. `httpx` 추가 설치로 해결 |
| 임베디드 기동 | DB와 인덱스 0.12초, Docker 불필요 |
| `add_episode` #1 | LLM 2회, 프롬프트 12,890자 |
| `add_episode` #2(모순) | LLM 3회, 프롬프트 17,187자 |
| 무효화 | 이전 엣지에 `invalid_at=2024-10-15`, `expired_at=현재` 설정 |
| `add_triplet` | LLM 2회(`EdgeDuplicate`, `EdgeTimestamps`), 6,775자 |
| 검색 | 현재 엣지와 무효 엣지를 함께 반환. 기본 필터가 무효 엣지를 빼지 않음 |

### T4. MemPalace 3.11.0

```bash
uv pip install mempalace           # venv 372MB
python -I mp_test.py kg.sqlite3 20000
mcp_probe.py -- python -m mempalace.mcp_server
mcp_probe.py -- mempalace-light-mcp
```

| 항목 | 값 |
|---|---|
| 한국어 `supersede` | 현재는 180초가 `current: true`, `as_of=2024-06-01`은 60초만 반환 |
| 처리량 | 트리플 20,000개 24.56초, 814개/초 |
| 조회 | p50 0.01ms, p95 0.01ms |
| DB | 9.6MB |
| 출처 | `source_file`을 넣어도 `query_entity` 응답에는 없음 |
| MCP | 47 도구 35,904바이트, light 3 도구 10,239바이트 |

### T5. Cognee 1.6.6

에이전트가 추출을 끝낸 상황을 가정해 타입 있는 `DataPoint`(Claim, Topic, Source)를 직접 썼다.

```bash
uv pip install 'cognee==1.6.6'     # venv 1.2GB
python -I cg_test.py <root> 1000
```

| 항목 | 값 |
|---|---|
| `add_data_points` | 주장 1,000개, 46.1초, 21.7건/초(로컬 임베딩, 모델 67MB 내려받기 포함) |
| 그래프 | 노드 2,020, 엣지 2,000 |
| 멱등성 | 동일 50건 재적재 2.6초, 노드 수 불변 |
| `recall` | `memory_warming_up`, readiness `never_built`. 저수준 쓰기가 고수준 조회에 보이지 않음 |
| 미측정 | GLiNER 키리스 경로(torch, 모델 약 750MB), cognee-mcp |

### T6. Hindsight 1.1.0

```bash
uv pip install 'hindsight-api-slim[embedded-db,local-onnx]==1.1.0'   # venv 1.1GB
HINDSIGHT_API_LLM_PROVIDER=none HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx \
HINDSIGHT_API_RERANKER_PROVIDER=rrf HINDSIGHT_API_DATABASE_URL=pg0://bench hindsight-api
python -I hs_test.py http://127.0.0.1:18888 bench 500
```

| 항목 | 값 |
|---|---|
| 기동 | health 200까지 약 16초 |
| 저장 | 500건 동기 4.2초, 118.3건/초, 토큰 사용 0 |
| 조회 | p50 42ms, p95 46ms |
| 출처 필드 | `context`, `document_id`, `chunk_id`, `mentioned_at` |
| 시간성 | `query_timestamp=2024-06-01`을 줘도 결과 불변. 청크 모드는 대체 없음 |
| 한국어 | 문서 3개 표본에서 `쇼츠 최대 길이` 질의가 한국어 문서를 1위로 반환(영어 임베딩 모델 사용). 동작 확인 수준 |
| MCP | HTTP `/mcp/{bank}/`, 36 도구, 69,157바이트 |

### T7. `claude -p` 구조화 추출

인증은 claude.ai Max 로그인이고 `ANTHROPIC_*` 환경변수는 없다. 문서 1개(한국어 약 120자)에서 엔티티와 주장을 JSON 스키마로 추출했다.

```bash
claude -p "$PROMPT" --model haiku --output-format json --json-schema "$SCHEMA" \
  --no-session-persistence --tools "" --setting-sources "" --strict-mcp-config --max-budget-usd 0.5
```

| 모델 | 벽시계 | CLI 보고 비용 | 주장 수 | 근거 인용 원문 일치 |
|---|---|---|---|---|
| haiku 1회 | 6.9초 | $0.00165 | 측정 안 함(출력을 2회차가 덮어씀) | 측정 안 함 |
| haiku 2회(캐시 적중) | 6.8초 | $0.00085 | 5 | 5/5 |
| sonnet | 5.1초 | $0.0202 | 4 | 4/4 |

- 표본이 문서 1개이므로 품질 지표가 아니라 동작 확인이다.
- 보고 비용은 CLI가 계산한 값이며 구독 로그인 실행의 실제 청구액이 아니다.
- `--json-schema`가 이 버전에서 동작했다. GBrain 문서의 "CLI가 JSON 스키마를 실을 수 없다"는 설명은 Claude Code 2.1.314에는 맞지 않는다.
- `--bare`는 도움말상 OAuth를 읽지 않으므로 구독 로그인과 함께 쓸 수 없다.
- `CLAUDE_CONFIG_DIR=<임시> CLAUDE_SECURESTORAGE_CONFIG_DIR=""`로 호출해도 이 환경에서 로그인이 유지됐다(3.1초). Hindsight `claude-code` 프로바이더의 격리 방식과 같다.

### T8. GBrain HEAD `7544cc0`

```bash
bun install --frozen-lockfile --ignore-scripts      # 0.9초, 283 패키지, 254MB
bun run src/cli.ts init --pglite --no-embedding     # 5.2초, 48MB
gbrain remember "유튜브 쇼츠 최대 길이는 60초다" --entity products/youtube-shorts --provenance https://example.com/s1 --json
gbrain remember "..." --replaces 1 --valid-from 2024-10-15T00:00:00Z --provenance https://example.com/s3 --json
gbrain import kb300 --no-embed
mcp_probe.py -- gbrain serve --surface starter --advertise verbs
```

| 항목 | 값 |
|---|---|
| 자동 모순 | 키리스에서는 60초와 180초가 공존, `superseded_by=null`. `degraded_dedup` 안내 반환 |
| 명시적 대체 | `--replaces 1` 후 id 1에 `expired_at` 설정, `superseded_by=36`, 기본 recall에서 제외 |
| 가져오기 | 300 노트 6.2초, 약 48노트/초 |
| 키워드 검색 | 한국어·혼합 6개 질의 모두 20건(기본 상한), CLI 호출당 약 660ms. 재현율은 측정하지 않음 |
| MCP starter | 8 도구, 5,105바이트, `remember` 0.47초, `recall` 0.09초 |
| MCP full | 162 도구, 156,236바이트 |

### T9. local-memory-mcp 2.4.3

MCP initialize 0.14초, 25 도구, 13,518바이트. npm 설치 중 tmpfs 공간 부족이 발생해 기능은 측정하지 않았다.

### MCP 목록 크기 비교

| 서버 | 도구 수 | tools/list 바이트 |
|---|---:|---:|
| GBrain starter | 8 | 5,105 |
| MemPalace light | 3 | 10,239 |
| LongMemory | 13 | 12,633 |
| local-memory-mcp | 25 | 13,518 |
| Basic Memory | 12 | 32,801 |
| MemPalace | 47 | 35,904 |
| Hindsight | 36 | 69,157 |
| GBrain full | 162 | 156,236 |

## 6. LLM API 키 없이 쓰는 경로

### 6.1 세 가지 패턴

| 패턴 | 프로젝트 | 증거 | 한계 |
|---|---|---|---|
| 에이전트 추출 + 결정적 저장 | Basic Memory, GBrain `remember`, MemPalace `kg_add`, Cognee `add_data_points`, LightRAG `ainsert_custom_kg`, Mem0 `infer=False`, LongMemory import plan | 실측 4건, 코드 3건 | 모순 판단과 대체 지정은 호출자 몫 |
| 구독 CLI를 LLM으로 사용 | Hindsight `claude-code`, GBrain `claude-cli`, claude-mem 기본 프로바이더 | T7 실측, 나머지 코드·문서 | 호출당 수 초, 구독 한도 소비, 훅 재귀 위험 |
| 로컬 소형 모델 | Cognee GLiNER, Graphiti GLiNER2 | 문서·코드 | Cognee는 demo로 명시, GLiNER2는 엔티티만 처리하고 나머지는 LLM 필요 |

RTX 4080 SUPER로 로컬 LLM을 띄우는 경로도 있으나 Ollama, llama-server가 설치돼 있지 않아 측정하지 않았다. 문서 기준으로 Hindsight는 LLM에, GBrain은 임베딩에 로컬 프로바이더를 지원한다.

### 6.2 호출 비용 감각

단순 곱셈 추정이다. 병렬화와 캐시는 반영하지 않았다.

- 문서당 1회 추출 후 결정적 저장: 호출당 약 6.9초, 문서 1,000개에 약 1.9시간.
- Graphiti식 에피소드당 3회 이상: 문서 1,000개에 약 5.75시간 이상. T3의 프롬프트 크기는 호출당 수천 자 이상이다.

### 6.3 훅 재귀 위험

구독 CLI를 서버에서 부를 때 사용자의 훅과 MCP가 함께 켜지면 재귀가 생긴다. 두 프로젝트가 이미 겪었다.

- Hindsight: 임시 `CLAUDE_CONFIG_DIR`, `setting_sources=[]`, cwd 고정으로 회피한다. 코드 주석이 이슈 #1751, #5542를 언급한다. [S11]
- GBrain: `--tools ''`, `--strict-mcp-config`, `--settings '{"disableAllHooks":true}'`로 회피한다. [S12]

### 6.4 구독 사용의 정책 사실

2차 보도는 서로 충돌해 1차 문서만 옮긴다.

- 지원 문서: 플랜 로그인으로 실행하면 "Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription limits." 6월 15일 예고 변경은 일시 중단됐다. [S2]
- 법적 문서: OAuth는 "ordinary use of Claude Code"를 위한 것이고, 공시된 한도는 "ordinary, individual usage of Claude Code and the Agent SDK"를 전제한다. 제품을 만드는 개발자는 API 키를 쓰라고 안내한다. [S3]
- Max, Ultra, Team 월 크레딧: Max $100, Ultra $200. 연결된 Console 조직의 API 키로만 쓰이고 이월되지 않는다. [S4]
- 문서 불일치: 지원 문서는 크레딧이 API 키로 실행한 `claude -p`를 포함한다고 쓰고 [S2], 플랫폼 문서 표는 Claude Code를 미포함으로 쓴다 [S4]. 실제 범위는 미확인이다.

## 7. 패턴과 내장 기능 메모

**Karpathy LLM Wiki.** 2026-04-04 공개된 gist다. 불변 원천, LLM 소유 위키, 스키마 문서의 3계층에 ingest, query, lint 연산을 둔다. lint가 페이지 간 모순과 새 출처로 대체된 주장을 찾는다. 색인 방식은 약 100개 출처, 수백 페이지 규모까지 잘 동작한다고 쓰고, 그 이상은 qmd 같은 검색을 권한다. 주장 단위 출처와 유효시간 스키마는 없고 의도적으로 추상적이다. [S1]

**Obsidian 기반 구현.** obsidian-wiki는 주장을 `extracted`, `^[inferred]`, `^[ambiguous]`로 표시하고 매니페스트로 변경분만 처리한다. [S25] karpathy-llm-wiki는 ingest, query, lint를 스킬 하나로 묶는다. [S26] 이 계열의 파일 형식은 Obsidian 앱 없이도 쓸 수 있고, Markdown 원본이라 git 이력이 그대로 출처 이력이 된다. 시간 모델과 스케줄은 없다.

**Claude Code 내장 메모리.** CLAUDE.md와 auto memory가 세션마다 로드되고, auto memory는 처음 200줄 또는 25KB까지다. 저장소 단위 작업 기억이지 지식 저장소가 아니다. [S5]

**임베디드 그래프 엔진 변화.** Kuzu는 PyPI 최신이 2025-10-10의 0.11.3이고 Graphiti는 상류 미유지를 이유로 지원을 폐기 예정으로 표시했다. [S6] Cognee는 `ladybug==0.19.0`을 고정해 쓴다. [S9] Graphiti의 임베디드 대안은 falkordblite다.

## 8. 최신 연구

전부 프리프린트이고 동료심사 표시가 있는 항목만 따로 적었다. 수치는 저자 자체 보고다. 초록은 arXiv 페이지에서 확인했고, 이번 조사에서 재현하지 않았다.

### 8.1 Agent memory 비교·측정

| 논문 | 날짜 | 핵심 | 수치 | 주의 |
|---|---|---|---|---|
| Are We Ready For An Agent-Native Memory System? [P3] | 2026-06-23 | 12개 시스템, 5개 워크로드, 11개 데이터셋 비교 | "no single architecture dominates". 지역 유지보수가 전역 재구성보다 비용 효율적 | 코드 공개 |
| Hindsight is 20/20 [P2] | 2025-12-14 | world facts, 경험, 엔티티 요약, 신념의 4계층 | LongMemEval 91.4% | 벤더 저자 |
| Zep [P1] | 2025-01-20 | Graphiti 시간 그래프 | DMR 94.8% | 벤더 저자 |
| RECON [P8] | 2026-07-18 | 변경 사실의 파급을 시험하는 벤치마크 | 최강 비-Oracle 시스템 22.4% | 1인 저자 |
| Memory for Autonomous LLM Agents [P16] | 2026-03-08 | write-manage-read 관점 서베이 | 미해결: 지속 통합, 학습형 망각 등 | 서베이 |

설계에 닿는 관찰: P3은 그래프 기반이 지식 갱신에 가장 안정적이라고 보고하면서, 질의당 지연이 Cognee 116.5초, Zep 155.1초 수준일 때가 있다고 적었다(웹 요약 도구 경유 수치라 원문 대조 필요). RECON은 "바뀐 사실을 찾는가"가 아니라 "그 사실에 의존한 결론을 무효화하는가"를 묻는다. 후자는 현재 시스템이 약한 영역이다.

### 8.2 시간 유효성과 신선도

| 논문 | 날짜 | 핵심 | 수치 | 주의 |
|---|---|---|---|---|
| Temporal Validity in Retrieval Memory, MemStrata [P5] | 2026-06-25 | (주어, 관계, 목적어) 결정적 대체, 양시간 원장, LLM 없음 | 변화 지식 정확도 0.95~1.00 대 RAG 0.20~0.47, 낡은 사실 오류 약 0% | 1인 저자, 7B 모델 |
| Temporal Validity on Real Software Histories [P6] | 2026-08-21 | 실제 GitHub 수정 이력 적용 | 0.91 대 0.57~0.59, RAG 낡은 값 36~38% | 깨끗한 원자 전이는 전체의 약 18%뿐 |
| ChurnBench [P7] | 2026-09-10 | 드리프트 벤치마크 | 스케줄 갱신을 끄면 28일 시점 오류 4건에서 45건으로 증가. 캐시 나이는 예측 변수가 아님 | 합성 환경, 저장소 스타 0 |
| Freshness and the Limits of Heuristic Trend Detection [P9] | 2025-09-20 | 반감기 최신성 사전확률 | Latest@10 0.60 대 0.20 | 매개변수 민감 |
| SodaMem [P4] | 2026-08-08 | 출처, 발생·언급·유효 시간축, 쓰기 시 대체 | LongMemEval-S 92.8%, 질문당 약 $0.0016 | 판독과 채점 모델이 같아 자체 채점 |

설계에 닿는 관찰: 유사도 검색만으로는 낡은 값을 구분하지 못한다는 점에서 논문들이 일치한다. 결정적 대체는 원자적 사실에 강하지만 P6에 따르면 그 범위가 좁다. P7은 신선도가 데이터 나이가 아니라 소스별 갱신 정책에 달렸다고 보고한다. 이는 수집 스케줄러 설계에 직접 연결된다.

### 8.3 주장 검증과 인용 검증

| 논문 | 날짜 | 핵심 | 수치 | 주의 |
|---|---|---|---|---|
| Cited but Not Verified [P10] | 2026-05-07 | 인용 링크, 관련성, 사실성 3축 평가 | 링크 94% 이상, 관련성 80% 이상, 사실 정확도 39~77%. 도구 호출이 2회에서 150회로 늘면 사실성 약 42% 하락(2개 모델) | LLM 판정기 사용 |
| Reference Hallucinations [P11] | 2026-04-03 | URL 22만여 건 측정 | 3~13%가 실존 기록 없음, urlhealth로 비해결 URL 1% 미만으로 감소 | `delip/urlhealth` MIT, PyPI 0.1.0 |
| RT4CHART [P12] | 2026-03-29 | 주장 단위 분해, 함의·모순·근거 없음 분류 | RAGTruth++ F1 0.776, 스팬 F1 47.5% | 지역 처리가 성능 대부분 기여 |
| Claimify [P13] | 2025-02-15 | 주장 추출과 품질 평가 | 모호한 문장은 확신이 높을 때만 추출 | ACL 2025 본회의 |

설계에 닿는 관찰: 검증은 층이 다르다. URL 생존은 결정적으로 확인할 수 있고, 인용문 원문 일치도 결정적으로 확인할 수 있다(T7에서 문자열 포함 검사로 수행). 주장이 근거에 함의되는지는 LLM 판정이 필요하고 정확도가 제한적이다. LangExtract의 `char_interval` 방식은 원문 위치에 정렬되지 않는 추출을 걸러낸다. [S28] Hindsight는 reflect의 `based_on`이 실제 조회한 항목으로 제한되도록 검증한다고 문서화했다. [S11]

### 8.4 기억 오염

| 논문 | 날짜 | 핵심 | 수치 | 주의 |
|---|---|---|---|---|
| Mind Your HEARTBEAT! [P14] | 2026-03-24 | 백그라운드 수집 내용이 장기 기억으로 승격 | 승격률 최대 91%, 세션 간 행동 영향 최대 76%. 프롬프트 주입 없이 일반 오정보로 충분 | 연구용 복제 환경 |
| Long-Term Memory Security Survey [P15] | 2026-04-17 | 수명주기 6단계와 보안 목표 4개 프레임워크 | 출처, 버전, 보존 정책 결합 권고(저자 주장) | EMNLP 2026 채택 표시 |

설계에 닿는 관찰: 지속 수집은 곧 비신뢰 데이터의 지속 유입이다. Graphiti 참조 서버는 프롬프트 주입 방어가 없다고 명시한다. [S7] 저장 데이터를 에이전트 지시로 해석하지 않는 경계가 필요하다.

## 9. 표준과 포맷

**Open Knowledge Format v0.2 (Google Cloud).** Markdown과 YAML frontmatter 디렉터리 형식이다. `type`만 필수이고, `sources`(id, resource, last_modified 등), 각주 기반 주장 단위 귀속, `generated`, `verified`, `status`, `stale_after`를 둔다. 링크는 타입 없는 방향 엣지다. 자체 점수 대신 신뢰 신호를 기록한다는 입장이 지침 5와 맞는다. Basic Memory가 내보내기와 검사를 지원한다. [S29][S10]

**PROV-O 어휘.** Cognee 출처 원장이 entity, activity, agent 필드를 사용한다. 원장 스키마에는 `source_quote`, `source_location`, `valid_from`, `valid_until`, `checksum`, `previous_checksum`, `previous_version_id`가 있어 Claim 모델 설계의 참고가 된다. [S9]

**MEMORY_VERBS v1 (GBrain).** recall, remember, entity, synthesize, forget, context_pack, delta를 고정 프로토콜로 정의하고 conformance 명령을 둔다. 필드 이름과 의미를 영구 고정한다는 정책은 다른 세션이 의존할 반환 계약의 참고가 된다. [S12]

## 10. 기존 프로젝트로 채워지지 않는 공백

| 공백 | 근거 | 재사용 가능한 조각 | 직접 만들 범위 |
|---|---|---|---|
| 소스별 수집 운영 | OpenViking watch는 주기, `last_status`, `last_error`를 갖지만 재시도·백오프·사멸 감지가 문서에 없다 [S36]. Cognee `cron_web_scraper_task`는 프로세스 내 APScheduler에 cron 표현식을 등록한다 [S37]. LongMemory는 수동 동기화다. P7은 갱신 정책이 신선도를 좌우한다고 보고 | OpenViking의 Watch 필드 모델, LongMemory의 체크섬 커서, CocoIndex 증분 엔진, GBrain cycle 구조, systemd timer | 소스 레지스트리, 소스별 주기, 재시도, 사멸 감지, 수집 결과를 시간형 그래프로 넘기는 연결 |
| 저장 전 인용 검증 | P10, P11. 저장 시점 강제 게이트를 표준으로 둔 도구 없음 | urlhealth, LangExtract 정렬 방식, 인용문 원문 포함 검사 | URL 생존, 인용문 일치, 원문 스냅샷 해시를 묶는 얇은 검증기 |
| 한국어 대체 키 | T2에서 결정적 파서 실패. T8은 호출자 지정이 필요 | MemPalace `supersede`, GBrain `--replaces`, Graphiti 무효화 | 에이전트가 낸 주어·술어를 정규화해 대체 대상을 찾는 규칙 |
| 비신뢰 입력 경계 | P14, P15, S7 | GBrain `trust_tier`, `content_origin`, LongMemory `zone` 구분 | 소스 신뢰 등급과 격리 대기열 |
| 파급 무효화 | P8. 조사 후보 중 파급 처리 실측 근거 없음 | 관계 그래프 | 대체된 사실에 의존한 파생물 표시 |

선택지 비교 (결정은 설계 단계의 몫이다):

| 조합 | 재사용 범위 | 남는 일 | 부담 |
|---|---|---|---|
| Markdown 원본 + Basic Memory + 얇은 수집·검증층 | 그래프, valid time, MCP, 검색 | 수집기, 검증기, 트랜잭션 시간은 git으로 대체 | AGPL, 대량 임베딩 속도, 영어 기본 임베딩 |
| GBrain 단독 + 수집기 | 출처, 대체, 그래프, MCP, 사이클 | 수집기, 판단 기능 차단 | 거대한 표면, 빠른 변경 속도, 업그레이드 추적 |
| Graphiti + 구독 `LLMClient` | 양시간 그래프, 자동 무효화 | LLM 어댑터, 수집기, MCP 임베디드 구성 | 호출 수, 구독 한도, 참조 수준 MCP |
| Hindsight + `claude-code` | 추출, 통합, 근거 추적 | 수집기, 그래프 관계 표현 | 판단 기능 차단, 구독 한도 |

## 11. 지침 5와 충돌하는 기능

도입 시 끄거나 쓰지 않아야 하는 기능이다.

| 프로젝트 | 기능 | 충돌 내용 |
|---|---|---|
| GBrain | `think`, `advisor`, `synthesize`, takes(bet, hunch), `find_experts`, 야간 dream 합성 | 자체 판단, 순위, 제언 생성 |
| Hindsight | `reflect`, mental models, 관찰 통합 | 자체 합성 신념 생성 |
| Cognee | `improve`의 일부 단계, GRAPH_COMPLETION 답변 | 생성 답변 |
| Graphify, obsidian-wiki | `GRAPH_REPORT.md`, 대시보드 스킬, `graph.html` | 리포트와 가시화 |
| claude-mem, agentmemory | 뷰어 UI | 가시화 |

## 12. 미확인 사항과 한계

- Cognee GLiNER 키리스 경로의 품질과 한국어 동작, cognee-mcp 실행: 공간 부족으로 미측정.
- Hindsight `claude-code` 프로바이더 전체 흐름: 격리 호출만 확인했고 실제 retain 추출, 호출 수, 비용은 미측정.
- GBrain `claude-cli` 경로, cycle, autopilot, 임베딩 경로: 코드만 확인. autopilot은 cron/systemd를 변경하므로 실행하지 않았다.
- GBrain에 범용 웹·RSS 수집 경로가 있는지: README 통합 목록에서 찾지 못했을 뿐 코드 전수 확인은 아니다. MCP 목록의 `capture`, `fetch` 동작은 미확인.
- Graphiti MCP 서버가 임베디드 FalkorDB Lite로 구동되는지: 팩토리 코드는 URI 접속이고 MCP README에 임베디드 언급은 없다. 실행 확인은 안 했다.
- Graphiti의 `httpx` 누락은 2026-10-31 해석 결과 기준이며 상류에서 곧 바뀔 수 있다.
- mem0 OpenMemory의 이동처: 현재 트리에서 경로가 없음만 확인했다.
- OpenViking: 설치하지 않았고 문서만 확인했다. watch 스케줄의 재시작 생존, 갱신 시 이전 내용 보존 방식, 키 없는 로컬 모델 구성 가능 여부는 미확인이다.
- 크레딧이 API 키로 실행한 `claude -p`에 적용되는지: 1차 문서끼리 표현이 다르다.
- 구독 자동화 사용량의 실제 상한: 공개 수치를 확인하지 못했다.
- 성능 수치는 합성 코퍼스 소량, 병렬 작업 부하 하의 값이다. 후보 간 절대 비교 용도가 아니다.
- 스크립트는 세션 scratch에 있어 보존되지 않는다. 재현에 필요한 명령은 5절에 남겼다.

## 13. 출처

소프트웨어 항목의 커밋은 코드를 읽은 기준이다.

| ID | 출처 | 종류 | 확인일 |
|---|---|---|---|
| S1 | [Karpathy, llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | 1차 | 2026-10-31 |
| S2 | [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | 1차 | 2026-10-31 |
| S3 | [Claude Code Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | 1차 | 2026-10-31 |
| S4 | [API credits for Max, Ultra, and Team plans](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers) | 1차 | 2026-10-31 |
| S5 | [How Claude remembers your project](https://code.claude.com/docs/en/memory) | 1차 | 2026-10-31 |
| S6 | [Graphiti](https://github.com/getzep/graphiti) `72b5c59` | 1차, 코드 | 2026-10-31 |
| S7 | [Graphiti MCP README](https://github.com/getzep/graphiti/blob/main/mcp_server/README.md) | 1차 | 2026-10-31 |
| S8 | [Zep README](https://github.com/getzep/zep) | 1차 | 2026-10-31 |
| S9 | [Cognee](https://github.com/topoteretes/cognee) `525b1d1` | 1차, 코드 | 2026-10-31 |
| S10 | [Basic Memory](https://github.com/basicmachines-co/basic-memory) `d7b1612`, CHANGELOG, docs/DOCUMENT_CITATIONS.md | 1차, 코드 | 2026-10-31 |
| S11 | [Hindsight](https://github.com/vectorize-io/hindsight) `bc5ea19`, [문서](https://hindsight.vectorize.io) | 1차, 코드 | 2026-10-31 |
| S12 | [GBrain](https://github.com/garrytan/gbrain) `7544cc0`, docs/ai-providers/claude-cli.md, docs/protocol/MEMORY_VERBS_v1.md | 1차, 코드 | 2026-10-31 |
| S13 | [LongMemory](https://github.com/CaviraOSS/LongMemory) `8badf44`, [npm longmemory](https://www.npmjs.com/package/longmemory) | 1차, 코드 | 2026-10-31 |
| S14 | [MemPalace](https://github.com/MemPalace/mempalace) `4f7745a`, docs/HISTORY.md | 1차, 코드 | 2026-10-31 |
| S15 | [claude-mem](https://github.com/thedotmack/claude-mem) `70aa400` | 1차, 코드 | 2026-10-31 |
| S16 | [Mem0 README](https://github.com/mem0ai/mem0) | 1차 | 2026-10-31 |
| S17 | [Letta README](https://github.com/letta-ai/letta) | 1차 | 2026-10-31 |
| S18 | [GraphRAG BYOG](https://microsoft.github.io/graphrag/index/byog/) | 1차 | 2026-10-31 |
| S19 | [GraphRAG dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/) | 1차 | 2026-10-31 |
| S20 | [GraphRAG README](https://github.com/microsoft/graphrag) | 1차 | 2026-10-31 |
| S21 | [LightRAG](https://github.com/HKUDS/LightRAG) `aaebfe1` | 1차, 코드 | 2026-10-31 |
| S22 | [qmd](https://github.com/tobi/qmd) `86d2365`, src/store.ts | 1차, 코드 | 2026-10-31 |
| S23 | [Graphify](https://github.com/Graphify-Labs/graphify) `a0946f9` | 1차 | 2026-10-31 |
| S24 | [OpenViking](https://github.com/volcengine/OpenViking) `3dedecc` | 1차 | 2026-10-31 |
| S25 | [obsidian-wiki](https://github.com/Ar9av/obsidian-wiki) `4f457e1` | 1차 | 2026-10-31 |
| S26 | [karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) `eafcc77` | 1차 | 2026-10-31 |
| S27 | [local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp) `d1c64d5` | 1차 | 2026-10-31 |
| S28 | [LangExtract README](https://github.com/google/langextract) | 1차 | 2026-10-31 |
| S29 | [OKF SPEC v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) | 1차 | 2026-10-31 |
| S30 | [agentmemory README](https://github.com/rohitg00/agentmemory) | 1차 | 2026-10-31 |
| S31 | [Engram README](https://github.com/Gentleman-Programming/engram) | 1차 | 2026-10-31 |
| S32 | [CocoIndex README](https://github.com/cocoindex-io/cocoindex) | 1차 | 2026-10-31 |
| S33 | [obsidian-skills README](https://github.com/kepano/obsidian-skills) | 1차 | 2026-10-31 |
| S34 | [urlhealth](https://github.com/delip/urlhealth), [PyPI](https://pypi.org/project/urlhealth/) | 1차 | 2026-10-31 |
| S35 | [Startup Fortune, Agent SDK 과금 보도](https://startupfortune.com/anthropic-quietly-separates-claude-agent-sdk-usage-from-subscription-limits/) | 2차, 1차 대조용 | 2026-10-31 |
| S36 | [OpenViking Watch API](https://raw.githubusercontent.com/volcengine/OpenViking/main/docs/en/api/15-watches.md), [Resources API](https://raw.githubusercontent.com/volcengine/OpenViking/main/docs/en/api/02-resources.md) | 1차 | 2026-10-31 |
| S37 | [Cognee web_scraper_task.py](https://github.com/topoteretes/cognee/blob/main/cognee/tasks/web_scraper/web_scraper_task.py) | 1차, 코드 | 2026-10-31 |
| P1 | [Zep, arXiv 2501.13956](https://arxiv.org/abs/2501.13956) | 프리프린트 | 2026-10-31 |
| P2 | [Hindsight, arXiv 2512.12818](https://arxiv.org/abs/2512.12818) | 프리프린트 | 2026-10-31 |
| P3 | [Are We Ready, arXiv 2606.24775](https://arxiv.org/abs/2606.24775) | 프리프린트 | 2026-10-31 |
| P4 | [SodaMem, arXiv 2608.08055](https://arxiv.org/abs/2608.08055) | 프리프린트 | 2026-10-31 |
| P5 | [MemStrata, arXiv 2606.26511](https://arxiv.org/abs/2606.26511) | 프리프린트 | 2026-10-31 |
| P6 | [Real Software Histories, arXiv 2608.20685](https://arxiv.org/abs/2608.20685) | 프리프린트 | 2026-10-31 |
| P7 | [ChurnBench, arXiv 2609.11515](https://arxiv.org/abs/2609.11515) | 프리프린트 | 2026-10-31 |
| P8 | [RECON, arXiv 2607.16716](https://arxiv.org/abs/2607.16716) | 프리프린트 | 2026-10-31 |
| P9 | [Freshness, arXiv 2509.19376](https://arxiv.org/abs/2509.19376) | 프리프린트 | 2026-10-31 |
| P10 | [Cited but Not Verified, arXiv 2605.06635](https://arxiv.org/abs/2605.06635) | 프리프린트 | 2026-10-31 |
| P11 | [Reference Hallucinations, arXiv 2604.03173](https://arxiv.org/abs/2604.03173) | 프리프린트 | 2026-10-31 |
| P12 | [RT4CHART, arXiv 2603.27752](https://arxiv.org/abs/2603.27752) | 프리프린트 | 2026-10-31 |
| P13 | [Claimify, arXiv 2502.10855](https://arxiv.org/abs/2502.10855) | ACL 2025 | 2026-10-31 |
| P14 | [Mind Your HEARTBEAT, arXiv 2603.23064](https://arxiv.org/abs/2603.23064) | 프리프린트 | 2026-10-31 |
| P15 | [Long-Term Memory Security Survey, arXiv 2604.16548](https://arxiv.org/abs/2604.16548) | EMNLP 2026 채택 표시 | 2026-10-31 |
| P16 | [Memory for Autonomous LLM Agents, arXiv 2603.07670](https://arxiv.org/abs/2603.07670) | 프리프린트 | 2026-10-31 |
