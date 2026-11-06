"""패키지·저장소 메타 어댑터: github_release, github_repo_meta, npm_meta, pypi_meta."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

from kb.core import ids
from kb.parse.adapters import adapter
from kb.parse.adapters._common import day_points, json_prose
from kb.parse.model import Claim, Edge, Entity, Result, Series, pointer, ptr_escape, slugify


def _repo_of(url: str) -> tuple[str, str] | None:
    m = re.match(r"^/repos/([^/]+)/([^/]+)", urlsplit(url).path)
    return (m.group(1), m.group(2)) if m else None


def _repo_entity(ctx) -> Entity | None:
    c = (ctx.cfg or {}).get("entity")
    if c:
        t = str(c.get("type", "Repo"))
        return Entity(ids.entity_id(t.lower(), c["slug"]), t, c.get("label", c["slug"]))
    r = _repo_of(ctx.url)
    if not r:
        return None
    return Entity(ids.entity_id("repo", slugify(f"{r[0]}-{r[1]}")), "Repo", f"{r[0]}/{r[1]}",
                  {"html_url": f"https://github.com/{r[0]}/{r[1]}"})


def _json_or_empty(ctx):
    d = ctx.json()
    if isinstance(d, dict) and set(d) <= {"message", "documentation_url", "status", "errors"} and "message" in d:
        return None
    return d


@adapter("github_release", hint="json")
def github_release(ctx) -> Result:
    d = _json_or_empty(ctx)
    ent = _repo_entity(ctx)
    res = Result()
    if d is None or ent is None:
        res.notes.append("no_release")
        return res
    base = ""
    if isinstance(d, list):
        d = [x for x in d if isinstance(x, dict) and not x.get("draft") and not x.get("prerelease")] or [x for x in d if isinstance(x, dict)]
        if not d:
            res.notes.append("no_release")
            return res
        d, base = d[0], "/0"
    res.entities.append(ent)
    tag = d.get("tag_name")
    if tag:
        res.claims.append(Claim(ent.id, "latest_version", tag, f"{ent.label}의 최신 릴리스 태그는 {tag}이다.",
                                pointer(f"{base}/tag_name", tag)))
    pub = d.get("published_at")
    if tag and pub:
        res.claims.append(Claim(ent.id, "released_on", pub[:10], f"{ent.label} {tag}은(는) {pub[:10]}에 게시되었다.",
                                pointer(f"{base}/published_at", pub), kind="event", valid_from=pub[:10], precision="day",
                                qualifiers={"tag": tag}))
    res.count = 1
    return res


@adapter("github_repo_meta", hint="json")
def github_repo_meta(ctx) -> Result:
    d = _json_or_empty(ctx)
    ent = _repo_entity(ctx)
    res = Result()
    if d is None or ent is None or not isinstance(d, dict):
        res.notes.append("no_repo")
        return res
    ent.props = dict(ent.props or {}, html_url=d.get("html_url") or (ent.props or {}).get("html_url"),
                     description=(d.get("description") or "")[:300] or None, fork=bool(d.get("fork")))
    ent.props = {k: v for k, v in ent.props.items() if v is not None}
    res.entities.append(ent)
    lic = (d.get("license") or {}).get("spdx_id")
    if lic and lic != "NOASSERTION":
        res.claims.append(Claim(ent.id, "license", lic, f"{ent.label}의 라이선스는 {lic}이다.", pointer("/license/spdx_id", lic)))
    if "archived" in d:
        v = "archived" if d["archived"] else "unarchived"
        res.claims.append(Claim(ent.id, "maintained_status", v,
                                f"{ent.label} 저장소는 GitHub에서 {'보관(archived)' if d['archived'] else '보관되지 않은'} 상태다.",
                                pointer("/archived", d["archived"])))
    slug = ent.id.split(":", 2)[2]
    if isinstance(d.get("stargazers_count"), int):
        res.series.append(Series(f"stars-{slug}", f"{ent.label} 스타 수", "stars", day_points(ctx, d["stargazers_count"], "count"),
                                 unit="count", subject=ent.id, granularity="day"))
    res.count = 1
    return res


def _npm_latest(d: dict):
    """(이름, 최신 버전, 버전 문서, 버전 문서의 포인터 접두). 세 모양을 받는다:
    버전 문서(`/<pkg>/latest`: name, version), 전체 packument(dist-tags, versions, license), 축약 메타(Accept: application/vnd.npm.install-v1+json,
    license 없음). 모양을 못 알아보면 None."""
    name = d.get("name")
    if not isinstance(name, str) or not name:
        return None
    if isinstance(d.get("version"), str) and d["version"]:
        return name, d["version"], d, ""
    tags = d.get("dist-tags")
    latest = tags.get("latest") if isinstance(tags, dict) else None
    if not isinstance(latest, str) or not latest:
        return None
    vers = d.get("versions")
    vdoc = vers.get(latest) if isinstance(vers, dict) else None
    return name, latest, vdoc if isinstance(vdoc, dict) else {}, f"/versions/{ptr_escape(latest)}"


# 산문 선언(ADR-0004 D1): 전체 packument의 `/readme`만 L2로 간다. 버전 문서와 축약 메타에는 readme가 없다.
# Accept 제약(D1 검토 2026-11-04): 축약 메타는 `Accept: application/vnd.npm.install-v1+json`로 받고 응답 content-type도
# 그 값이다. 소스의 `expect.content_type`이 application/json뿐이라 지금 Accept만 바꾸면 수집 기대 검사가 실패한다.
# 형식을 바꿀 때는 expect.content_type에 그 값을 더하고, 축약 메타에는 readme와 license가 없다는 점(산문 0, license 주장 없음)을 감안한다.
@adapter("npm_meta", hint="json", prose=json_prose("/readme"))
def npm_meta(ctx) -> Result:
    d = ctx.json()
    res = Result()
    got = _npm_latest(d) if isinstance(d, dict) else None
    if got is None:
        res.notes.append("no_package")
        return res
    name, version, vdoc, vptr = got
    ent = Entity(ids.entity_id("package", "npm-" + slugify(name)), "Package", name, {"registry": "npm"})
    res.entities.append(ent)
    vp = "/dist-tags/latest" if vptr else "/version"
    res.claims.append(Claim(ent.id, "latest_version", version, f"npm 패키지 {name}의 최신 버전은 {version}이다.", pointer(vp, version)))
    lic, lptr = (d.get("license"), "/license") if isinstance(d.get("license"), str) and d.get("license") else (vdoc.get("license"), vptr + "/license")
    if isinstance(lic, str) and lic:
        res.claims.append(Claim(ent.id, "license", lic, f"npm 패키지 {name}의 라이선스 표기는 {lic}이다.", pointer(lptr, lic)))
    dep = vdoc.get("deprecated")
    if dep:
        res.claims.append(Claim(ent.id, "maintained_status", "deprecated",
                                f"npm 패키지 {name}의 이 버전은 deprecated로 표시되어 있다.", pointer(vptr + "/deprecated", dep),
                                qualifiers={"version": version}))
    res.count = 1
    return res


@adapter("pypi_meta", hint="json", prose=json_prose("/info/description"))     # info.description은 README 전문이다
def pypi_meta(ctx) -> Result:
    d = ctx.json()
    info = d.get("info") if isinstance(d, dict) else None
    res = Result()
    if not isinstance(info, dict) or not info.get("name") or not info.get("version"):
        res.notes.append("no_package")
        return res
    ent = Entity(ids.entity_id("package", "pypi-" + slugify(info["name"])), "Package", info["name"], {"registry": "pypi"})
    res.entities.append(ent)
    res.claims.append(Claim(ent.id, "latest_version", info["version"], f"PyPI 패키지 {info['name']}의 최신 버전은 {info['version']}이다.",
                            pointer("/info/version", info["version"])))
    lic = info.get("license_expression")
    if isinstance(lic, str) and lic and len(lic) <= 80:
        res.claims.append(Claim(ent.id, "license", lic, f"PyPI 패키지 {info['name']}의 라이선스 표현식은 {lic}이다.",
                                pointer("/info/license_expression", lic)))
    if info.get("yanked"):
        res.claims.append(Claim(ent.id, "maintained_status", "yanked", f"PyPI 패키지 {info['name']} {info['version']}은(는) yanked 상태다.",
                                pointer("/info/yanked", True), qualifiers={"version": info["version"]}))
    res.count = 1
    return res
