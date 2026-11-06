# loupe 디자인 시스템 (1단계: 토큰)

화면이 이미 쓰는 값을 CSS 사용자 지정 속성으로 모은 첫 단계다. 새 모양을 만들지 않았다. 모든 값은 아래 `출처`의 파일과 줄에서 복사했다. 경로는 `tools/loupe/src/` 기준이고, 토큰 정의는 `design/tokens.css`다. 출처의 짧은 파일명은 `index.css`, `settings/appearance.css`(=`appearance.css`), `memo/memo.css`, `tasks/tasks.css`, `settings/settings.css`, `doc/doc.css`, `graph/gizmo/gizmo.css`, `memo/MemoWindow.tsx`다.

## 1. 목적과 범위

- 목적: 화면마다 흩어진 색, 글자, 간격 값에 이름을 붙여 다음 단계에서 화면이 토큰을 쓰게 한다.
- 이 단계: 토큰과 이 문서만 만든다. 기존 CSS 규칙과 컴포넌트는 바꾸지 않는다. 앱은 `src/main.tsx`에서 `src/design/index.ts`를 불러 토큰을 싣는다.
- 이름은 `--ds-` 접두어다. 기존 `--paper`, `--ink` 등과 이름이 달라 기존 화면이 달라지지 않는다.
- 유지할 배치 원칙: 좌우 패널이 없다(`docs/design/loupe-v2.md:131`). 작업 센터는 오른쪽 아래에 있다(`loupe-v2.md:125`, `src/tasks/tasks.css:1`).
- 테마: `:root`가 밝은 값, `@media (prefers-color-scheme: dark)` 안의 `:root:not([data-theme="light"])`와 `:root[data-theme="dark"]`가 어두운 값이다. 앱은 `src/settings/appearance.ts:31`에서 `data-theme`을 늘 정하므로 실제로는 뒤의 것이 작동한다.

## 2. 색 토큰

밝은 값은 `src/index.css`, 어두운 값은 `src/settings/appearance.css`의 같은 속성 줄이다. 어두운 값이 있는 토큰은 아래 21개다.

| 토큰 | 밝음 | 어두움 | 쓰임 | 출처(밝음 / 어두움) |
|---|---|---|---|---|
| `--ds-paper` | `oklch(0.985 0.002 95)` | `oklch(0.2 0.006 85)` | 바탕 | index.css:9 / appearance.css:4 |
| `--ds-surface` | `oklch(0.998 0.001 95)` | `oklch(0.24 0.006 85)` | 카드, 패널 | index.css:10 / appearance.css:5 |
| `--ds-wash` | `oklch(0.962 0.003 95)` | `oklch(0.29 0.006 85)` | 호버, 옅은 칸 | index.css:11 / appearance.css:6 |
| `--ds-ink` | `oklch(0.255 0.008 85)` | `oklch(0.93 0.004 90)` | 본문 글자 | index.css:12 / appearance.css:7 |
| `--ds-ink-soft` | `oklch(0.42 0.008 85)` | `oklch(0.82 0.005 90)` | 보조 글자 | index.css:13 / appearance.css:8 |
| `--ds-ink-faint` | `oklch(0.525 0.008 85)` | `oklch(0.72 0.006 90)` | 흐린 글자 | index.css:14 / appearance.css:9 |
| `--ds-line` | `oklch(0.915 0.004 90)` | `oklch(0.34 0.006 85)` | 구분선 | index.css:15 / appearance.css:10 |
| `--ds-line-strong` | `oklch(0.85 0.006 90)` | `oklch(0.44 0.006 85)` | 입력 테두리 | index.css:16 / appearance.css:11 |
| `--ds-accent` | `oklch(0.45 0.09 245)` | `oklch(0.76 0.1 245)` | 링크, 초점 고리 | index.css:17 / appearance.css:12 |
| `--ds-accent-wash` | `oklch(0.95 0.018 245)` | `oklch(0.3 0.04 245)` | 정보 칩 바탕 | index.css:18 / appearance.css:13 |
| `--ds-time-ink` | `oklch(0.4 0.095 62)` | `oklch(0.85 0.1 80)` | 과거 보기 글자(호박색은 시간 전용) | index.css:20 / appearance.css:14 |
| `--ds-time-wash` | `oklch(0.945 0.055 88)` | `oklch(0.32 0.05 80)` | 과거 보기 바탕 | index.css:21 / appearance.css:15 |
| `--ds-time-line` | `oklch(0.74 0.15 72)` | `oklch(0.7 0.14 72)` | 과거 보기 테두리 | index.css:22 / appearance.css:16 |
| `--ds-quote` | `oklch(0.905 0.1 100)` | `oklch(0.45 0.08 100)` | 인용 강조 | index.css:23 / appearance.css:17 |
| `--ds-danger` | `oklch(0.47 0.16 27)` | `oklch(0.74 0.15 27)` | KB 끊김, 인용 실패 | index.css:25 / appearance.css:18 |
| `--ds-danger-wash` | `oklch(0.955 0.025 27)` | `oklch(0.3 0.05 27)` | 오류 바탕 | index.css:26 / appearance.css:19 |
| `--ds-warn-ink` | `oklch(0.42 0.09 50)` | `oklch(0.82 0.09 70)` | 경고 글자 | index.css:27 / appearance.css:20 |
| `--ds-warn-wash` | `oklch(0.955 0.03 60)` | `oklch(0.3 0.04 60)` | 경고 바탕 | index.css:28 / appearance.css:21 |
| `--ds-ok` | `oklch(0.46 0.1 155)` | `oklch(0.76 0.13 155)` | 연결됨 | index.css:29 / appearance.css:22 |
| `--ds-primary` | `oklch(0.32 0.01 85)` | `oklch(0.9 0.01 85)` | 주 단추 | index.css:42 / appearance.css:23 |
| `--ds-primary-foreground` | `oklch(0.985 0 0)` | `oklch(0.2 0 0)` | 주 단추 글자 | index.css:43 / appearance.css:24 |

밝은 값만 있는 고정 색(창, 메모, 작업 센터 CSS가 16진수로 직접 쓴다). 어두운 값은 아직 없다(7절).

| 토큰 | 값 | 쓰임 | 출처 |
|---|---|---|---|
| `--ds-control-border` | `#aab1ba` | 단추, 모드 전환 테두리 | memo.css:3 |
| `--ds-control-hover` | `#dde4eb` | 단추 호버 바탕 | gizmo.css:4 |
| `--ds-control-active` | `#536f8b` | 눌린 단추, 저장 단추 테두리 | gizmo.css:5 |
| `--ds-chip-border` | `#c4c8cb` | 메모 상태 칩 기본 테두리 | memo.css:8 |
| `--ds-state-saved` | `#4f8a5b` | 저장됨 테두리 | memo.css:9 |
| `--ds-state-error` | `#b3472f` | 오류 테두리 | memo.css:10 |
| `--ds-state-error-wash` | `#fbf1ee` | 오류 띠 바탕 | memo.css:15 |
| `--ds-state-warn` | `#b08a2e` | 경고 테두리 | memo.css:11 |
| `--ds-state-warn-wash` | `#fbf6e8` | 경고 띠 바탕 | memo.css:16 |

## 3. 글자 크기

| 토큰 | 값 | 쓰임 | 출처 |
|---|---|---|---|
| `--ds-font-body` | `"Malgun Gothic", "Noto Sans KR", "Apple SD Gothic Neo", system-ui, sans-serif` | 본문 | index.css:30 |
| `--ds-font-code` | `ui-monospace, "Cascadia Code", "D2Coding", Consolas, "Noto Sans KR", monospace` | 코드, ID | index.css:31 |
| `--ds-text-2xs` | `11px` | 단축키, 필 | index.css:96 |
| `--ds-text-xs` | `12px` | 작업 종류, 칩 | tasks.css:10 |
| `--ds-text-sm` | `13px` | 창과 카드 안 글 | tasks.css:6 |
| `--ds-text-md` | `15px` | 본문 | index.css:91 |
| `--ds-text-lg` | `1.35rem` | 페이지 제목 | index.css:171 |
| `--ds-text-xl` | `1.65rem` | 항목 제목 | index.css:172 |
| `--ds-leading-body` | `1.7` | 본문 줄 높이 | index.css:91 |
| `--ds-leading-title` | `1.35` | 제목 줄 높이 | index.css:171 |
| `--ds-weight-regular` | `400` | 입력 | index.css:289 |
| `--ds-weight-strong` | `600` | 소제목, 배지 | index.css:175 |
| `--ds-weight-title` | `700` | 제목 | index.css:171 |

## 4. 간격과 모서리

| 토큰 | 값 | 출처 |
|---|---|---|
| `--ds-space-1` | `4px` | doc.css:1 |
| `--ds-space-2` | `6px` | tasks.css:1 |
| `--ds-space-3` | `8px` | tasks.css:2 |
| `--ds-space-4` | `12px` | settings.css:13 |
| `--ds-space-5` | `16px` | tasks.css:1 |
| `--ds-radius-xs` | `4px` | tasks.css:12 |
| `--ds-radius-sm` | `6px` | settings.css:7 |
| `--ds-radius-md` | `8px` | memo.css:12 |
| `--ds-radius-lg` | `10px` | settings.css:5 |
| `--ds-radius-xl` | `12px` | tasks.css:4 |
| `--ds-radius-pill` | `999px` | index.css:125 |

## 5. 상태

색만으로 상태를 나누지 않는다(`loupe-v2.md:875`). 아래 상태는 모두 글이 함께 있다.

| 상태 | 모양 | 토큰 | 출처 |
|---|---|---|---|
| 기본 | 테두리 `--ds-control-border`, 바탕 `--ds-paper` | `--ds-control-border` | memo.css:3 |
| 호버 | 단추는 바탕 `--ds-control-hover`, 목록 줄은 `--ds-wash`, 글 단추는 `--ds-ink`와 밑줄 | `--ds-control-hover`, `--ds-wash`, `--ds-ink` | gizmo.css:4, index.css:182, index.css:149 |
| 초점(focus-visible) | `2px solid` `--ds-accent`, 간격 `2px` | `--ds-focus-width`, `--ds-focus-offset`, `--ds-accent` | index.css:95 |
| 비활성 | 투명도 `0.5` | `--ds-disabled-opacity: 0.5` | memo.css:6 |
| 오류 | 테두리 `--ds-state-error`, 바탕 `--ds-state-error-wash`, 글 "저장 실패" 등 | `--ds-state-error`, `--ds-state-error-wash` | memo.css:10, memo.css:15, MemoWindow.tsx:21 |
| 경고 | 테두리 `--ds-state-warn`, 바탕 `--ds-state-warn-wash` | `--ds-state-warn`, `--ds-state-warn-wash` | memo.css:11, memo.css:16 |
| 저장됨 | 칩 테두리 `--ds-state-saved`, 글 "저장됨" | `--ds-state-saved` | memo.css:9, MemoWindow.tsx:20 |
| 저장 안 됨 | 색 변화 없음. 기본 칩 테두리 `--ds-chip-border`와 글 "저장 안 됨" | `--ds-chip-border` | memo.css:8, MemoWindow.tsx:20 |

`--ds-disabled-opacity: 0.5`, `--ds-focus-width: 2px`, `--ds-focus-offset: 2px`는 위 출처 줄의 값이다.

## 6. 작업 센터 배지 색

규칙(U4): 색 배지는 확인 필요와 오류에만 쓴다. 글은 늘 함께 적는다(`src/tasks/tasks.css:13`, `loupe-v2.md:1009`). 작업 센터는 스스로 펼치지 않는다.

| 배지 | 바탕 / 글자 | 토큰 | 출처 |
|---|---|---|---|
| 일반 상태(색 배지 아님) | `#eef1f4` / `#2f3a45` | `--ds-badge-neutral-bg`, `--ds-badge-neutral-fg` | tasks.css:12 |
| 확인 필요(`attention`, 노랑) | `#facc15` / `#1f1a00` | `--ds-badge-attention-bg`, `--ds-badge-attention-fg` | tasks.css:15 |
| 오류(`error`, 빨강) | `#dc2626` / `#fff` | `--ds-badge-error-bg`, `--ds-badge-error-fg` | tasks.css:16 |

## 7. 아직 없는 것(다음 단계)

- 고정 색 15개의 어두운 값. 지금 어두운 테마에서 창, 메모, 작업 센터는 밝은 16진수 색 그대로다(`appearance.css:28-40`이 창 테두리 일부만 덮는다).
- 16진수 색을 oklch 토큰으로 합치는 일(예: `--ds-state-error`와 `--ds-danger`).
- 크기: 11.5, 12.5, 13.5, 14px가 `index.css`에서 쓰인다. 간격: 10px, 14px와 rem 값이 섞여 있다. 비활성 투명도: `.45`, `.55`, `.7`이 있다. 하나로 줄일지 정해야 한다.
- 그림자, 층(z-index), 선택 영역 색(`index.css:98`), 움직임 길이.
- 화면이 토큰을 쓰도록 바꾸는 일과, 바꾼 뒤 `--ds-` 접두어를 둘지 정하는 일.
