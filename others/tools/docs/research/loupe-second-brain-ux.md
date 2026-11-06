# loupe와 세컨드 브레인 도구의 UX 비교

확인일: 모든 출처를 2026-11-06에 열어 읽었다. 출처 번호는 6절. 공식 문서를 못 찾은 주장은 "2차"로 표시하고, 근거가 없으면 **미확인**이다. loupe 쪽 기준은 `docs/design/loupe-v2.md` 2.2~2.8절이다.

## 1. 질문과 범위

질문: 비슷한 도구는 탐색, 그래프, 창 모델, 단축키, 편집, 저장 신뢰를 어떻게 풀었고, loupe v2가 놓친 것은 무엇인가.

기존 조사(`oss-viewers.md`, `verify-viewer.md`)는 Obsidian, Logseq 등을 **KB 위에 얹을 뷰어 후보**로만 평가했다. 이 문서는 UX만 본다. 겹치지 않는다.

고른 7개와 이유:

| 도구 | 고른 이유 |
|---|---|
| Obsidian | 그래프·백링크의 기준. 패널과 창 모델이 loupe와 정반대라 대조가 된다 |
| Logseq | 블록 단위 링크와 오른쪽 사이드바. 그래프가 쓸모없다는 사용자 평가가 있다 |
| Roam | 그래프 개요가 탐색의 한 축이었던 초기 사례 |
| Tana | 명령줄(Ctrl+K)과 객체 타입. 찾기와 명령을 나눈 사례 |
| Heptabase | 카드와 화이트보드. 공간 배치를 저장한다 |
| Capacities | 객체 기반. 그래프 단순화 기능이 loupe 필터 기즈모와 가깝다 |
| Reflect | 찾기와 명령을 하나로 합친 사례. 그래프는 미확인 |

보조: InfraNodus(텍스트 네트워크 분석)는 그래프 기능이 공식 문서에서 확인되지 않아 표에서 뺐다. Kumu는 3D 근거를 못 찾았다. **Kortex는 이번에 조사하지 않았다(미확인).** Notion은 페이지 트리 모델이라 loupe가 이미 버린 안(2.2절)이어서 뺐다.

## 2. 도구별 UX 요약

| 도구 | 탐색 방식 | 그래프 역할 | 창·패널 모델 | 단축키 | 편집 방식 | 저장 신뢰 |
|---|---|---|---|---|---|---|
| Obsidian | 파일 목록, 링크, 백링크, 명령 팔레트 [1][2] | 보조. 필터, 색 그룹, 로컬 그래프(깊이 슬라이더), 시간순 재생. 노드 클릭 시 열림 [1] | 탭, 분할, 겹침 탭, 팝아웃 창, 좌우 사이드바 [4] | Ctrl+P 명령 팔레트, 최근 명령이 위(1.8.3부터) [5] | Markdown 파일 [6] | 로컬 평문 파일 [6]. 파일 복구 스냅샷은 기본 5분 간격, 7일 보관 [7] |
| Logseq | 일지, 링크 참조, 오른쪽 사이드바 [8] | 약함. 포럼 평: 블록 참조는 그래프에 안 나온다 [9] (2차) | 본문 + 오른쪽 사이드바. 링크를 Shift+클릭하면 사이드바 [8] | `t r` 사이드바 열기, Ctrl+Shift+O [8] | 블록 단위(포럼 근거, 공식 문서 미확인) | Markdown·Org 지원. DB 버전은 베타이고 "data loss is possible" 경고 [10] |
| Roam | 일일 노트, 링크 참조·링크 안 된 참조, 모든 페이지 [11] | 개요 화면. 2020년 리뷰는 필터가 없어 유용하지 않다고 평함 [11] (2차, 오래됨) | 왼쪽 접이식 사이드바 + 오른쪽 사이드바(페이지 제목 우클릭) [11] | 공식 확인 **미확인** | 블록 단위 | **미확인** |
| Tana | Ctrl+K 명령줄(내용이 아니라 명령을 찾음), Find nodes로 목록·표 질의, 슈퍼태그 페이지 [12][13] | 확인한 문서에 그래프 화면 설명 없음. 질의 결과가 중심 | 확인한 문서에 창 모델 설명 없음 | Cmd/Ctrl+K, 명령마다 사용자 단축키 지정 [12] | 노드 단위 아웃라이너, 슈퍼태그로 타입화 [13] | 데스크톱 오프라인: 개인 작업공간 편집·검색 가능, 공유 작업공간은 읽기 전용, 상단 표시등 [14] |
| Heptabase | 왼쪽 앱 목록 + 탭, 오른쪽 사이드바(목차, 백링크, 정보, 채팅) [15][16] | 화이트보드가 그래프를 대신한다. 카드를 직접 배치하고 하위 보드를 둔다 [15] | 왼쪽 탭 시스템(고정, 폴더, 그룹) + 오른쪽 사이드패널 [15] | Ctrl+O 검색, Ctrl+K 명령, Ctrl+Enter 새 탭, Alt+Enter 사이드패널 [17] | 카드(문서) 단위, 받은편지함에 먼저 쌓음 [15] | 홈페이지가 오프라인 사용을 주장 [18]. 그 외 **미확인** |
| Capacities | 왼쪽 사이드바의 객체 타입, 일일 노트 달력, 백링크 패널 [19][20] | 보조. 타입 숨기기, 단순 점 보기, 링크 25개 초과 노드 숨기기(2025-12-09) [21] | 사이드바 + 본문. 다중 패널은 확인되지 않음 [20] | Cmd/Ctrl+T 새 탭(2025-12-09), 나머지 **미확인** [21] | 타입별 속성 틀 [19] | 서버 저장(EU). 오프라인 지원은 목록에만 있고 방식 **미확인** [20] |
| Reflect | 오늘 노트에서 시작, 백링크, Cmd+K 찾기+명령 겹침창 [22][23] | 별도 화면 **미확인**(공식은 "backlinked notes로 그래프를 만든다"까지) [22] | 사이드바. 방해 없음 모드로 사이드바 숨김 [23] | Cmd+K, Cmd+/ 목록 [23] | 노트 단위 | 오프라인 가능 문구 [22]. 종단간 암호화는 공식 페이지에서 **미확인** |

## 3. loupe와 겹치는 패턴

- **여러 기록을 동시에 연다.** Obsidian 분할·팝아웃 [4], Heptabase 탭과 사이드패널 [15], Logseq 사이드바 [8]. loupe의 창 관리자(2.7절)는 같은 요구를 패널 없이 푼다. 방향은 맞다.
- **미리보기.** Obsidian은 링크에 올리면 미리보기가 뜬다. 편집 중에는 Ctrl이 필요하다 [3]. loupe는 400 ms 뒤 미리보기이고 편집 영역 규칙은 설계에 없다. 4절 후보 7에서 다룬다.
- **로컬 그래프.** Obsidian의 로컬 그래프는 활성 노트의 이웃만 보인다 [1]. loupe의 홈(주제 + 1홉)과 같은 발상이다.
- **그래프 거르기.** Obsidian 필터·그룹 [1], Capacities 타입 숨기기 [21]. loupe의 필터 기즈모와 같은 일을 한다. 기즈모는 주제 닻을 남기는 점이 다르다.
- **타입별 모양.** Capacities는 타입마다 구조가 다르다 [19]. loupe는 노드 모양으로 구분한다.
- **빠른 찾기.** Reflect는 찾기와 명령을 한 겹침창에 둔다 [23]. loupe의 Ctrl+K도 같다. 반대로 Heptabase는 Ctrl+O(찾기)와 Ctrl+K(명령)를 나눴고 [17], Tana의 Ctrl+K는 명령만 찾는다 [12].
- **연결 상태 표시.** Tana는 상단 표시등으로 오프라인을 알린다 [14]. loupe의 아바타 점이 같은 역할이다.
- **판 이력.** Obsidian 스냅샷 [7]과 loupe 판 탭(5.3절)은 같은 문제를 푼다. loupe는 되돌림이 새 판을 만들어 더 안전하다.

## 4. loupe가 놓치기 쉬운 것 (제안)

모두 제안이며 사용자 결정 전이다. 근거는 각 도구의 제품 동작이고 사용자 실험 결과가 아니다.

1. **링크 안 된 언급.** Obsidian은 이름이 본문에 나오지만 링크되지 않은 곳을 "링크 안 된 언급"으로 보인다 [2]. Roam도 같다 [11]. loupe는 `[[ ]]` 링크의 백링크만 있다(2.1절). 엔티티·주제 창의 백링크 탭에 "이름이 나온 메모" 묶음을 두면 링크를 만들 기회가 생긴다. 서버 검색을 쓰므로 계약 변경은 필요 없을 것이다(미확인). private 기록을 어떻게 섞을지는 별도 결정이다.
2. **허브 숨기기.** Capacities는 링크가 25개를 넘는 노드를 숨기고 점 보기를 둔다 [21]. loupe 홈은 주제가 큰 허브이고 주제별 1홉이 겹치면 읽기 어려워질 수 있다. 기즈모에 "연결 N개 이상 흐리게" 같은 항목이 후보다. 기존 닻 규칙(2.3절)과 충돌하는지 먼저 확인한다.
3. **로컬 그래프 깊이.** Obsidian은 깊이 슬라이더로 연결 단계를 늘린다 [1]. loupe는 1홉으로 고정이다. 활성 노드에서만 2홉을 불러오는 방법이 있다. 성능 예산(노드 수, 프레임)은 별도로 재야 한다.
4. **공간 배치의 저장.** Heptabase 화이트보드 [15]와 Obsidian Canvas [24]는 사용자가 놓은 배치가 곧 산출물이다. Canvas는 열린 JSON Canvas 형식 파일로 저장된다 [24]. loupe의 창 배치는 탭의 `sessionStorage`에만 남는다(2.7절). 작업 중인 창 묶음에 이름을 붙여 복원하는 기능은 나중 후보다.
5. **그래프만으로는 탐색이 안 된다는 신호.** Roam 그래프는 필터 부재로 유용하지 않다는 평 [11](2020, 개인 리뷰), Logseq 그래프는 "장난감"이라는 포럼 글 [9]이 있다. 둘 다 약한 근거다. loupe는 그래프를 홈으로 삼았고 목록 홈을 버렸다(2.2절). 찾기와 그래프 클릭 중 어느 쪽으로 기록에 들어가는지 쓰임을 재 두면 판단 근거가 생긴다.
6. **블록 참조가 그래프에 안 보이는 혼란.** Logseq 사용자는 블록 참조가 그래프에 연결로 나오지 않는다고 보고한다 [9](2차). loupe의 주장 인용(`[[c-…]]`)은 문서→주장 연결이므로 그래프에서 간선으로 보이는지 확인하고, 안 보이면 이유를 화면에 적는 것이 안전하다.
7. **편집 중 미리보기 충돌.** Obsidian은 편집 모드에서 미리보기를 Ctrl 누를 때만 띄운다 [3]. loupe 설계에는 편집기 안 링크의 올리기 규칙이 없다. 글 쓰는 중 미리보기가 튀어나오면 방해가 되므로 같은 방식이 후보다.
8. **명령 기억.** Obsidian은 최근 명령을 위로 올리고 고정할 수 있다 [5]. Tana는 명령마다 단축키를 지정한다 [12]. loupe 찾기는 "만들기"를 맨 아래에 두는데(2.4절), 자주 쓰는 만들기·이동 명령의 최근 순서는 설계에 없다.
9. **받은편지함.** Heptabase는 새 카드를 Inbox에 모은다 [15]. Capacities는 일일 노트를 스크래치패드로 쓴다 [19]. Reflect는 오늘 노트로 시작한다 [22]. loupe는 `Alt+N` 메모를 만들지만 아직 정리하지 않은 메모를 모아 볼 곳은 폰 흐름(2.9절)뿐이다. 데스크톱에서 "정리 안 된 메모"를 찾기의 한 묶음으로 두는 방법이 있다.

## 5. 3D 그래프에 대한 발견

제품 사례: 확인한 Obsidian 그래프 도움말에는 3D 언급이 없다 [1]. 3D는 커뮤니티 플러그인으로 있다. 한 플러그인 목록은 내려받기 약 5만 8천 회, 마지막 갱신 3년 전으로 표시했다 [25](검색 결과 요약, 2차). Capacities는 3D 대신 단순 점 보기와 허브 숨기기를 택했다 [21]. Kumu와 InfraNodus의 3D는 확인하지 못했다.

연구 (모두 3D가 이로운 조건이 좁다):

| 연구 | 조건 | 결과 |
|---|---|---|
| Ware·Mitchell 2008 [26] | 고해상도 입체 디스플레이, 입체 + 운동 단서, 경로 찾기 | 숙련자는 최대 1,000노드, 비숙련자는 333노드에서 오류율 10% 미만. 저자 표현으로 2D의 약 10배 |
| McGuffin 외 2022 [27] | VR, 34명, 2D는 간선 경로 정리와 마우스 강조 허용 | 3D가 오류율이 낮았다 |
| Huang 외 [28] | 2D 데스크톱 ~ VR 4환경, 20명 | 전체 훑기 과제 정확도는 VR + 트랙볼이 높았다. 두 네트워크 비교 과제에서는 VR이 비슷하거나 느렸다 |
| Joos 외 2025 [29] | VR, 23명, 36개 그래프 | 선호 시점은 교차, 스트레스 등 지표로 설명된다. 시점을 잘못 잡으면 읽기 어렵다는 간접 근거 |

해석 (추정): 확인한 연구는 입체 디스플레이나 VR이었다. 마우스로 돌리는 일반 모니터의 3D가 2D보다 낫다는 근거는 이번에 찾지 못했다(미확인). loupe는 2D(sigma)이고 기즈모는 3D 모양만 빌린 필터다(2.3절). 현재 근거로는 3D 도입을 권하지 않는다.

## 6. 출처 목록 (모두 확인일 2026-11-06)

1. https://obsidian.md/help/plugins/graph (help.obsidian.md에서 301 이전)
2. https://obsidian.md/help/plugins/backlinks
3. https://obsidian.md/help/plugins/page-preview
4. https://obsidian.md/help/tabs
5. https://obsidian.md/help/plugins/command-palette
6. https://obsidian.md/help/data-storage
7. https://obsidian.md/help/plugins/file-recovery
8. https://discuss.logseq.com/t/how-to-work-with-logseqs-right-hand-sidebar/8461 (공식 포럼, 2차)
9. https://discuss.logseq.com/t/graphical-explanation-of-pages-blocks-and-references/15966 와 https://discuss.logseq.com/t/block-references-issues-and-ideas-for-improvements/15784 (검색 결과 요약만 읽음, 2차)
10. https://github.com/logseq/logseq
11. https://thesweetsetup.com/a-thorough-beginners-guide-to-roam-research/ (2020-07-30, 제3자, 오래됨). Roam 공식 사이트 https://roamresearch.com/ 는 "networked thought" 외 기능 설명이 없었다
12. https://outliner.tana.inc/learn/features/command-line
13. https://tana.inc/docs/supertags (검색 결과 요약만 읽음)
14. https://outliner.tana.inc/blog/tana-desktop-now-works-offline-your-knowledge-graph-anywhere (게시일 미표시)
15. https://wiki.heptabase.com/user-interface-logic
16. https://wiki.heptabase.com/newsletters/2024-01-25
17. https://wiki.heptabase.com/keyboard-shortcuts
18. https://heptabase.com/
19. https://docs.capacities.io/tutorials/getting-started
20. https://capacities.io/product
21. https://capacities.io/whats-new/release-57 (2025-12-09)
22. https://reflect.app/
23. https://reflect.academy/keyboard-shortcuts
24. https://obsidian.md/help/plugins/canvas
25. https://community.obsidian.md/plugins/3d-graph (검색 결과 요약만 읽음)
26. https://scholars.unh.edu/ccom/467 (ACM TAP 2008)
27. https://arxiv.org/abs/2207.11586
28. https://arxiv.org/abs/2301.11516
29. https://arxiv.org/abs/2506.09212

**미확인 요약:** Kortex 전체. Logseq·Roam의 공식 문서 기반 단축키와 편집 모델. Roam·Heptabase·Reflect의 저장 신뢰. Reflect 그래프 화면과 종단간 암호화(2차 자료끼리 엇갈림). Capacities 오프라인 방식과 단축키. Tana의 창 모델. Ware·Mitchell 논문 본문의 수치(초록 수준만 확인).
