"""인용 게이트(WP-08). 공개 함수: check_claim, liveness_stance. tick 4.5 gate_l1은 kb.gate.tick_stage."""
from kb.gate import support
from kb.gate.liveness import liveness_stance
from kb.gate.model import GATE_VERSION, GateCtx, GateResult
from kb.gate.quote import check_claim

__all__ = ["support", "check_claim", "liveness_stance", "GateCtx", "GateResult", "GATE_VERSION"]
