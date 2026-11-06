# 미룬 결함

리드 검증에서 나온 결함 중 첫 적재를 막지 않아 뒤로 미룬 항목이다. 해결 패키지가 끝날 때 지운다.

| 출처 | 결함 | 해결 시점 |
|---|---|---|
| WP-01 참고 | 인수 조건 3번의 CAS 부분이 지정 명령이 아니라 `test_cas.py`에서만 돈다 | WP-13 전 문서 정리 |
| WP-02 보류 | 존재하지 않는 dst로 만든 엣지는 민감도 0으로 남아, 나중에 dst가 `private` 레코드로 생기면 숨긴 노드 ID가 드러날 수 있다 | first_party 개방 전 필수 |
| WP-02 보류 | `entity.put`의 `liveness.status=dead`가 기존 `state`, `howto` 주장의 `eff_status`를 바꾸지 않는다 | WP-09 |
| WP-02 보류 | `survival.verdict`의 target이 주장 ID면 claim 행 없는 새 버전이 생긴다. 현재 호출 경로는 없다 | WP-09 |
| WP-02 보류 | release한 이벤트가 또 실패하면 idem_key가 같아 새 격리 이벤트가 생기지 않는다 | 강화 파동 |
| WP-02 보류 | 64KB 초과 레코드는 본문 span이 없어 어휘 검색에 걸리지 않는다 | 강화 파동 |
| WP-02 보류 | `--allow-missing` 재구축, `_point_current`의 빌드 디렉터리 fsync, 게이트 없는 격리 쓰기 | 강화 파동 |
