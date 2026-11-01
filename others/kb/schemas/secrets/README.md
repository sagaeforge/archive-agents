# 비밀 탐지 규칙

- `gitleaks.toml`: Gitleaks v8.30.1 `config/gitleaks.toml` 원본 그대로(MIT, 2026-03-21 릴리스). 2026-11-01 `raw.githubusercontent.com/gitleaks/gitleaks/v8.30.1/config/gitleaks.toml`에서 받아 sha256 `e163e53b...a329caf`를 확인했다. 수정하지 않는다.
- `LICENSE-gitleaks`: 같은 태그의 라이선스 본문.
- 읽는 코드는 `src/kb/write/secrets_scan.py`다. 규칙 222개 중 `pkcs12-file`(정규식 없음)을 빼고 221개를 Python `re`로 컴파일한다. 인라인 플래그 22개를 패턴 앞으로 옮기고 `[[:alnum:]]`를 `[0-9A-Za-z]`로 바꾼다.
- 규칙을 올리려면 새 태그의 파일로 바꾸고 `tests/write/test_secret_rules.py`를 돌린다.
