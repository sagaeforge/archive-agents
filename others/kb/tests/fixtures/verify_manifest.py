"""MANIFEST.json의 sha256이 실제 파일과 전부 일치하는지 검사한다. 불일치 시 exit 1."""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))


def main() -> int:
    with open(os.path.join(HERE, "MANIFEST.json"), encoding="utf-8") as f:
        entries = json.load(f)["files"]
    bad = []
    for e in entries:
        p = e["path"] if os.path.isabs(e["path"]) else os.path.join(ROOT, e["path"])
        try:
            digest = hashlib.sha256(open(p, "rb").read()).hexdigest()
        except OSError:
            bad.append((e["path"], "missing"))
            continue
        if digest != e["sha256"]:
            bad.append((e["path"], "mismatch"))
    for path, why in bad:
        print(f"FAIL {why}: {path}", file=sys.stderr)
    print(f"checked {len(entries)} files, failures {len(bad)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
