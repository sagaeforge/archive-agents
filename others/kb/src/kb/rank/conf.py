"""kb-rank 설정값과 경로. 숫자는 ADR-0001 14.2, 모델 리비전은 2026-11-01 Hugging Face API 확인값이다."""
from __future__ import annotations

import os
from pathlib import Path

from kb.core import paths

MODELS = {
    "embed": {"repo": "nlpai-lab/KURE-v3", "rev": "c74871cd57f3377c8b7c3ed9f4ac0fff22a898a3", "dir": "kure-v3",
              "files": ["*.json", "model.safetensors", "LICENSE*", "NOTICE"]},
    "rerank": {"repo": "nlpai-lab/KURE-Reranker-nano", "rev": "8514b9e113f3b27c441ed9c2b50f81d80388b2fd", "dir": "kure-reranker-nano",
               "files": ["*.json", "model.safetensors", "vocab.txt", "README.md"]},
}
DIM = 1024                 # KURE-v3 Matryoshka 절단(2048 -> 1024), L2 재정규화 뒤 int8
CAND_FACT = 15             # 사실(claim, record) Dense 후보
CAND_PASSAGE = 10          # 문단 Dense 후보
CAND_LEX = 10              # 어휘 후보
CAND_ENTITY = 5            # 엔티티의 현재 주장
LOGIT_FLOOR = -2.0         # 재순위 로짓 하한(미만은 버린다)
RERANK_MAXLEN = 512        # 문단 500자 기준
RERANK_CHARS = 500
DOC_MAXLEN = 512           # 색인할 때 문서 토큰 상한
CLIENT_TIMEOUT_S = 8.0     # 이 안에 답이 없으면 어휘로 강등
IDLE_EXIT_S = 900          # 유휴 15분에 서비스 종료
GPU_RELEASE_S = 300        # 유휴 5분에 가중치와 VRAM 해제(다른 세션과 GPU를 나눈다)
MIN_FREE_VRAM_MB = 3072    # 시작 시 여유 VRAM이 이 이상이면 CUDA
KIND_LETTER = {"claim": "c", "record": "r", "node": "e", "document": "p"}
FACT = "cr"                # 사실 종류 글자
STUB_ENV = "KB_RANK_STUB"  # 1이면 해시 기반 스텁 모델(시험용)


def models_dir() -> Path:
    m = os.environ.get("KB_MODELS")
    return Path(m) if m else paths.toolchain_dir().parent / "models"


def model_path(key: str) -> Path:
    return models_dir() / MODELS[key]["dir"]


def sock_path() -> Path:
    s = os.environ.get("KB_RANK_SOCK")
    return Path(s) if s else paths.kb_home() / "run" / "kb-rank.sock"


def vec_root() -> Path:
    return paths.kb_home() / "derived" / "vec"


def venv_rank_python() -> Path:
    return paths.toolchain_dir() / "venv-rank" / "bin" / "python"


def stub() -> bool:
    return os.environ.get(STUB_ENV) == "1"
