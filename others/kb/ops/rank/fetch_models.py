"""모델 가중치를 리비전 고정으로 내려받는다(venv-rank에서 실행). trust_remote_code는 쓰지 않는다.
  python -I ops/rank/fetch_models.py --dest "$KB_MODELS" [--only embed|rerank]
리비전은 2026-11-01 Hugging Face API로 확인한 main의 커밋이다(kb.rank.conf.MODELS와 같은 값)."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from kb.rank import conf  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", required=True)
    ap.add_argument("--only", choices=sorted(conf.MODELS))
    a = ap.parse_args()
    if a.dest.startswith(("/tmp", "/var/tmp")):
        print("fetch_models: /tmp 아래에는 두지 않는다", file=sys.stderr)
        return 1
    from huggingface_hub import snapshot_download
    for key, m in conf.MODELS.items():
        if a.only and key != a.only:
            continue
        d = Path(a.dest) / m["dir"]
        snapshot_download(m["repo"], revision=m["rev"], local_dir=str(d), allow_patterns=m["files"])
        (d / ".revision").write_text(m["rev"] + "\n")
        print(f"{m['repo']}@{m['rev'][:12]} -> {d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
