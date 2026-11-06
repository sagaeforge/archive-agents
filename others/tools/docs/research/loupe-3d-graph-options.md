# loupe 3D 그래프 라이브러리 비교

확인일 2026-11-06. 설치와 앱 변경 없이 npm 메타데이터, GitHub API, unpkg의 배포 파일, 저장소 코드를 읽어 정리했다. 브라우저에서 3D 후보를 돌려 본 값은 없다.

## 1. 결론

**`3d-force-graph`를 React 래퍼 없이 직접 써서 설정 뒤에 둔 시제품으로 먼저 검증한다. 2D(sigma)는 소유자 승인 전까지 기본으로 남긴다.** 3D로 바로 바꿀 근거는 아직 없고, 시제품이 아래 측정 관문을 못 넘으면 three.js 직접 구현으로 넘어간다.

이유 세 가지.

1. 접근성 목록, 키보드, 필터 기즈모는 캔버스 밖 DOM이고 렌더러와 무관하다. 어느 후보를 골라도 이 부분은 그대로고, 후보를 가르는 것은 규모와 비용이다.
2. 홈 그래프는 최대 주제 20개 × 이웃 500개로 약 1만 노드, 엣지 약 4만 개까지 간다(`src/data/hooks.ts:248-250`). 3d-force-graph는 노드마다 Mesh, 엣지마다 Line 객체를 만들고 묶어 그리지 않는다(`three-forcegraph@1.43.6` 소스). 이 규모에서 예산을 지킨다는 근거가 없다. 그래도 도입 비용이 가장 낮고 유지보수 중이라 먼저 잰다.
3. `react-force-graph-3d`는 같은 엔진에 래퍼 하나를 더한 것이다. loupe는 sigma도 `GraphView`로 직접 구동하므로(`src/graph/view.ts:1`) 같은 패턴이 맞다.

## 2. 후보 비교 표

| 후보 | 최신 버전, 발행일 | 유지보수 | 라이선스 | 크기, 의존 | React 19.3.1 | graphology 데이터 | 위험 한 줄 |
|---|---|---|---|---|---|---|---|
| sigma 2D (현재) | 4.0.4, 10-27. 저장소는 4.0.3 고정 | 5 open, 11-05 push | MIT | graph-vendor 441 KB, gz 110 KB | 직접 구동 | 그대로 | 3D 요청을 채우지 못한다. 기술 위험은 없다 |
| 3d-force-graph | 1.80.2, 11-05 | 249 open, 11-05 push, 릴리스 간격 최대 약 6개월, 단일 작성자 | MIT | 직접 의존 5개, UMD min 1.39 MB, gz 365 KB(three 포함) | 해당 없음(직접 사용) | 변환 필요 | 객체 단위 장면이라 1만/4만에서 예산 초과 가능, 키보드·접근성 기능 없음 |
| react-force-graph-3d | 1.29.2, 09-29 | 위와 같은 저장소 계열(218 open) | MIT | 위 + react-kapsule, prop-types. UMD gz 371 KB | peer `*`, 래퍼는 forwardRef와 훅만 쓴다(소스 확인, 실행 안 함) | 변환 필요 | 위와 같고, 선언형 래퍼가 `GraphView` 방식과 맞지 않는다 |
| three.js 직접 | three 0.187.0, 10-30 | 400 open, 매일 push, 매월 릴리스 | MIT | 742 KB, gz 186 KB(이전 조사 값) | 해당 없음 | graphology 그대로 읽을 수 있다 | 선택, 컨트롤, 라벨, 3D 레이아웃을 직접 만들어야 해 일정과 유지 비용이 크다 |

- `npm view`의 unpackedSize(3d-force-graph 15.3 MB 등)는 여러 빌드와 맵을 합친 값이라 번들 크기로 쓰지 않았다.
- 3d-force-graph는 `three`를 peer가 아닌 dependency(`>=0.179 <1`)로 선언한다. 저장소와 버전이 다르면 three가 둘 설치될 수 있어 고정이 필요하다. 이슈 #735가 three 0.182 이상에서 노드 클릭마다 OrbitControls 오류가 난 사례이고 11-05에 닫혔다. 1.80.2에 들어갔는지는 확인하지 않았다.
- 같은 작성자의 체인이다: 3d-force-graph → three-forcegraph(d3-force-3d, ngraph.forcelayout) → three-render-objects. ngraph.forcelayout만 BSD-3-Clause이고 마지막 발행이 2022-10-04다.
- 이슈 #732(해제 때 three 자원 미반납)가 2026-04-05에 닫혔다. TopicGraph는 효과 안에서 만들고 지우므로 시제품에서 해제 뒤 컨텍스트 수를 확인한다.
- 3d-force-graph는 노드 객체를 직접 수정하고 `{nodes, links}` 형식을 받는다. loupe의 `GraphData`(`src/graph/model.ts`)는 평범한 배열이라 변환은 짧지만, 갱신마다 사본을 넘겨야 한다[이 동작은 이번에 실행으로 확인하지 않았다].
- three.js 직접 안의 R3F 변형은 `@react-three/fiber` 9.8.2(peer React `>=19 <19.4`로 호환)이나 drei 의존이 크고 이득이 없어 비교에서 뺐다.
- graphology 0.26.0은 저장소 고정과 최신이 같다(2025-01-26 이후 릴리스 없음). 3D 후보를 고르는 데는 영향이 없다.

## 3. 접근성과 키보드 영향

현재 모델: 캔버스는 포커스를 받지 않고, 화면 밖 `listbox`(`TopicGraph.tsx`)가 `Tab` 순서(주제 → 이웃), `Enter`로 열기, `onFocus`로 활성을 맡는다. 활성은 `view.select/setHover`로 강조에 이어지고, `Esc`와 `Alt+G` 기즈모도 DOM이다(설계 v2 2.3절, 9절).

3D에서 다시 만들어야 하는 곳은 렌더러 어댑터 여섯 개뿐이다.

| 현재 | 3D에서 |
|---|---|
| `select`, `setHover` 강조 | 노드 재질을 바꾸고, 가려진 활성 노드가 보이도록 깊이 검사를 끈 고리를 덧그린다 |
| `focusOn`, `fit` | `cameraPosition`, `zoomToFit`(둘 다 README에 있다). 움직임 줄이기 설정이면 시간 0 |
| 기즈모 필터 | `nodeVisibility`, `linkVisibility` 접근자나 `filterGraph` 결과 교체. 어느 쪽이 레이아웃을 흔들지 않는지는 시제품에서 잰다 |
| 닻 고리(`AnchorRings`) | 3D 고리 스프라이트로 다시 구현 |
| 한글 라벨(`overlay.ts`) | three-spritetext 1.10.0(MIT, 의존 0)이나 현재 오버레이를 투영 좌표로 유지. 한글 표시는 미검증 |
| 카메라 키보드 | 어느 후보에도 없다. 아래 참조 |

- 3d-force-graph 세 파일에서 `keydown`, `tabindex`, `aria`를 찾았으나 없다(소스 검색). 이슈 검색에도 접근성 항목이 없다. OrbitControls에는 `listenToKeyEvents`가 있지만 방향키 이동만 하고, 캔버스를 포커스 대상으로 만들어야 해 "캔버스는 포커스를 받지 않는다"는 설계와 부딪힌다. 카메라는 DOM 버튼(확대, 축소, 회전, 맞추기)과 "2D로 보기" 항목으로 제공하는 안을 권한다.
- 레이아웃 15초 동안(README `cooldownTime` 기본값) 노드가 계속 움직이면 WCAG 2.2.2 문제가 된다. 저장된 좌표를 고정해 움직임 없이 시작하는 것이 목표다.
- 스크린 리더는 목록이 원본이라 변하지 않는다. 깊이(z)는 목록에 나타나지 않는다.

후보별 위험은 2절 표의 마지막 열에 한 줄씩 적었다.

## 4. 성능과 번들 크기

**잰 것(이번 조사).**
- 현재 `dist/assets`(2026-11-06 빌드)의 `graph-vendor` 441,320 B, gz 109,563 B.
- unpkg 배포 파일 크기와 `gzip -c` 값: 3d-force-graph UMD 1,389,818 B / 365,296 B, react-force-graph-3d UMD 1,408,690 B / 371,211 B, sigma UMD 393,053 B / 103,922 B, three-forcegraph UMD 104,133 B / 33,137 B. UMD는 three를 품고 있어 Vite 트리 셰이킹 결과는 이보다 작을 수 있으나 재지 않았다.

**읽기만 한 것.**
- 기존 sigma 값: 10k/51k에서 첫 프레임 478~621 ms, CPU+GPU 5.0~5.3 ms, 번들 예산 130 KB gz 이하(`docs/design/loupe.md` 6.1, 11절). 이번에 다시 재지 않았다.
- three 742 KB / gz 186 KB는 `docs/research/netmap-landscape.md`(2026-11-01)의 값이다.
- 3d-force-graph README의 가장 큰 예제는 "약 4천 요소"다. loupe 기본 규모(요소 5만 이상)의 12배 이상이다.
- 객체 단위 장면 구성, `forceEngine` 기본 d3(주 스레드), `cooldownTicks` 기본 무한은 README와 소스에서 읽었다.

**재지 못한 것.** 3D 후보의 프레임, 첫 프레임, heap, 호버 지연은 전혀 재지 않았다. 객체 수 대비 성능 판단은 추론이다.

번들은 3D만으로 130 KB 예산(sigma + graphology)을 넘는다(three만 gz 186 KB). 3D를 받는다면 예산 행을 "2D 경로 130 KB, 3D 경로는 별도 지연 로드 청크"로 소유자가 고쳐야 한다.

## 5. 전환 단계 제안

설정 뒤에서 진행하고 기본은 2D다.

1. **승인**: 소유자가 시제품 착수와 예산 행 분리(2D 130 KB, 3D 별도)를 승인한다. 이 문서는 승인 요청이다.
2. **설정**: 설정 창에 `그래프 보기: 2D(기본) | 3D(실험)`를 둔다. 3D 코드는 별도 청크(`graph3d-vendor`)로 두어 2D 경로가 0 바이트를 더 받는다.
3. **어댑터**: `GraphView`의 공개 메서드(`setData`, `setPositions`, `select`, `setHover`, `focusOn`, `fit`, `viewportOf`, `kill`)를 인터페이스로 뽑고 `GraphView3D`가 구현한다. `TopicGraph`는 설정으로 고른다. 목록, 기즈모, 단축키는 건드리지 않는다.
4. **좌표**: 기존 worker 좌표(x, y)에 Louvain 커뮤니티로 z를 준다. 좌표를 고정해 d3 시뮬레이션을 건너뛴다. 부족하면 d3-force-3d(3.0.6, MIT, 의존 5개)를 worker에서 돌린다. IndexedDB 캐시에 z를 더하는 변경이 필요하다.
5. **측정 관문**: `bench:graph`로 1천, 4천, 1만 노드를 RTX 창과 Radeon에서 잰다. 첫 프레임 800 ms, CPU+GPU 8 ms 안이어야 한다. 1만에서 실패하면 3D를 N개 이하에서만 켜고 위는 2D로 돌리거나, three.js `InstancedMesh`와 `LineSegments` 직접 구현으로 바꾼다.
6. **접근성 시험**: 기존 키보드 e2e를 3D에서도 그대로 통과시키고, 카메라 버튼, 움직임 줄이기, 해제 뒤 WebGL 컨텍스트 누수를 추가로 본다.
7. **기본값 변경**: 위 결과를 소유자가 본 뒤 승인할 때만 3D를 기본으로 한다.

## 6. 출처와 확인 날짜

모두 2026-11-06 확인.

- npm 레지스트리 `npm view`: 3d-force-graph, react-force-graph-3d, react-force-graph, three-forcegraph, three-render-objects, react-kapsule, kapsule, three, sigma, graphology, d3-force-3d, ngraph.forcelayout, three-spritetext, @react-three/fiber, @react-three/drei, graphology-layout-force.
- GitHub API: vasturiano/3d-force-graph(이슈 #735, #732 포함), react-force-graph, three-forcegraph, jacomyal/sigma.js, mrdoob/three.js의 push 일자와 open 이슈 수. 이 수는 풀 리퀘스트를 포함할 수 있다.
- unpkg: `3d-force-graph@1.80.2` README와 `.mjs`, `three-forcegraph@1.43.6/dist/*.mjs`, `three-render-objects@1.43.0`, `react-kapsule@2.6.0`, `react-force-graph-3d@1.29.2`, `three@0.187.0/examples/jsm/controls/OrbitControls.js`, sigma와 UMD 파일.
- 저장소: `tools/loupe/package.json`, `src/shell/TopicGraph.tsx`, `src/graph/view.ts`, `src/graph/gizmo/model.ts`, `src/data/hooks.ts`, `vite.config.ts`, `dist/assets`.
- 문서: `docs/design/loupe-v2.md` 2.3절과 9절, `docs/design/loupe.md` 6.1절과 11절, `docs/research/netmap-landscape.md`, `docs/research/verify-viewer.md` C1(sigma 한글 라벨).
