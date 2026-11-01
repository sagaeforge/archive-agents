from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIX = Path(__file__).parent / "fixtures"


def approve(home: Path, *nums: int) -> None:
    (home / "config" / "decisions.toml").write_text(f"approved = {list(nums)}\n")
