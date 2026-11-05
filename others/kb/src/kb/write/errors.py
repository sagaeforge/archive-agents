"""쓰기 경로 예외. 원장 예외(IdemConflict, VersionConflict)는 그대로 올린다."""
from __future__ import annotations

from kb.core.ledger import IdemConflict, LedgerError, RedactedPayload, VersionConflict

__all__ = ["WriteRejected", "IdemConflict", "VersionConflict", "RedactedPayload", "LedgerError"]


class WriteRejected(Exception):
    """입력 검증, 정책(R6), 지운 본문 재작성 같은 거부. code는 기계가 읽는 값이다."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message
        self.status = {"secret_detected": 422, "not_found": 404,
                       "expected_version_required": 428, "body_too_large": 413}.get(code, 400)
