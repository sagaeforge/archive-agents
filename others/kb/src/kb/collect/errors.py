"""수집 계층 예외. 코드(code)는 CLI와 호출자가 쓰는 짧은 문자열이다."""
from __future__ import annotations


class CollectError(Exception):
    code = "E_COLLECT"


class Blocked(CollectError):
    """safe_fetch가 네트워크 규칙으로 막았다. 메시지는 '<분류>:<상세>' 형식이고 분류는 scheme, userinfo, addr, port,
    too_large, deadline, redirect 중 하나다."""
    code = "E_BLOCKED"

    @property
    def kind(self) -> str:
        return str(self).split(":", 1)[0]


class PolicyError(CollectError):
    """정책으로 호출 자체를 하지 않았다(거부 호스트, 비활성, 미승인 결정, 연락처 없음)."""
    code = "E_POLICY"


class HostDenied(PolicyError, Blocked):
    def __init__(self, msg: str, host: str | None = None):
        super().__init__(msg)
        self.host = host


class FetchError(CollectError):
    """일시적 네트워크 오류(DNS, 연결, TLS, 읽기 시간 초과)."""
    code = "E_FETCH"


class RegistryError(CollectError):
    """소스 레지스트리 설정 오류."""
    code = "E_REGISTRY"
