"""L2 적재 정책(ADR-0004 3.1~3.3, D1). 소스마다 `l2: none|declared|prose|all`을 정한다. 기본은 all이다.

- none: L2 큐에 문단을 넣지 않는다. 결정적 파서가 이미 주장을 내고 산문이 없는 구조 자료(S), 번역본(X).
- declared: 파서가 산문이라고 선언한 구간(어댑터의 `prose`, 예: PyPI `info.description`)과 겹치는 문단만 넣는다.
  선언 구간은 저장하지 않고 표시 본문에서 그때그때 계산한다. 그래서 문단 색인(paras_sha), para_sha, done 키가 바뀌지 않는다.
- prose: 산문으로 보이는 문단만 넣는다(휴리스틱 is_prose). 보기 좋게 찍은 JSON을 산문으로 볼 수 있어 JSON 소스에는 쓰지 않는다.
- all: 전부 넣는다(옛 동작).

해석 순서: 소스 항목의 `l2` > 파서 기본값(PARSER_L2) > all. 알 수 없는 값, 등록되지 않은 소스, src:adhoc은 all이다
(정책이 깨져도 문단을 버리지 않는다). declared에서 선언 구간을 계산하지 못한 스냅샷(판정 불가)은 넣지 않고 보류 표식으로 남긴다
(패키지 packument처럼 문단이 수만 개인 본문이 통째로 L2에 가지 않게. 보류이므로 되돌릴 수 있다). 수집(L0)과 파싱(L1)은 정책과 무관하게 계속한다.

되돌릴 수 있다. 원장은 건드리지 않는다.
- 이미 큐에 있는 행 중 정책이 걸러 내는 것은 지우지 않고 state='skipped_policy'로 표시한다(sweep).
  정책이 넓어지면 같은 sweep이 그 행을 queued로 되돌린다.
- 적재 때 걸러 낸 문단은 행을 만들지 않는다. 대신 그 URL의 최신 스냅샷을 보류 표식(HELD)으로 남기고,
  정책이 넓어진 sweep이 그 스냅샷을 지금 정책으로 다시 적재한다."""
from __future__ import annotations

import bisect
import hashlib
import json
import re

from kb.core import cas, ledger, opsdb
from kb.core.conn import connect_ro
from kb.extract import state

QUEUE = "l2"
SKIPPED = "skipped_policy"
VALUES = ("none", "declared", "prose", "all")
SIG_KEY = "extract:l2policy:sig"
AT_KEY = "extract:l2policy:at"
HELD = "extract:l2policy:held:"         # + 소스 id + '|' + URL -> {snapshot, fetched_at}

# L1 파서가 구조 자료를 결정적 주장·시계열로 바꾸는 파서. 본문이 JSON·CSV·표다.
STRUCTURED_PARSERS = frozenset({"npm_meta", "pypi_meta", "github_repo_meta", "hn_algolia", "hf_models", "mcp_registry",
                                "kworb", "trends_rss", "csv", "codex_features"})
# 그중 산문 필드를 선언한 파서(어댑터의 prose): PyPI README, npm packument readme, HN story_text, CSV의 parse.prose 열
DECLARED_PARSERS = frozenset({"pypi_meta", "npm_meta", "hn_algolia", "csv"})
PARSER_L2 = {p: ("declared" if p in DECLARED_PARSERS else "none") for p in STRUCTURED_PARSERS}
_CHANGELOG_PARSERS = frozenset({"changelog_md", "github_release"})
_CHANGELOG_WORDS = ("changelog", "release-notes", "releases", "deprecations", "status", "whats-new")
_FEED_PARSERS = frozenset({"rss_atom", "arxiv"})


def _parser_name(parser: str | None) -> str:
    return str(parser or "").split("@", 1)[0]


def l2_of(raw: dict | None) -> str:
    """소스 항목(dict)의 L2 정책."""
    raw = raw or {}
    v = raw.get("l2")
    if isinstance(v, str) and v in VALUES:
        return v
    return PARSER_L2.get(_parser_name(raw.get("parser")), "all")


def category_of(raw: dict | None, source_id: str = "") -> str:
    """통계용 범주(ADR-0004 3.2): S 구조 자료, C 변경 로그, X 번역본, P 문서 산문, F 피드 본문, U 임의 URL.
    소스 항목의 `category`가 있으면 그 값을 쓴다."""
    raw = raw or {}
    sid = str(raw.get("id") or source_id)
    c = raw.get("category")
    if isinstance(c, str) and c in ("S", "C", "X", "P", "F", "U"):
        return c
    if sid == "src:adhoc":
        return "U"
    p = _parser_name(raw.get("parser"))
    if raw.get("translation_of"):
        return "X"
    if p in STRUCTURED_PARSERS:
        return "S"
    if p in _CHANGELOG_PARSERS or any(w in sid for w in _CHANGELOG_WORDS):
        return "C"
    if p in _FEED_PARSERS:
        return "F"
    return "P"


def table(srcs=None) -> dict:
    """{소스 id: (정책, 범주, 파서 이름, parse 설정)}. srcs를 주지 않으면 지금 레지스트리를 읽는다.
    시험은 (정책, 범주) 두 칸만 줘도 된다(entry가 채운다)."""
    if srcs is None:
        from kb.collect import registry
        try:
            srcs = registry.load_registry(validate=False)
        except Exception:  # noqa: BLE001  레지스트리를 못 읽으면 비워 둔다: 전부 all
            srcs = []
    out = {s.id: (l2_of(s.raw), category_of(s.raw, s.id), _parser_name(s.raw.get("parser")), dict(s.raw.get("parse") or {}))
           for s in srcs}
    out.setdefault("src:adhoc", ("all", "U", "", {}))
    return out


def entry(tab: dict, source_id: str | None) -> tuple:
    """(정책, 범주, 파서 이름, parse 설정). 없는 소스는 all."""
    e = tuple(tab.get(source_id or "") or ("all", "P"))
    return (e + ("", {}))[:4] if len(e) < 4 else e[:4]


def policy_of(tab: dict, source_id: str | None) -> str:
    return entry(tab, source_id)[0]


def invalid(srcs) -> list:
    """`l2` 값이 틀린 소스 id 목록(시험·점검용)."""
    return [s.id for s in srcs if "l2" in s.raw and s.raw["l2"] not in VALUES]


_WORD = re.compile(r"[^\W\d_]{2,}", re.UNICODE)
_KV_LINE = re.compile(r'^\s*"[^"]+"\s*:')


def is_prose(text: str) -> bool:
    """문단이 산문인가. 보수적으로 판정한다: 의심스러우면 True(버리지 않는다)보다
    명백한 구조 자료만 False로 한다. JSON 조각, 키-값 줄 위주, 글자가 거의 없는 줄."""
    t = (text or "").strip()
    if not t:
        return False
    if t[0] in "{[" and (t[-1] in "}]," or t.count('":') >= 2):
        return False
    lines = [x for x in t.splitlines() if x.strip()]
    if lines and sum(1 for x in lines if _KV_LINE.match(x)) * 2 >= len(lines):
        return False
    nonspace = sum(1 for ch in t if not ch.isspace())
    alpha = sum(1 for ch in t if ch.isalpha())
    if nonspace == 0 or alpha / nonspace < 0.4:
        return False
    return len(_WORD.findall(t)) >= 3


def _body(r):
    if not r or not r[0]:
        return {}
    b = r[0]
    return json.loads(b if isinstance(b, str) else b.decode("utf-8"))


def _ledger_snapshot(led, sid: str) -> dict:
    return _body(led.execute("SELECT p.body FROM event e JOIN payload p ON p.sha=e.payload_sha WHERE e.kind='snapshot.captured' "
                             "AND e.subject=? ORDER BY e.seq LIMIT 1", (sid,)).fetchone())


def _ledger_text(led, sid: str) -> dict:
    return _body(led.execute("SELECT p.body FROM event e JOIN payload p ON p.sha=e.payload_sha WHERE e.kind='snapshot.text' "
                             "AND e.subject=? ORDER BY e.seq DESC LIMIT 1", (sid,)).fetchone())


def declared_spans(parser: str, text: str, fmt: str, cfg: dict | None) -> list | None:
    """파서가 선언한 산문 구간. 선언이 없는 파서는 빈 목록(산문 없음), 계산하지 못하면 None(판정 불가)."""
    from kb.parse import adapters
    a = adapters.get(parser)
    if a is None or a.prose is None:
        return []
    try:
        sp = a.prose(text, fmt, cfg or {})
    except Exception:  # noqa: BLE001  선언 함수가 깨져도 문단을 버리지 않는다
        return None
    return None if sp is None else sorted((int(x), int(y)) for x, y in sp if y > x)


class ParaFilter:
    """prose·declared 정책의 문단 판정. 스냅샷의 표시 본문을 한 번만 읽는다.
    undecided=True: 본문을 못 읽었거나 선언 구간을 계산하지 못했다. prose는 전부 넣고, declared는 하나도 넣지 않는다(보류)."""

    def __init__(self, text_payload: dict, mode: str = "prose", parser: str = "", cfg: dict | None = None):
        self.mode = mode
        self.text = None
        self.paras = {}
        self.spans: list = []
        try:
            self.text = cas.get(text_payload["text_sha"]).decode("utf-8")
            for x in json.loads(cas.get(text_payload["paras_sha"]).decode("utf-8")):
                self.paras[(x["para_sha"], x["start_cp"])] = (x["start_cp"], x["end_cp"])
        except Exception:  # noqa: BLE001  본문을 못 읽으면 걸러 내지 않는다
            self.text = None
        sp = None
        if self.text is not None and mode == "declared":
            sp = declared_spans(parser, self.text, str(text_payload.get("text_format") or ""), cfg)
            if sp is not None:
                self.spans = sp
                self._starts = [a for a, _ in sp]
                self._ends = [b for _, b in sp]
        self.undecided = self.text is None or (mode == "declared" and sp is None)

    def _overlaps(self, a: int, b: int) -> bool:
        i = bisect.bisect_left(self._ends, a + 1)          # 끝이 a보다 큰 첫 구간
        return i < len(self.spans) and self._starts[i] < b

    def keep(self, para_sha: str, start_cp: int) -> bool:
        declared = self.mode == "declared"
        if self.undecided:
            return not declared
        span = self.paras.get((para_sha, start_cp))
        if span is None:
            return not declared
        if declared:
            return self._overlaps(span[0], span[1])
        return is_prose(self.text[span[0]:span[1]])


class _Drop:
    undecided = False

    def keep(self, para_sha: str, start_cp: int) -> bool:
        return False


DROP = _Drop()


def filter_for(tab: dict, source_id: str | None, text_payload: dict):
    """정책에 맞는 문단 판정기. None은 전부 넣는다(all)."""
    pol, _, parser, cfg = entry(tab, source_id)
    if pol == "all":
        return None
    if pol == "none":
        return DROP
    return ParaFilter(text_payload, pol, parser, cfg)


def _held_key(cap: dict) -> str | None:
    src, url = cap.get("source"), cap.get("url")
    return f"{HELD}{src}|{url}" if src and url else None


def _mark_held(c, cap: dict, sid: str, held: bool) -> None:
    """URL마다 최신 스냅샷 하나만 보류 표식으로 둔다. 걸러 낸 문단이 없으면 표식을 지운다(더 새 스냅샷의 표식은 두고)."""
    k = _held_key(cap)
    if k is None:
        return
    at = int(cap.get("fetched_at") or 0)
    r = c.execute("SELECT v FROM tick_state WHERE k=?", (k,)).fetchone()
    cur = json.loads(r[0]) if r and r[0] else None
    if cur is not None and cur.get("snapshot") != sid and int(cur.get("fetched_at") or 0) > at:
        return
    if held:
        opsdb.tick_state_set(c, k, json.dumps({"snapshot": sid, "fetched_at": at}, sort_keys=True))
    elif cur is not None:
        c.execute("DELETE FROM tick_state WHERE k=?", (k,))


def enqueue_snapshot(c, tab: dict, sid: str, paras: list, text_payload: dict, cap: dict, dom: str | None = None,
                     *, done: set | None = None, dry_run: bool = False) -> dict:
    """스냅샷 하나의 문단을 지금 정책으로 L2 큐에 넣는다. 멱등.
    - 이미 추출한 문단(done)은 건너뛴다. 정책이 거르는 문단은 행을 만들지 않고 보류 표식을 남긴다.
    - 정책이 받는 문단의 행이 skipped_policy로 남아 있으면 queued로 되돌린다.
    반환: {queued, revived, skipped_done, skipped_policy, undecided}."""
    from kb.extract import cache, windows
    out = {"queued": 0, "revived": 0, "skipped_done": 0, "skipped_policy": 0, "undecided": 0}
    flt = filter_for(tab, cap.get("source"), text_payload)
    if flt is not None and flt.undecided:
        out["undecided"] = 1
    done = cache.done_keys([x["para_sha"] for x in paras]) if done is None else done
    for x in paras:
        if x["para_sha"] in done:
            out["skipped_done"] += 1
            continue
        if flt is not None and not flt.keep(x["para_sha"], x["start_cp"]):
            out["skipped_policy"] += 1
            continue
        ref = windows.ref_of(sid, x["para_sha"], x["start_cp"])
        if dry_run:
            st = c.execute("SELECT state FROM queue WHERE kind=? AND ref=?", (QUEUE, ref)).fetchone()
            out["queued" if st is None else "revived"] += 1 if st is None or st[0] == SKIPPED else 0
            continue
        if opsdb.queue_put(c, QUEUE, ref, domain=dom):
            out["queued"] += 1
        else:
            out["revived"] += c.execute("UPDATE queue SET state='queued', next_at=NULL WHERE kind=? AND ref=? AND state=?",
                                        (QUEUE, ref, SKIPPED)).rowcount
    if not dry_run:
        _mark_held(c, cap, sid, out["skipped_policy"] > 0)
    return out


def _add(out: dict, key: str, src: str, cat: str, n: int) -> None:
    if not n:
        return
    out[key] += n
    out[f"{key}_by_source"][src] = out[f"{key}_by_source"].get(src, 0) + n
    out[f"{key}_by_category"][cat] = out[f"{key}_by_category"].get(cat, 0) + n


def sweep(c, led=None, tab: dict | None = None, *, dry_run: bool = False) -> dict:
    """큐 행과 보류 표식을 지금 정책에 맞춘다. 행과 원장은 지우지 않는다. 멱등: 두 번째 호출은 0행을 바꾼다.
    1) queued·taken 행 중 정책이 거르는 것 -> skipped_policy. skipped_policy 행 중 정책이 받는 것 -> queued(restored).
    2) 보류 표식의 스냅샷을 지금 정책으로 다시 적재한다(held_queued). none이면 건너뛴다.
    반환: {skipped, restored, held_queued, by_source, by_category(skipped 기준), restored_by_source, ..., snapshots, unknown, undecided}."""
    tab = tab if tab is not None else table()
    own = led is None
    led = led or connect_ro(ledger.ledger_path(), 900.0)       # 원장은 읽기만 한다
    out = {"skipped": 0, "skipped_by_source": {}, "skipped_by_category": {},
           "restored": 0, "restored_by_source": {}, "restored_by_category": {},
           "held_queued": 0, "held_queued_by_source": {}, "held_queued_by_category": {},
           "snapshots": 0, "unknown": 0, "undecided": 0, "dry_run": dry_run}
    try:
        sids = [r[0] for r in c.execute("SELECT DISTINCT substr(ref, 1, instr(ref, '|') - 1) FROM queue WHERE kind=? "
                                        "AND state IN ('queued','taken',?)", (QUEUE, SKIPPED))]
        for sid in sids:
            src = _ledger_snapshot(led, sid).get("source")
            if src is None:
                out["unknown"] += 1
                continue
            pol, cat = entry(tab, src)[:2]
            lo, hi = sid + "|", sid + "}"           # '|' 다음 문자. ref 인덱스 범위 조회
            sk = rs = 0
            if pol in ("all", "none"):
                frm, to = ((SKIPPED,), "queued") if pol == "all" else (("queued", "taken"), SKIPPED)
                ph = ",".join("?" * len(frm))
                if dry_run:
                    n = c.execute(f"SELECT count(*) FROM queue WHERE kind=? AND state IN ({ph}) AND ref>=? AND ref<?",
                                  (QUEUE, *frm, lo, hi)).fetchone()[0]
                else:
                    extra = ", next_at=NULL" if to == "queued" else ""
                    n = c.execute(f"UPDATE queue SET state=?{extra} WHERE kind=? AND state IN ({ph}) AND ref>=? AND ref<?",
                                  (to, QUEUE, *frm, lo, hi)).rowcount
                rs, sk = (n, 0) if pol == "all" else (0, n)
            else:                                    # declared, prose
                flt = filter_for(tab, src, _ledger_text(led, sid))
                out["undecided"] += 1 if flt.undecided else 0
                for rid, ref, st in c.execute("SELECT id, ref, state FROM queue WHERE kind=? AND ref>=? AND ref<?",
                                              (QUEUE, lo, hi)).fetchall():
                    _, para_sha, start = ref.split("|")
                    keep = flt.keep(para_sha, int(start))
                    if keep and st == SKIPPED:
                        rs += 1
                        if not dry_run:
                            c.execute("UPDATE queue SET state='queued', next_at=NULL WHERE id=?", (rid,))
                    elif not keep and st in ("queued", "taken"):
                        sk += 1
                        if not dry_run:
                            c.execute("UPDATE queue SET state=? WHERE id=?", (SKIPPED, rid))
            _add(out, "skipped", src, cat, sk)
            _add(out, "restored", src, cat, rs)
            out["snapshots"] += 1 if sk or rs else 0
        for (k, v) in c.execute("SELECT k, v FROM tick_state WHERE k LIKE ? ESCAPE '\\'",
                                (HELD.replace("_", "\\_") + "%",)).fetchall():
            src = k[len(HELD):].split("|", 1)[0]
            pol, cat = entry(tab, src)[:2]
            if pol == "none":
                continue
            sid = (json.loads(v) if v else {}).get("snapshot")
            tp, cap = (_ledger_text(led, sid), _ledger_snapshot(led, sid)) if sid else ({}, {})
            try:
                paras = json.loads(cas.get(tp["paras_sha"]).decode("utf-8"))
            except Exception:  # noqa: BLE001  본문이 없으면 표식만 남긴다
                continue
            doms = [d for d in (cap.get("domain") or []) if d]
            r = enqueue_snapshot(c, tab, sid, paras, tp, cap, doms[0] if doms else None, dry_run=dry_run)
            out["undecided"] += r["undecided"]
            _add(out, "held_queued", src, cat, r["queued"])
            _add(out, "restored", src, cat, r["revived"])
    finally:
        if own:
            led.close()
    out["by_source"], out["by_category"] = out["skipped_by_source"], out["skipped_by_category"]
    return out


def sources_of(led, sids) -> dict:
    """{스냅샷 id: 소스 id}. 원장 snapshot.captured에서 읽는다. 없으면 빠진다."""
    out = {}
    for sid in sids:
        src = _ledger_snapshot(led, sid).get("source")
        if src is not None:
            out[sid] = src
    return out


def _spec(parser: str) -> str:
    from kb.parse import adapters
    a = adapters.get(parser)
    return str(getattr(a.prose, "spec", a.prose.__qualname__)) if a is not None and a.prose is not None else ""


def signature(tab: dict) -> str:
    """정책 표의 판본. 정책 값과, declared 소스의 선언(어댑터 선언, parse.prose 설정)이 바뀌면 달라진다."""
    rows = []
    for k in sorted(tab):
        pol, _, parser, cfg = entry(tab, k)
        rows.append((k, pol) if pol != "declared" else (k, pol, _spec(parser), json.dumps((cfg or {}).get("prose"), sort_keys=True)))
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()[:16]


def sweep_if_changed(tab: dict | None = None) -> dict:
    """정책 표가 바뀐 첫 tick에만 큐 전체를 훑는다. 같은 표면 건너뛴다. 판본 표식은 sweep 뒤에 쓴다(중간에 죽으면 다시 훑을 뿐이다)."""
    tab = tab if tab is not None else table()
    sig = signature(tab)
    if state.get(SIG_KEY) == sig:
        return {"skipped": 0, "swept": False}
    c = opsdb.connect()
    try:
        out = sweep(c, tab=tab)
    finally:
        c.close()
    state.put(SIG_KEY, sig)
    state.put(AT_KEY, opsdb._now())
    out["swept"] = True
    return out
