"""게이트 입력 문맥과 결과 값(ADR 10.6). 여기에는 로직이 없다."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

GATE_VERSION = "gate@1"
# G 도메인 단위 타입(노드 type의 소문자). 이 타입의 G 주어는 생존 상태가 있어야 한다(ADR 9.2, 10.6 9단계).
G_UNIT_TYPES = frozenset({"repo", "package", "feature", "model", "document"})
# 도메인 정보가 비어 있을 때도 G로 보는 타입(개발 도구 전용)
G_ONLY_TYPES = frozenset({"repo", "package", "feature", "model"})
SUPPORT_CHECK_CODES = ("R_VALUE_MISMATCH", "R_SUBJECT_CONTEXT", "R_ALIAS_MISMATCH")


@dataclass
class GateCtx:
    """check_claim이 주장 밖에서 필요로 하는 것. 조회는 호출자가 한다(게이트는 DB를 열지 않는다)."""
    subject: str = ""                                # 엔티티 공개 ID
    subject_aliases: tuple = ()                       # 라벨 + 별칭
    known_aliases: dict = field(default_factory=dict)  # 정규화 별칭 -> 등록 엔티티 ID (R_ALIAS_MISMATCH용)
    doc_title: str = ""                               # 문서 제목(없으면 빈 문자열)
    publisher: str | None = None                      # 소스 발행처. 판단어·howto의 화자 확정에 쓴다
    source_names: tuple = ()                          # 소스 이름·발행처·레지스트리 별칭. 5단계 주어 문맥에만 쓴다(문서 제목이 'Changelog'뿐일 때)
    liveness: Callable[[str], str | None] | None = None  # liveness_stance. None이면 9단계를 건너뛴다
    scope: str = "public"                             # public | sensitive


@dataclass
class GateResult:
    result: str                                       # accepted | needs_review | rejected
    code: str | None = None                           # 대표 코드(첫 번째)
    detail: str | None = None
    codes: list = field(default_factory=list)         # needs_review 사유 전부
    verification: str = "unverified"                  # quote_found | needs_review | unverified
    start_cp: int | None = None
    end_cp: int | None = None
    exact: str | None = None                          # 표시 본문의 원문 조각(오프셋 환산 결과)
    stance: str | None = None
    speaker: str | None = None
    judgement: bool = False
    quarantine: bool = False

    @property
    def accepted(self) -> bool:
        return self.result == "accepted"

    @property
    def rejected(self) -> bool:
        return self.result == "rejected"

    @property
    def support_check_eligible(self) -> bool:
        """0003 2장 함의 판정 경로 대상: 공개 범위의 R_VALUE/SUBJECT/ALIAS뿐. 판단어 문장은 오지 않는다(RULE-17)."""
        return (self.result == "needs_review" and not self.judgement
                and any(c in SUPPORT_CHECK_CODES for c in self.codes))

    def as_dict(self) -> dict:
        return {"result": self.result, "code": self.code, "detail": self.detail, "codes": list(self.codes),
                "verification": self.verification, "start_cp": self.start_cp, "end_cp": self.end_cp,
                "stance": self.stance, "speaker": self.speaker, "judgement": self.judgement}
