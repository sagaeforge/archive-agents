"""kb agent run --reextract: 재추출에 없는 옛 주장 claim.retract, 같은 ID는 유지, LLM 주장 자동 supersede 0건, kb claim retract 대량 철회."""
import io
import json
from contextlib import redirect_stdout

from kb.extract import runner, settings

from . import helpers as H

S = ["샘플도구는 하루 최대 500건의 요청을 지원한다고 밝힌다.", "샘플도구는 파일 크기 상한을 2GB로 둔다고 밝힌다.", "샘플도구는 동시 연결을 최대 8개까지 허용한다고 밝힌다."]
DOC = "# 안내\n\n" + "\n\n".join(S) + "\n"


def _resp(subject, idx):
    def f(job):
        return {"claims": [H.claim_obj(subject, S[i][:-3], S[i][:-3] + "고 한다.") for i in idx if S[i] in job.window.text]}
    return f


def _run(ent, idx, model, **kw):
    f = H.Fake("claude", True, _resp(ent, idx))
    with settings.override(**{"openrouter.enabled": False, "claude.model": model}):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False, **kw)
    return out, f


def test_reextract_retracts_missing_keeps_same(ent):
    H.ingest_doc(text=DOC)
    _run(ent, [0, 1], "haiku")
    old = {r[4]: r for r in H.claims()}
    assert len(old) == 2
    out, f = _run(ent, [0, 2], "haiku2", reextract=True)
    assert f.calls and out["retracted"] == 1
    now = {r[4]: r for r in H.claims()}
    keep = old["샘플도구는 하루 최대 500건의 요청을 지원한다고 밝힌다."[:-3] + "고 한다."]
    assert now[keep[4]][0] == keep[0] and now[keep[4]][1] == "active"       # 같은 ID는 그대로
    assert now[keep[4]][5] == keep[5]                                      # 옛 extractor 표시도 그대로
    gone = old[S[1][:-3] + "고 한다."]
    assert now[gone[4]][1] == "dead"                                       # 재추출에 없는 옛 주장은 철회
    assert any("동시 연결" in k and v[1] == "active" for k, v in now.items())   # 새 주장
    assert len(H.events("claim.supersede")) == 0                           # LLM 주장 자동 대체 없음


def test_no_retract_without_reextract_flag(ent):
    H.ingest_doc(text=DOC)
    _run(ent, [0, 1], "haiku")
    # 같은 문단은 다시 뽑지 않는다. 모델만 바꿔 돌려도 철회 0
    _run(ent, [0], "haiku2")
    assert len(H.events("claim.retract")) == 0
    assert all(r[1] == "active" for r in H.claims())


def test_bulk_retract_by_extractor(ent, capsys):
    from kb.cli import main
    H.ingest_doc(text=DOC)
    _run(ent, [0, 1, 2], "haiku")
    ex = H.claims()[0][5]
    assert ex == "l2:claude:haiku:extract-2"
    rc = main(["claim", "retract", "--extractor", ex, "--json"])
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert rc == 0 and out["matched"] == 3 and out["retracted"] == 3
    assert all(r[1] == "dead" for r in H.claims())
    rc = main(["claim", "retract", "--extractor", ex, "--json"])
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["matched"] == 0
