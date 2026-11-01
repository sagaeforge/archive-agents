# 부트스트랩 런북

저장소 루트에서 실행한다. 전역 파일(셸 프로필, `~/.claude`, `~/.config`, crontab, systemd)은 건드리지 않는다.

## 툴체인 설치

```
bash ops/bin/bootstrap.sh
```

- uv 0.13.6 설치 스크립트를 내려받아 `ops/bin/uv-install.sha256`과 대조한 뒤 `UV_UNMANAGED_INSTALL=$KB_TOOLCHAIN/uv`로 실행한다. 셸 프로필과 자가 갱신은 건드리지 않는다.
- `uv python install 3.14.10 --no-bin --install-dir $KB_TOOLCHAIN/python`. `--no-bin`이 없으면 `~/.local/bin`에 링크가 생긴다.
- 기본값: `KB_HOME=/home/user/sagae-kb-data`, `KB_TOOLCHAIN=$KB_HOME/runtime`. 이미 값이 있으면 덮어쓰지 않는다.
- `ops/bin/env.sh`가 `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, `UV_PYTHON_DOWNLOADS=manual`, `UV_PYTHON_PREFERENCE=only-managed`, `UV_LINK_MODE=copy`, `npm_config_cache`, `KB_MODELS`, `KB_CLAUDE_BIN`을 내보낸다.

## 개발

```
ops/bin/dev pytest tests/boot -q
ops/bin/dev kb doctor --json
```

`ops/bin/dev`는 `UV_PROJECT_ENVIRONMENT=$KB_TOOLCHAIN/venv-dev`로 `uv run --frozen --all-extras`를 돈다. `KB_HOME`만 바꾸고 툴체인이 없으면 공용 툴체인을 쓴다.

패키지 작업은 `source ops/bin/wp-env.sh WP-nn` 뒤에 한다. WP-21, WP-25, WP-26, `WP-14 --live`는 실운영 `KB_HOME`, `KB_CONFIG_DIR`을 내보낸다.

## 의존성 변경

`pyproject.toml` 수정 뒤 `source ops/bin/env.sh && uv lock`. 잠금은 `uv.lock`이다.

## 배포

```
ops/bin/deploy --dry-run                      # 계획만 출력
ops/bin/deploy                                # 저장소 트리에서 배포
ops/bin/deploy --from-snapshot <tar.gz>       # 파동 스냅샷에서 배포
```

내용 해시 `<id>`로 `runtime/venv-<id>`, `runtime/share-<id>`를 만들고 `runtime/venv`, `runtime/share` symlink를 rename으로 바꾼다. `runtime/bin/kb`, `runtime/bin/kb-mcp` 래퍼는 `KB_HOME`, `KB_SHARE`, `KB_CLAUDE_BIN`을 고정하고 `python -I`로 진입점을 부른다. 현재 세대와 옛 2세대만 남긴다.

## 사고 보고

```
ops/bin/report-incident <wp> <kind> <detail>
```

`$KB_BUILD_ROOT/incidents.ndjson`(기본 `~/.cache/sagae-kb/build`)에 JSON 한 줄을 추가한다.
