# Verification of the viewer research (as of 2026-10-31)

Scope: `oss-viewers.md`, `ui-blocks.md` and `trends.md`, checked against primary sources (GitHub API and source at tagged versions, npm and PyPI registries, official docs and specs).

Nothing third-party was installed or run. "Confirmed" below means a primary source says so, not that it was observed working. Every statement about behaviour comes from reading source or docs.

Bottom line: the viewer's architecture survives, but three parts of the recommended stack would fail as written. Sigma 4 cannot draw Hangul labels at KB scale. openapi-typescript crashes on the TypeScript version the recommended scaffold installs. `@hono/mcp` cannot speak the MCP revision the trends track recommends. All three have cheap fixes (sections 1 and 2).

## 1. Corrections, ranked by decision impact

### C1. Blocker: sigma 4 cannot render Hangul labels at KB scale

**Reports say:** ui-blocks section 3 calls this unconfirmed: the atlas paginates, "I could not confirm how multi-page drawing is bound", and "Search of the issue tracker found nothing on CJK". Trends M1 builds the community map on sigma's SDF labels.

**Refuted. The question is already answered upstream.**

- Both label programs upload only the first atlas page. The node program contains `// Currently only support single atlas texture` followed by `const imageData = textures[0];` ([factory.ts at sigma@4.0.4](https://github.com/jacomyal/sigma.js/blob/sigma%404.0.4/packages/sigma/src/rendering/nodes/labels/factory.ts)). The [edge program](https://github.com/jacomyal/sigma.js/blob/sigma%404.0.4/packages/sigma/src/rendering/edges/labels/factory.ts) does the same, and `main` is unchanged.
- [Issue #1552](https://github.com/jacomyal/sigma.js/issues/1552) reports exactly this on a real CJK graph, reproduced in Chromium on Linux and WSL2. So the tracker does have a CJK report.
- [PR #1554](https://github.com/jacomyal/sigma.js/pull/1554) fixed only a related 1px crop bug. It states that "glyphs past the first page remain undrawn" and that `GlyphMetrics.atlasIndex` is "recorded but never read by any consumer".
- #1552 is closed and none of the [6 open issues](https://github.com/jacomyal/sigma.js/issues) covers the remainder, so nothing upstream tracks it.

**Capacity is lower than the report's 576.** Atlas font size is `64 * pixelRatio`, so 576 is the best case at DPR 1. Worst-case arithmetic, using a full em box, buffer 8, margin 2 and a 2048 px page:

| devicePixelRatio | Glyphs on page 0 |
|---|---|
| 1 | about 576 |
| 1.25 | about 400 |
| 1.5 | about 289 (#1552 observes multi-page from "~300+") |
| 2 | about 196 |

**Demand exceeds that.** KS X 1001 alone has 2,350 Hangul syllables (counted locally from the `euc_kr` codec), and ui-blocks' own spike plans 3,000. The trigger is distinct code points, not node count. The atlas only grows, so failures depend on what the user has already panned past, which #1552 describes as flaky. The KB's real syllable count is unknown, but overflow is the safe assumption for 10k entities.

**Failure mode.** Upstream says "undrawn" or "empty plate". By my reading, `processCharacter` writes page-N coordinates with no page check, so a quad may sample page 0 and show a *wrong* character. Not run. Either outcome is unacceptable in a provenance viewer.

**No setting fixes it.** `new SDFAtlasManager({ fontSize })` hard-codes the rest, and the defaults are not exported from the package index. #1552 notes that raising `maxTextureSize` "only postpones overflow".

**Action.** Stop treating spike item 2 as an open question and promote the overlay from fallback to plan.

| Option | What it takes | Trade-off |
|---|---|---|
| **A. sigma 4 + own label overlay** (recommended first spike) | `renderLabels: false`, then draw a Canvas 2D or DOM layer on `afterRender` using `graphToViewport` | Keeps `layerDashed`, styles and heatmaps. `getNodeDisplayedLabels()` is empty in this mode because `computeDisplayedNodeLabels()` is gated on `renderLabels`, so label selection is ours. An untested variant keeps sigma's selection by leaving labels on with a transparent colour and reading that set |
| **B. sigma 3.0.3 + @react-sigma/core 5.0.6** | Stay on the line [Gephi Lite 1.1.0 still uses](https://github.com/gephi/gephi-lite/blob/dev/packages/gephi-lite/package.json). Labels use canvas `fillText` ([source at 3.0.2](https://github.com/jacomyal/sigma.js/blob/sigma%403.0.2/packages/sigma/src/rendering/node-labels.ts)), so no atlas limit | Loses `layerDashed` and the styles API. Older line, though 3.0.3 shipped 2026-04-30 |
| **C. Fix upstream** | File an issue. The PR #1554 author offered a follow-up (texture array or per-character page index) | Real shader work with an unknown timeline. Do not plan on it |

Knock-on effect: ui-blocks rejects cosmos.gl mainly for having "no built-in labels". If sigma needs an overlay too, that gap closes, so cosmos.gl is a more credible fallback than the report implies. Sigma still leads on dashes, the React binding and graphology.

### C2. Blocker: openapi-typescript crashes on the TypeScript the scaffold installs

**Report says:** "It stays low-risk", with risk limited to no release since February.

**Refuted.**

- `create-vite`'s React-TS template pins [`typescript ~7.0.2`](https://github.com/vitejs/vite/blob/main/packages/create-vite/template-react-ts/package.json), and npm `latest` is 7.0.2 (2026-07-08).
- [TypeScript 7.0 "does not ship with an API"](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/). A new, different one is expected in 7.1.
- openapi-typescript 7.13.0 peers `typescript ^5.x` and uses `ts.factory` at runtime. [#2841](https://github.com/openapi-ts/openapi-typescript/issues/2841) shows `TypeError: Cannot read properties of undefined (reading 'createKeywordTypeNode')` on 7.0.2.
- The project looks dormant: no release since 2026-02-11, all of the last 30 commits on `main` are bot dependency bumps, and [#2843](https://github.com/openapi-ts/openapi-typescript/issues/2843) and [discussion #2831](https://github.com/openapi-ts/openapi-typescript/discussions/2831) ask whether it is still maintained. TS 6 and 7 PRs ([#2774](https://github.com/openapi-ts/openapi-typescript/pull/2774), [#2818](https://github.com/openapi-ts/openapi-typescript/pull/2818), [#2872](https://github.com/openapi-ts/openapi-typescript/pull/2872)) are all unmerged.

**Second TS 7 trap, not in the report:** shadcn's [Vite install guide](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/installation/vite.mdx) adds `baseUrl` to tsconfig, and the TS 7 announcement says "`baseUrl` is no longer supported". shadcn's own app is still on [`typescript ^5`](https://github.com/shadcn-ui/ui/blob/main/apps/v4/package.json).

**Action.** Pin the repo to `typescript@~5.9.3` for now, which satisfies both tools, and revisit when #2872 merges or TS 7.1 ships its API. If TS 7 is wanted for the app, isolate generation as #2841 suggests (`bunx --package typescript@6 --package openapi-typescript openapi-typescript ...`) and commit the generated `.d.ts`. Avoid Date transforms: [#2723](https://github.com/openapi-ts/openapi-typescript/issues/2723) reports `Readable<T>` breaking on `Date` under TS 6.

Fallback if the project stays dead: Orval's manifests list no `typescript` dependency and it fixed a TS 7 bug on [2026-10-30](https://github.com/orval-labs/orval/issues/4403). Hey API has the same crash ([#4235](https://github.com/hey-api/hey-api/issues/4235)), so it is not a fallback.

[#2846](https://github.com/openapi-ts/openapi-typescript/issues/2846) (vulnerable js-yaml through archived Redocly 1.x) looks cured by a fresh install: `@redocly/openapi-core` 1.34.22 now depends on js-yaml 4.3.2.

### C3. High: `@hono/mcp` cannot speak the MCP revision the trends track recommends

**Reports say:** ui-blocks hosts MCP through `@hono/mcp` and flags only that it is pre-1.0. Trends says to write servers and the gateway "against the stateless 2026-07-28 spec". These conflict.

**Refuted as a combination.**

- `@hono/mcp` 0.3.5 peers `@modelcontextprotocol/sdk ^1.29.0`, and its [transport](https://github.com/honojs/middleware/blob/main/packages/mcp/src/streamable-http.ts) still implements `Mcp-Session-Id`.
- The [SDK v1.x README](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/README.md) says: "Support for the 2026-07-28 spec is not planned for v1.x". v1 gets fixes for at least six months after v2's release on 2026-07-27.
- `@modelcontextprotocol/ext-apps` 2.x also peers SDK v2, so an MCP Apps card later needs v2 regardless.

**Action.** Use the [official Hono recipe](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/hono.md): `createMcpHonoApp()` from `@modelcontextprotocol/hono` 2.0.2 plus `createMcpHandler()` from `@modelcontextprotocol/server` 2.4.0, mounted as `handler.fetch(c.req.raw, { parsedBody })`. Both packages are Apache-2.0.

- Do not copy the older sample in the [middleware README](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/middleware/hono). Per the [migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md), a hand-constructed server "keeps speaking the 2025-era protocol".
- "2026-07-28 only" is unnecessary. [`createMcpHandler` serves both eras](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md) by default (`legacy: 'stateless'`), so keep that default.
- `createMcpHandler` does no Origin, Host or token checks. `createMcpHonoApp` covers Host and Origin, and the gateway owns tokens.
- `@modelcontextprotocol/hono` peers `hono ^4.11.4`, and [Hono 5.0.0-rc.1](https://github.com/honojs/hono/releases) exists. Stay on Hono 4 until that peer widens.

Supporting evidence: the [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) shows it negotiating 2026-07-28 by default, so the trends direction is sound.

### C4. Medium: Prism 5.16.0 has an unfixed startup crash and new telemetry

**Report says:** adopt for day 0, "check the opt-out". It missed the crash.

- Since 5.15, `createMultiProcessPrism` throws `Cannot read properties of undefined (reading 'isPrimary')` ([#2763](https://github.com/stoplightio/prism/issues/2763), still open). The [fix PR #2813](https://github.com/stoplightio/prism/pull/2813) was closed unmerged as stale on 2026-10-19, and both [5.16.0](https://github.com/stoplightio/prism/blob/v5.16.0/packages/cli/src/util/createServer.ts) and `main` keep the bad import.
- The path is reached by default only when `NODE_ENV=production` ([sharedOptions.ts](https://github.com/stoplightio/prism/blob/v5.16.0/packages/cli/src/commands/sharedOptions.ts)). Users confirm `--multiprocess=false` as a workaround.
- 5.16.0 is the release that [added Scarf analytics](https://github.com/stoplightio/prism/releases/tag/v5.16.0), and it is a dependency of both prism-cli and prism-http. [Opt out](https://github.com/scarf-sh/scarf-js) with `SCARF_ANALYTICS=false`.
- [#2797](https://github.com/stoplightio/prism/issues/2797) (open): OAS 3.1 schemas without a per-schema `$schema` fall through to AJV draft-07, so 2020-12 keywords are not honoured in validation.
- Prism's README still says Node >= 18.20.1. The registry's `>=24.18.0`, which ui-blocks quotes, is correct.

**Action.** Run `SCARF_ANALYTICS=false prism mock --multiprocess=false`, keep it day-0 only, and skip it entirely if KB fixtures arrive first.

### C5. Medium: Datasette as a sidecar has three problems the report missed

- **`base_url` is unreliable.** The report says Datasette is "designed for reverse-proxy mounting". Its maintainer's own [#2945](https://github.com/simonw/datasette/issues/2945) opens with "`base_url` frequently breaks". [#2347](https://github.com/simonw/datasette/issues/2347) and [#1633](https://github.com/simonw/datasette/issues/1633) (both open) break the Apply button for filters, which is the facet workflow this sidecar exists for. Serve it from its own port or host at root, or test the filter flows before relying on a sub-path.
- **`datasette-plot` needs the alpha.** The report pairs a pinned stable release with `datasette-plot` for history. [datasette-plot 0.1.0](https://pypi.org/project/datasette-plot/) (2023-12-21) requires `datasette >=1.0a6`, which stable 0.65.5 does not satisfy. Remove it from the stable plan.
- **The table role is redundant.** ui-blocks already builds the table with TanStack Table and server-side facets, so Datasette's "saves real work" no longer holds if that exists. It remains useful only as an ad-hoc SQL console.

Security note: the report lists 0.65.3 and 1.0a39, but 0.65.4 and 0.65.5 are also security releases ([GHSA-h547-rmjf-5m2m](https://github.com/simonw/datasette/security/advisories/GHSA-h547-rmjf-5m2m), high). Pin 0.65.5 or later. The 1.0 alphas add row-editing and table-creation UI ([1.0a34](https://github.com/simonw/datasette/releases/tag/1.0a34), [1.0a35](https://github.com/simonw/datasette/releases/tag/1.0a35)), so "read-only by design" holds for stable only.

### C6. Medium, in the viewer's favour: dashed edges are a stale risk

oss-viewers and the shortlist relay graphiti-lens's "cannot draw dashed edges without a custom shader" as something that "matters for the library choice". The [README quote](https://github.com/abouchard11/graphiti-lens) is accurate, but it is false for sigma 4. [`layerDashed`](https://github.com/jacomyal/sigma.js/blob/sigma%404.0.4/packages/website/src/content/docs/how-to/edges/fill-layers.mdx) is built in since 4.0.0, with per-edge dash sizes read from attributes. Superseded edges can be dashed without a custom shader.

One caveat: "every edge runs every declared layer", so test the cost at 50k edges.

### C7. Medium: Obsidian's latest public version is 1.14.5, not 1.15.0

1.15.0 (2026-10-22) is labelled [Catalyst](https://obsidian.md/changelog/), the early-access channel. The public desktop release is 1.14.5 (2026-10-22). Mobile public is 1.14.4 (2026-10-05).

### C8. Medium: Gephi Lite is not a drop-in static bundle

- **Build from source.** There are no [release assets](https://github.com/gephi/gephi-lite/releases/latest) and no `@gephi/gephi-lite` app package on npm, so hosting it means an npm build. [v1.1.0 moved to Node 24](https://github.com/gephi/gephi-lite/releases/latest), and Node 26 is untested.
- **GPL separation only holds for the URL path.** [`@gephi/gephi-lite-broadcast`](https://www.npmjs.com/package/@gephi/gephi-lite-broadcast) is itself `gpl-3.0`, so importing it pulls GPL code into the viewer bundle. Use `?file=` only, or accept this knowingly (not legal advice).
- **The export URL has a shape.** [`extractFilename`](https://github.com/gephi/gephi-lite/blob/dev/packages/gephi-lite/src/utils/url.tsx) is `url.split("/").pop()`, and the [docs](http://docs.gephi.org/lite/user-manual/share-graph-as-url/) require the name to end in `.gexf`, `.graphml` or `.json`. A query string after the extension would break that, so use a path like `/api/export/<hash>/subgraph.gexf`.

### C9. Low: cmdk's tracker does have IME reports, and the guard is better than stated

"No IME issue turned up in its tracker" is wrong. [#348](https://github.com/dip/cmdk/issues/348) (closed) reported ArrowDown double-selection after Korean input, and [#363](https://github.com/dip/cmdk/issues/363) (open) asks to stop search firing during composition.

The guard sits at the top of [`onKeyDown`](https://github.com/dip/cmdk/blob/main/cmdk/src/index.tsx), so it covers all key bindings, not just Enter. Because search still fires during composition, debounce the server call. New accessibility bugs (#411, #413, #417) sit unanswered, consistent with dormancy. Last commit was 2025-10-29.

### C10. Low: Embedding Atlas no longer has a WebGL fallback

Trends section 9 records "WebGPU with WebGL 2 fallback" from a secondary source. [PR #244](https://github.com/apple/embedding-atlas/pull/244) dropped it, merged 2026-08-19 and so included in v0.24.0 by date. The view now requires WebGPU with [`shader-f16`](https://github.com/apple/embedding-atlas/blob/main/packages/component/src/lib/webgpu_renderer/utils.ts). [#25](https://github.com/apple/embedding-atlas/issues/25) (open) reports it not rendering in VMs without a GPU.

### C11. Low: the Korean benchmark does not test bigrams

Trends M10 cites [llm-kernel](https://docs.rs/crate/llm-kernel/latest/source/docs/benchmarks/korean-recall.md) next to the bigram design. Its numbers are accurate (40 docs, 28 queries, 0.2857 vs 1.0), but the comparator is a contiguous-substring `LIKE` match, not bigram FTS. It shows that substring matching finds short Korean terms. It says nothing about bigram ranking or precision at scale, so the bigram design remains an untested inference, as trends itself states.

A simpler baseline to include in the golden-query test: FTS5 trigram tables [fall back to a linear scan](https://www.sqlite.org/fts5.html) for `LIKE` patterns under 3 characters, so short Korean terms still match. This may be fast enough at this scale (unmeasured).

### C12. Small factual fixes

| Report | Says | Correct |
|---|---|---|
| trends | es-hangul 2.4.0, "npm change 2026-08-24" | Released **2026-07-09** on npm and GitHub. 08-24 is only registry `time.modified` |
| trends vs ui-blocks | cosmos.gl 3.5.1 on 10-05 vs 10-08 | Both are right: GitHub release 10-05, npm publish 10-08 |
| trends | Kiwi model size unchecked | [`kiwi_model_v0.24.1_base.tgz`](https://github.com/bab2min/Kiwi/releases/tag/v0.24.1) is **83 MB** compressed, so use it in batch, not the browser |
| trends | Kiwi licence Apache-2.0 | True, models included, but [versions up to 0.23.2 are LGPL](https://github.com/bab2min/Kiwi#%EB%9D%BC%EC%9D%B4%EC%84%BC%EC%8A%A4). Do not pin older |
| trends | Mosaic licence unconfirmed | [BSD-3-Clause](https://github.com/uwdata/mosaic/blob/main/LICENSE) |
| trends | graspologic-native Python range unknown | `requires-python >=3.9`, classifiers to 3.13, `cp39-abi3` manylinux wheels. Expected to install on 3.14, undeclared. Has a `starting_communities` argument useful for the stable community IDs in M2 |
| ui-blocks | Schemathesis Python undetermined | `>=3.11`, classifiers include 3.14 and 3.15, CI runs 3.14, `jsonschema-rs` has abi3 wheels |
| oss-viewers | Datasette facets on search unverified | Yes by source: [facets use the same `where_clause`](https://github.com/simonw/datasette/blob/main/datasette/views/table.py) that [`_search` populates](https://github.com/simonw/datasette/blob/main/datasette/filters.py) |
| ui-blocks | Shadcn data-table might be v8 | Already [v9 (`useTable`, `tableFeatures`)](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/components/base/data-table.mdx) |
| ui-blocks | `proxy()` streaming undocumented | Source returns [`new Response(res.body, ...)`](https://github.com/honojs/hono/blob/main/src/helper/proxy/index.ts), so the body passes through as a stream |
| ui-blocks | FA2 "workers supported natively" by Vite | FA2's worker is a [blob URL from a stringified function](https://github.com/graphology/graphology/blob/master/src/layout-forceatlas2/helpers.js), not a Vite worker. A gateway CSP needs `worker-src blob:` |
| trends | Wikidata quote "Correct historical values should not be deprecated" | Not verbatim. [Actual text](https://www.wikidata.org/wiki/Help:Ranking): "This does not apply to correct historical information, such as previous values of a statement". Meaning unchanged |
| trends | GraphRAG-Bench quote "often performs worse" | Not in the current abstract. [Actual](https://arxiv.org/abs/2506.05690): "frequently underperforms vanilla RAG". Meaning unchanged |
| trends | Heatmap layers in `@sigma/layer-webgl` | Correct, per the [changelog](https://github.com/jacomyal/sigma.js/blob/sigma%404.0.4/CHANGELOG.md) and [exports](https://github.com/jacomyal/sigma.js/blob/sigma%404.0.4/packages/layer-webgl/src/index.ts). The package README omits it and lists only contours, so use the exports as the reference |

Gateway note: Bun [closes streams quiet for 10 s](https://bun.com/docs/runtime/http/server) unless `server.timeout(req, 0)` is used. Viewer polling is unaffected, but long-lived MCP streams are not.

## 2. Amended stack

Unchanged picks are omitted.

| Layer | Report | Amended |
|---|---|---|
| Graph labels | sigma 4 SDF labels | `renderLabels: false` plus own overlay. Compare against sigma 3.0.3 in the spike |
| TypeScript | Unstated (scaffold gives 7.0.2) | `typescript@~5.9.3`, pinned at the root |
| MCP on Hono | `@hono/mcp` | `@modelcontextprotocol/hono` + `@modelcontextprotocol/server` with `createMcpHandler` |
| Hono | 4.13.14 | Same, held at `^4` |
| Prism | 5.16.0 | Same, with `--multiprocess=false` and `SCARF_ANALYTICS=false` |
| Datasette | Table and facets sidecar under `base_url` | Optional SQL console only, ≥ 0.65.5, on its own port or root path, no `datasette-plot` |
| Gephi Lite | Export with broadcast driver available | `?file=` only, with an extension-terminated path |

Revised spike order, replacing ui-blocks section 12:

1. Sigma 4 at 10k/50k with labels off, including `layerDashed` cost.
2. Canvas overlay with Hangul labels, tracking the camera at acceptable FPS.
3. The same on sigma 3.0.3, if item 2 disappoints.
4. The remaining ui-blocks items (layout, Louvain, JSON size, Vite under Bun, streaming).

## 3. Conflicts between the reports

The orchestrator should resolve these. None is decided by a primary source.

1. **Who computes layout and communities.** ui-blocks runs FA2 and Louvain in the browser and caches the result. Trends M1, M2 and C9 make positions and Leiden communities stored data from a batch job. They imply different contracts. Trends' version suits stable point-in-time views better, but it needs a KB-side batch owner. `@sigma/layout-fa2-gpu` needs a live sigma context, so it cannot be that batch step.
2. **Time parameter names.** ui-blocks uses `as_of_valid` and `as_of_observed`. Trends uses `valid_at` and `observed_at`. Pick one before the KB contract freezes.
3. **Table view.** oss-viewers adopts Datasette for it, ui-blocks builds it. See C5.
4. **MCP.** See C3.
5. **Overview labels.** Trends M1 assumes sigma labels for community names. See C1.

## 4. Status of every adopt or adapt option

Licence, version and date were confirmed against registry and GitHub unless noted. "Docker-free" means an install path without Docker exists.

| Option | Verified latest | Licence | Maintenance | Docker-free | Runtime fit | Verdict |
|---|---|---|---|---|---|---|
| Datasette | 0.65.5 (2026-09-16), 1.0a41 (2026-09-24) | Apache-2.0 | Very active, pushed 2026-10-31. `main` now requires Python 3.11 | Yes, pip | Python 3.10+, classifiers to 3.14 | Keep, reduced role (C5) |
| Gephi Lite | 1.1.0 (2026-10-06) | GPL-3.0 | Pushed 2026-10-07 | Yes, source build | Node 24 stated, 26 untested | Keep with limits (C8). Cap of 10k nodes or 20k edges confirmed |
| Obsidian | 1.14.5 public, 1.15.0 Catalyst | Proprietary, free | Active | n/a | Desktop app | Corrected (C7). Bases and terms claims confirmed |
| graphiti-lens | v1.0.0 (2026-10-20) | Apache-2.0, [relicensed that day](https://github.com/abouchard11/graphiti-lens/commits/main) | One maintainer, 0 stars | Python + Neo4j | Reference only | Keep as reference, dash claim stale (C6) |
| sigma | 4.0.4 (2026-10-27) | MIT | Active, 6 open issues. 4.0.0 only three weeks old | Browser | WebGL 2 confirmed | Keep without its labels (C1) |
| graphology | 0.26.0 (npm 2025-01-26) | MIT | 2026 commits are metrics-only. Vite 8.1.0 breakage ([#548](https://github.com/graphology/graphology/issues/548)) fixed from 8.1.1 onward | Browser | Fine on Vite 8.3.5 | Keep |
| @react-sigma/core | 6.0.0 (2026-10-14) | MIT | 1 open issue | Browser | Peers sigma ^4, graphology ^0.26, React 18/19 | Keep |
| graphology-layout-forceatlas2 | 0.10.1 (2022-10-17), 0.11.0-rc1 unreleased | MIT | Dormant but stable | Browser | Peer of @react-sigma/layout-forceatlas2 | Keep (conflict 1) |
| @sigma/layout-fa2-gpu | 4.0.0 (2026-10-08) | MIT | New | Browser | Extensions, headless `run`, fixed nodes confirmed | Spike only |
| graphology-communities-louvain | 2.0.2 (2024-12-17) | MIT | Stable | Any | Directed and multigraph OK, true mixed graphs throw | Keep. 938 ms figure confirmed |
| TanStack Table / Virtual | 9.3.1 / 3.14.24 | MIT | Active. v9 stable 2026-08-04 confirmed | Browser | React 19 OK | Keep |
| ECharts | 6.1.0 (2026-05-19) | Apache-2.0 | Maintained, recent commits are mostly dependency bumps | Browser | Fine | Keep. Both XSS fixes confirmed |
| unified, rehype-sanitize, Shiki | 11.0.5, 6.0.0, 4.5.0 | MIT | Stable, Shiki active | Browser | Fine | Keep. Schema allows `language-*`, clobber prefix confirmed |
| approx-string-match | 2.0.1 (2026-10-09) | MIT | Small, one maintainer | Any | ESM only | Keep |
| Hypothesis match-quote | No package | BSD-2-Clause text | Active | Vendored | Fine | Keep. Weights 50/20/20/2 and missing threshold confirmed |
| cmdk | 1.1.1 (2025-03-14) | MIT | Dormant (C9) | Browser | React 19 peer OK. Used by shadcn's [Base UI Command](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/command.tsx) | Keep, with debounce |
| Vite, React, TanStack Router | 8.3.5, 19.3.1, 1.170.46 | MIT | Active | Yes | Node 26 satisfies engines | Keep, pin TS (C2) |
| Hono | 4.13.14 (2026-10-25) | MIT | Active, 5.0 RC out | Yes | Zero deps confirmed | Keep at ^4 (C3) |
| shadcn, Base UI, Tailwind | 4.23.0, 1.9.0, 4.3.3 | MIT | Active. [Base UI default 2026-07-02](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/changelog/2026-07-base-ui-default.mdx), Radix "fully supported" | Yes | `@tailwindcss/vite` peers Vite 8 | Keep, pin TS (C2) |
| openapi-typescript, -fetch, -react-query | 7.13.0, 0.17.0, 0.5.4 | MIT | Dormant (C2) | Yes | Breaks on TS 7 | Keep only with TS pin, Orval as fallback |
| Prism | 5.16.0 (2026-07-17) | Apache-2.0 | Dependency bumps only, fixes sit unreviewed | Yes, npm | Node >= 24.18 | Day 0 only, with flags (C4) |
| Schemathesis | 4.32.7 (2026-10-27) | MIT | Very active | Yes, pip in venv | Python >= 3.11, 3.14 declared. OpenAPI 3.1 and 3.2 confirmed | Keep |
| graspologic-native | 1.3.1 (2026-06-14) | MIT | One maintainer, revived 2026-06. GraphRAG usage and `max_cluster_size=10` confirmed | Yes | See C12 | Keep for batch |
| es-hangul | 2.4.0 (2026-07-09) | MIT | Active. `getChoseong` confirmed, returns a string you compare yourself | Any | Fine | Keep |
| Kiwi (kiwi-nlp) | 0.24.1 (2026-10-19) | Apache-2.0 | Active | Yes | WASM, model separate | Keep, batch only |
| Embedding Atlas | 0.26.0 (2026-10-15) | MIT | Active. `labels` prop, `autoLabelEnabled`, `Intl.Segmenter` and English stemmer confirmed | Yes | WebGPU required (C10) | Keep as later option |
| ext-apps | 2.0.4 (2026-10-27) | npm MIT, [LICENSE](https://github.com/modelcontextprotocol/ext-apps/blob/main/LICENSE) transitioning to Apache-2.0 | Active. Stable 2026-01-26 spec and 2.0.0 on 2026-09-08 confirmed | Yes | Peers SDK v2, zod ^4.2 | Keep as later option |
| Mosaic | 0.34.3 (2026-10-29) | BSD-3-Clause | Active, pre-1.0 | Browser | Depends on a dev build of duckdb-wasm | Keep as later option |
| Toponymy | 0.5.4 (2026-09-04) | MIT | Beta ("Things can and will break") | Yes | Classifiers to 3.13, `transformers<5`, litellm | Keep as later option |
| minigraf-visualizer | No release, last commit 2026-09-27 | Apache-2.0 or MIT confirmed | 14 commits, 0 stars | Reference | n/a | Reference only. Now/date/Any and URL-state patterns confirmed |

## 5. Track recommendations

- **oss-viewers: confirmed in substance.** "No app is the viewer" was not refuted, and nothing found supports an external read-only source plus bitemporal query plus quote provenance together. Adjust the Datasette and Gephi details (C5, C8).
- **ui-blocks: refuted as written, sound once amended.** Client-only SPA, Hono as the single server, and contract-first flow all stand. Three named components need the changes in section 2.
- **trends: confirmed.** The MCP claims hold against the [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog): sessions and `initialize` removed, `Mcp-Method` and `Mcp-Name` required, `ttlMs` and `cacheScope` required, deterministic `tools/list` a SHOULD, Roots, Sampling, Logging and DCR deprecated. The [client matrix](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/extensions/client-matrix.mdx) shows no MCP Apps support for Claude Code. Spot-checked sources also hold: AAAI trust paper, XTDB "every query runs against some basis", Claude Citations "guaranteed to contain valid pointers", FTS5 trigram limit, W3C code-point rule, CSS Custom Highlight Baseline 2025.

## 6. Could not verify

- Any runtime behaviour on Bun 1.4.4 or Node 26. Engines fields allow Node 26, but nothing was executed.
- Sigma frame rates at 10k/50k, and overlay cost. No published figures exist.
- Whether overflowed glyphs render blank or as wrong characters (C1).
- How many distinct syllables the KB will really contain.
- Whether Prism 5.16.0 starts on this machine. Source and user reports suggest yes with `NODE_ENV` unset.
- Whether `openapi-fetch` types behave under TS 7 or TS 6. Avoided by the 5.9 pin.
- Toponymy and graspologic-native on Python 3.14. Neither declares it.
- Obsidian scale and WSL claims, which rest on forum anecdotes. Obsidian Headless is confirmed as open beta, and a Sync subscription is implied but not stated on the page.
- The bigram search design (C11).
