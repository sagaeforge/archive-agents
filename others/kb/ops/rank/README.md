# kb-rank 운영 (WP-20)

벡터와 재순위는 파생물이다. 지워도 `kb index --full`로 다시 만든다. 조회는 kb-rank가 없어도 어휘로 끝까지 동작한다(R10).

| 항목 | 값 |
|---|---|
| 임베딩 | nlpai-lab/KURE-v3 @ c74871cd, 2048 -> 1024 Matryoshka 절단, L2, int8. 프롬프트 `query: `, `passage: ` |
| 재순위 | nlpai-lab/KURE-Reranker-nano @ 8514b9e1, 로짓 원값, max_length 512, 문단 500자, 하한 -2, GPU에서만 |
| 가중치 | `$KB_MODELS`(기본 `$KB_TOOLCHAIN/../models`) 디스크. `/tmp` 금지. `trust_remote_code` 미사용 |
| venv | `$KB_TOOLCHAIN/venv-rank`(torch 2.14.1, transformers 5.14.1, numpy 2.5.4). `ops/rank/requirements.txt`가 전체 고정본 |
| 색인 | `$KB_HOME/derived/vec/<build>/{vectors.npy,ids.txt,kinds.txt,shas.txt,meta.json}`, `current` symlink |
| 서비스 | `ops/systemd/kb-rank.{socket,service}` (설치는 결정 3 뒤). Unix 소켓 + JSON 한 줄, 요청 둘뿐 |

```
bash ops/bin/build-venv-rank --dry-run        # 받을 것과 경로만
bash ops/bin/build-venv-rank                  # venv-rank + 모델 (약 6 GB + 2.9 GB)
bash ops/bin/build-venv-rank --kb-only        # 배포 뒤 venv-rank의 kb 코드만 다시 설치
ops/bin/dev kb index --dry-run --json         # 임베딩 계획만
ops/bin/dev kb index --incremental --json
"$KB_TOOLCHAIN/venv-rank/bin/python" -I eval/embed/run.py --dataset ko-strategyqa --json
```

GPU는 다른 세션과 나눈다. 장치는 시작 시 여유 VRAM 3 GB 이상이면 CUDA, 아니면 CPU(재순위 없음, r=c)다.
유휴 5분에 가중치를 풀고 15분에 종료한다. 경합 중 측정값에는 `contended`를 붙인다(`eval/embed/run.py`가 시작 VRAM 사용량을 기록한다).
