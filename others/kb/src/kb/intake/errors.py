"""kb intake 오류. code는 CLI JSON의 error 필드로 나간다."""
from __future__ import annotations


class IntakeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
