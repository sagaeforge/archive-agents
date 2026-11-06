"""모델 적재와 추론. 이 파일만 torch를 쓴다(import는 함수 안). venv-rank에서만 불러진다.
스텁(KB_RANK_STUB=1)은 해시 기반이라 torch 없이 시험이 돈다. 임베딩 결과는 int8 바이트로 돌려준다."""
from __future__ import annotations

import hashlib
import math

from kb.rank import conf
from kb.rank.store import quantize

QUERY_PREFIX, DOC_PREFIX = "query: ", "passage: "


def free_vram_mb() -> int | None:
    try:
        import torch
        if torch.cuda.is_available():
            return int(torch.cuda.mem_get_info()[0] // (1 << 20))
    except Exception:  # noqa: BLE001
        pass
    return None


def pick_device(min_free_mb: int = conf.MIN_FREE_VRAM_MB) -> str:
    """시작 시 여유 VRAM이 3 GB 이상이면 cuda, 아니면 cpu."""
    f = free_vram_mb()
    return "cuda" if f is not None and f >= min_free_mb else "cpu"


# ------------------------------------------------------------------ 스텁

def _bigrams(s: str) -> list[str]:
    s = "".join(s.lower().split())
    return [s[i:i + 2] for i in range(max(len(s) - 1, 1))]


class StubEmbedder:
    device = "stub"

    def encode_q8(self, texts: list[str], kind: str) -> list[bytes]:
        out = []
        for t in texts:
            v = [0.0] * conf.DIM
            for g in _bigrams(t):
                h = int.from_bytes(hashlib.blake2b(g.encode(), digest_size=4).digest(), "little")
                v[h % conf.DIM] += 1.0 if (h >> 20) & 1 else -1.0
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append(quantize([x / n for x in v]))
        return out


class StubReranker:
    device = "stub"

    def score(self, q: str, texts: list[str]) -> list[float]:
        a = set(_bigrams(q))
        return [6.0 * len(a & set(_bigrams(t))) / (len(a | set(_bigrams(t))) or 1) - 2.0 for t in texts]


# ------------------------------------------------------------------ 실제 모델

class Embedder:
    """KURE-v3 -> 평균 풀링(프롬프트 포함) -> 1024 절단 -> L2 -> int8. trust_remote_code를 쓰지 않는다."""

    def __init__(self, path, device: str):
        import torch
        from transformers import AutoModel, AutoTokenizer
        self.torch, self.device = torch, device
        self.tok = AutoTokenizer.from_pretrained(str(path))
        self.model = AutoModel.from_pretrained(str(path), dtype=torch.bfloat16 if device == "cuda" else torch.float32).to(device).eval()

    def encode_q8(self, texts: list[str], kind: str, batch: int = 16) -> list[bytes]:
        torch = self.torch
        pre = QUERY_PREFIX if kind == "query" else DOC_PREFIX
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        rows: list[bytes | None] = [None] * len(texts)
        for s in range(0, len(order), batch):
            idx = order[s:s + batch]
            enc = self.tok([pre + texts[i] for i in idx], padding=True, truncation=True, max_length=conf.DOC_MAXLEN, return_tensors="pt").to(self.device)
            with torch.inference_mode():
                h = self.model(**enc).last_hidden_state.float()
                m = enc["attention_mask"].unsqueeze(-1).float()
                v = (h * m).sum(1) / m.sum(1).clamp(min=1)
                v = torch.nn.functional.normalize(v[:, :conf.DIM], dim=-1)
                q8 = (v * 127).round().clamp(-127, 127).to(torch.int8).cpu().numpy()
            for j, i in enumerate(idx):
                rows[i] = q8[j].tobytes()
        return rows  # type: ignore[return-value]

    def close(self) -> None:
        del self.model
        if self.device == "cuda":
            self.torch.cuda.empty_cache()


class Reranker:
    """KURE-Reranker-nano. 점수는 원시 로짓이다(시그모이드를 걸지 않는다). GPU에서만 쓴다."""

    def __init__(self, path, device: str):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        self.torch, self.device = torch, device
        self.tok = AutoTokenizer.from_pretrained(str(path))
        self.model = AutoModelForSequenceClassification.from_pretrained(
            str(path), dtype=torch.float16 if device == "cuda" else torch.float32).to(device).eval()

    def score(self, q: str, texts: list[str], batch: int = 32) -> list[float]:
        torch = self.torch
        out: list[float] = []
        for s in range(0, len(texts), batch):
            part = [t[:conf.RERANK_CHARS] for t in texts[s:s + batch]]
            enc = self.tok([q] * len(part), part, padding=True, truncation="only_second", max_length=conf.RERANK_MAXLEN,
                           return_tensors="pt").to(self.device)
            with torch.inference_mode():
                out.extend(self.model(**enc).logits.float().reshape(len(part), -1)[:, 0].cpu().tolist())
        return out

    def close(self) -> None:
        del self.model
        if self.device == "cuda":
            self.torch.cuda.empty_cache()
