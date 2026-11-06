# Trends track: what should shape the sagae-tools viewer (as of 2026-10-31)

Scope: changes in roughly the last 12-18 months, turned into adoptable ideas for the read-only KB viewer, plus what they imply for the gateway. Nothing third-party was installed or executed. Metadata came from the GitHub API, npm and PyPI. A few upstream files (source, README, LICENSE, the MCP matrix) were read through the GitHub API without being run. "Activity" below means the repo's `pushed_at`, which is a proxy for commit activity. Items marked **(my inference)** are design reasoning, not sourced facts.

## 1. Bottom line

1. **The biggest design risk is in the contract, not the renderer.** Wikidata and Graphiti both separate "true then, not now" from "recorded wrongly". The KB's single `status: superseded` merges the two. Fix this before any schema freeze (M4).
2. **Make time a global query context, not a separate view.** XTDB's "every query runs against some basis" is the right mental model. Every endpoint takes the two cursors, and every view state lives in the URL (M3, M12).
3. **The overview should be a map of communities, not a hairball.** Hierarchical Leiden is the proven default (GraphRAG). Compute it once in batch, and treat positions as stored data so time travel filters a stable picture (M1, M2).
4. **Claim-level trust is the product's differentiator, and it is cheap.** Statement cards, a quote hover, one click to a highlighted source, and a machine re-check of the quote. A study at AAAI 2025 found even random citations raise trust, and that trust falls only when people actually check. So the UI must make checking effortless (M5-M7).
5. **The feed and a health view come from the LLM-wiki pattern.** `log.md` maps to a cursor-based change feed and `lint` maps to saved health filters (M8, M11).
6. **Korean search must handle 2-syllable nouns.** FTS5 trigram alone returns nothing for them. Use bigrams, plus choseong typeahead on entity names, and test on a small golden set (M10).
7. **Skip the fashionable parts:** LLM chat in the viewer, GraphRAG or Graphiti as a backend, generative UI, continuous-zoom research, and a full RDF/PROV stack.
8. **The gateway got simpler.** MCP spec 2026-07-28 removed sessions and added `Mcp-Method` and `Mcp-Name` routing headers. This also weakens the case for a heavy MCP gateway product (section 7, my inference). MCP Apps is optional: the community matrix shows Claude web, Desktop, VS Code, ChatGPT, Cursor and Goose, but not Claude Code.

## 2. What changed, with dates

| When | Change | Why it matters here | Source |
|---|---|---|---|
| 2025-01 | Zep paper formalises a bi-temporal graph with episode, entity and community tiers | Nearest published model to this KB | https://arxiv.org/abs/2501.13956 |
| 2025-01 | "Citations and Trust in LLM Generated Responses" (AAAI 2025) | Citations raise trust even when random, and trust falls on checking | https://arxiv.org/abs/2501.01303 |
| 2025-05 to 07 | Embedding Atlas paper and open-source release | Density plus auto-label map became a free local component | https://arxiv.org/abs/2505.06386 |
| 2025-06 | CSS Custom Highlight API reached Baseline | Quote highlighting without DOM mutation | https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API |
| 2025-08 | Obsidian Bases public (1.9.10) | Table-over-properties became a norm in note tools | https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10/ |
| 2026-01-26 | MCP Apps spec marked Stable | Tools can render iframe UI in hosts | https://github.com/modelcontextprotocol/ext-apps |
| 2026-02 | GraphRAG-Bench paper revised (v3): GraphRAG "often performs worse" than vanilla RAG in recent studies | Do not build the viewer around GraphRAG | https://arxiv.org/abs/2506.05690 |
| 2026-04 | Karpathy's LLM Wiki gist (the page says created April 4; secondary sources say April 2-3) | Agent-maintained KBs went mainstream, and it asks for lint and log operations | https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f |
| 2026-06-17 | Google: A2UI + MCP Apps patterns (payload shows v0.9) | Generative UI is still moving | https://developers.googleblog.com/a2ui-and-mcp-apps/ |
| 2026-07-28 | MCP spec is stateless; sessions and `initialize` removed | Rewrites the gateway problem | https://modelcontextprotocol.io/specification/2026-07-28/changelog |
| 2026-09-08 | `@modelcontextprotocol/ext-apps` 2.0 (GitHub release date) | Wire protocol unchanged from 1.x per README | https://github.com/modelcontextprotocol/ext-apps |
| 2026-10-08 | sigma 4.0.0: WebGL 2, SDF labels, heatmap layer, declarative styles | Materially changes the map approach, but is 3 weeks old | https://github.com/jacomyal/sigma.js/releases |
| 2026-10-05 | cosmos.gl 3.5.1 (v3 moved to luma.gl, WebGL 2) | Remains the option if scale grows | https://github.com/cosmosgl/graph |

## 3. Must-have ideas

### M1. Map-first overview with hierarchical communities
- **What:** At overview zoom, show community regions (density or hulls) with labels and aggregated inter-community links. Hide individual edges until the user zooms in or selects something. Two or three discrete levels are enough.
- **Source:** GraphRAG's `communities` table has `level`, `parent`, `children`, `size` (https://microsoft.github.io/graphrag/index/outputs/). Its implementation calls `graspologic_native.hierarchical_leiden` with `max_cluster_size=10` and a fixed seed (https://github.com/microsoft/graphrag/blob/main/packages/graphrag/graphrag/graphs/hierarchical_leiden.py). sigma 4 has `@sigma/layer-webgl` heatmap layers, `labelVisibility` and SDF labels (https://github.com/jacomyal/sigma.js/releases).
- **Older basis:** Top-down hierarchy navigation with animation to preserve the mental map (https://ieeexplore.ieee.org/document/4297211/).
- **View:** Graph overview, neighbor expansion.
- **Cost:** Medium.
- **Contract:** Yes. An overview artifact per basis: node `x,y`, community path per level, community `title`, `size`, `top_members`, `layout_version`.
- **Licence trap:** `vtraag/leidenalg` is GPL-3.0. `graspologic-native` is MIT (1.3.1, 2026-06-14). If a JS-only path is needed, `graphology-communities-louvain` 2.0.2 is MIT but last changed 2024-12. There is no npm `graphology-communities-leiden` (404).
- **Note:** I found no 2025-26 peer-reviewed paper that combines Leiden, semantic zoom and KG sensemaking. This idea rests on practice and older visualisation work.

### M2. Positions are stored data
- **What:** Do not run layout at render time on the overview. Persist positions, version them, and place new nodes near their neighbours. Point-in-time then changes visibility and colour, not geometry. **(my inference; the mental-map rationale comes from the M1 reference.)**
- **Source:** sigma takes positions from graph attributes, and cosmos.gl has `setPointPositions()` (https://github.com/cosmosgl/graph). Graphiti's experience is a warning for the batch side: incremental community assignment drifts, so "periodic community refreshes remain necessary" (https://arxiv.org/html/2501.13956v1).
- **View:** Overview, point-in-time, change feed.
- **Cost:** Low.
- **Contract:** Yes, a small one: `layout_version`, and stable community IDs across refreshes (fixed seed, plus overlap matching to previous IDs).

### M3. One global time basis across all views
- **What:** Two cursors, `valid_at` and `observed_at`, default to now/latest, shown persistently in the header and encoded in the URL. Each view honours them. An "Any" mode shows all versions. A banner appears whenever the viewer is not at latest.
- **Source:** XTDB's `SETTING DEFAULT VALID_TIME ..., DEFAULT SYSTEM_TIME ...` and "every query runs against some basis" (https://docs.xtdb.com/quickstart/sql-overview.html). Datomic's `asOf`, `since` and `history` (https://docs.datomic.com/reference/filters.html). The Now/date/Any selector comes from minigraf-visualizer (https://github.com/project-minigraf/minigraf-visualizer).
- **View:** All, especially point-in-time.
- **Cost:** Medium. Viewer plumbing is low, and the KB queries are the real cost.
- **Contract:** Yes. Every read endpoint accepts both cursors and echoes the resolved `basis`. Pagination is pinned to that basis.
- **Open semantic issue:** Graphiti's T′ is when the system ingested a fact. The KB's "observed time" may instead mean when a source was seen, like Wikidata's `retrieved` (P813). For back-filled data these differ. If both matter, there are three timestamps, not two.

### M4. Separate "changed in the world" from "was wrong"
- **What:** A closed validity interval means the fact was right then. A correction means it was never right. These must look different and must behave differently in point-in-time: a corrected value should still appear when viewing old `observed_at`, but not in current belief about that past.
- **Source:** Wikidata: "Correct historical values should not be deprecated", use start and end time qualifiers; deprecated means erroneous or outdated, and reasons go in P2241 (https://www.wikidata.org/wiki/Help:Ranking). Graphiti keeps `t_invalid` (world) apart from `t'expired` (system) (https://arxiv.org/html/2501.13956v1). GraphRAG claims carry `status` TRUE, FALSE or SUSPECTED (https://microsoft.github.io/graphrag/index/outputs/).
- **View:** Entity detail, history, point-in-time.
- **Cost:** Low in the viewer.
- **Contract:** Yes, and this is the highest-priority ask. Replace or refine `superseded` with a reason enum such as `world_changed`, `corrected`, `source_retracted`. Define `dead` precisely. Consider a Wikidata-like rank for concurrent values.

### M5. Statement cards as the page atom
- **What:** Entity pages are predicate groups rather than prose: best value first, "n other values" collapsed, then validity range, rank icon, references, origin chip.
- **Source:** Wikidata's statement, qualifier, reference and rank model. "Best rank" is preferred if one exists, otherwise normal, and deprecated is excluded by default (https://www.wikidata.org/wiki/Help:Ranking, https://www.wikidata.org/wiki/Help:Sources).
- **View:** Entity detail, table view.
- **Cost:** Low to medium.
- **Contract:** Yes. A claim needs a stable `predicate`, typed `value` and, if available, `qualifiers`. The KB should return a server-computed `best` flag so every client agrees.

### M6. Citation pill, quote on hover, highlighted source on click
- **What:** Each claim has a small numbered source pill. Hover shows the verbatim quote. Click opens the snapshot scrolled to the highlighted quote.
- **Source:** NotebookLM (now also labelled Gemini Notebook): hover shows quoted text, selection opens the source viewer and auto-scrolls to it (https://support.google.com/notebooklm/answer/16179559?hl=en). Trust finding: https://arxiv.org/abs/2501.01303. Highlight mechanism: `CSS.highlights`, no DOM mutation, but no semantics for assistive tech (https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API).
- **View:** Entity detail, source view.
- **Cost:** Low.
- **Contract:** Yes. Snapshot text is retrievable by ID; see M7.

### M7. Robust quote anchors and a visible check
- **What:** Store a W3C-style anchor (`exact`, `prefix`, `suffix`, optional `start`, `end`) and snapshot hash. The viewer re-checks each quote against the snapshot and shows verified, relocated or missing. Offsets alone are brittle, and a verbatim quote from an LLM is a claim until checked.
- **Source:** W3C `TextQuoteSelector`, `TextPositionSelector`, and `TimeState` with `sourceDate`, `cached` (https://www.w3.org/TR/annotation-model/). The Claude Citations API returns `cited_text` with `start_char_index` and guarantees valid pointers into the provided documents, which is a cheap way for KB ingest to get these (https://platform.claude.com/docs/en/build-with-claude/citations).
- **View:** Source view, health view.
- **Cost:** Low.
- **Contract:** Yes. `quote.selector`, `snapshot_id`, `snapshot_sha256`, and a defined text normalisation (NFC). HTML snapshots need a rule for what text the offsets apply to.

### M8. Change feed as an ordered log with a cursor
- **What:** Monotonic sequence, grouped by ingest run, with per-run +/- counts. Filter by origin and actor. The client polls with a cursor every 30-60s, and an unchanged result costs almost nothing.
- **Source:** Datomic: the log is a time index, and an instant is "not as precise as" t or tx values (https://docs.datomic.com/reference/filters.html). LLM Wiki's append-only `log.md` (gist). Minigraf's transaction log with `+`/`−` counts. Graphiti's episode links (https://arxiv.org/html/2501.13956v1).
- **View:** Change feed.
- **Cost:** Low.
- **Contract:** Yes. `GET /changes?since=<seq>&limit=` returns `seq`, `run_id`, `actor`, op, target and a before/after pointer. Never use a timestamp as the cursor. Also add an ETag or equivalent.

### M9. Minimal provenance actor
- **What:** Every claim shows who or what produced it and in which run: person, or model plus version, with a link to the run. This is the PROV shape without RDF.
- **Source:** PROV-DM's Entity, Activity and Agent with `wasGeneratedBy`, `used`, `wasAttributedTo`; Revision and Quotation are subtypes of derivation (https://www.w3.org/TR/prov-dm/). Nanopublications split assertion, provenance and publication info (https://nanopub.net/guidelines/working_draft/). The LLM Wiki gist has thin provenance, and critics argue LLM-only upkeep compounds errors (secondary source: https://www.implicator.ai/karpathys-llm-wiki-got-16-million-views-the-code-isnt-the-point-2.md).
- **View:** Entity detail, change feed.
- **Cost:** Low.
- **Contract:** Yes. `generated_by: {agent_type, agent_id, model?, run_id}`, kept separate from `origin`.

### M10. Korean search in layers
- **What, in order:**
  1. **Normalise:** Convert queries and stored text to NFC. "검색" is 2 code points in NFC and 6 in NFD, and the two forms are not equal in JS (tested locally in node 26). NFD arrives from macOS and from some web text.
  2. **Entity typeahead, client-side:** Aliases plus choseong matching (ㄱㅅ matches 검색) over about 10k names, using `es-hangul`.
  3. **Body search with bigrams:** Pre-tokenise into a dedicated FTS column in application code, so no native SQLite extension is needed. This covers 2-syllable nouns and compounds such as 정보검색. **(my inference; untested on real data.)**
  4. **Optional precision layer:** Add Kiwi morpheme tokens in a second, higher-weighted column.
  5. **Results at claim level:** Include snippet offsets, respect the time basis, and default to active claims with a toggle for superseded.
- **Source:**
  - FTS5: substrings under 3 characters match no rows; custom tokenizers need C (https://sqlite.org/fts5.html).
  - A small Korean benchmark (40 docs, 28 queries, self-reported) found trigram recall@5 of 0.2857 against 1.0, the whole gap coming from queries under 3 characters. On longer queries the two were equal (https://docs.rs/crate/llm-kernel/latest/source/docs/benchmarks/korean-recall.md).
  - Lucene CJK bigrams explicitly cover Hangul (https://www.elastic.co/docs/reference/text-analysis/analysis-cjk-bigram-tokenfilter).
  - Kiwi has a WASM build on npm (`kiwi-nlp` 0.24.1, 2026-10-19, 5.6MB unpacked; model file size not checked) (https://github.com/bab2min/Kiwi).
- **Local test:** `Intl.Segmenter` leaves particles attached: "검색엔진을 | 지식그래프의 | 이력을". So browser segmentation alone will not do.
- **View:** Search, table search box.
- **Cost:** Medium.
- **Contract:** Yes. A `/search` endpoint that hides the engine, an `aliases[]` field (needed for 깃허브/GitHub), and match offsets in the response.
- **Test first:** Build about 30 golden Korean queries on the real corpus before picking analyzers. The KB ADR on storage decides where this runs.

### M11. Health view as saved filters
- **What:** Presets over the table view: orphans, unsourced claims, unverified quotes (M7), overlapping contradictory values, stale claims, sources that went dead.
- **Source:** The LLM Wiki `lint` op checks for "contradictions between pages" and "stale claims that newer sources have superseded", and it uses the graph view to spot hubs and orphans (gist). Graphiti detects temporally overlapping contradictions (https://arxiv.org/html/2501.13956v1).
- **View:** Table view (preset tab). This is not a new view.
- **Cost:** Low.
- **Contract:** Partial. Contradiction detection needs predicate cardinality (single or multi-valued). Otherwise the KB emits lint results.

### M12. Deep links as the agent-to-viewer interface
- **What:** Every state (entity, time basis, filter, highlighted quote) is a shareable URL. MCP tools return these URLs alongside text. This is the cheap version of agent-native UI, and it works in a terminal.
- **Source:** The MCP extension matrix has no check for Claude Code under MCP Apps (https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/extensions/client-matrix.mdx). The matrix is community-maintained.
- **View:** All.
- **Cost:** Low.
- **Contract:** No. IDs must be stable.

## 4. Nice-to-have ideas

| ID | Idea and source | View | Cost | Contract need |
|---|---|---|---|---|
| N1 | **Bitemporal map:** each claim version is a box, valid time across, recorded time up; dragging moves both cursors. Scope it to one entity or predicate. https://github.com/project-minigraf/minigraf-visualizer | History | Low-medium | None beyond M3 |
| N2 | **Scrubber with snapping and diff colours:** snaps to dates where facts start or stop; green and red for added and removed. Same source. | Point-in-time, overview | Medium | `/timeline` date histogram |
| N3 | **Compare two bases:** the claims that differ between A and B. Datomic `since` pattern. https://docs.datomic.com/reference/filters.html | Point-in-time, change feed | Low-medium | `/changes?from&to` |
| N4 | **Community summaries with citations:** GraphRAG `community_reports` (`title`, `summary`, `rank`, `findings`). Tag them as derived. https://microsoft.github.io/graphrag/index/outputs/ | Overview | Medium | `summary`, `source_claim_ids` |
| N5 | **Multi-level names via Toponymy** (beta, needs vectors, 2D map, LLM). https://github.com/TutteInstitute/toponymy | Overview labels | Medium | Same as N4, computed in batch |
| N6 | **Embedding map tab:** Embedding Atlas `EmbeddingView` takes `x,y`, optional `category`, and manual `labels` with `level` and `priority`. It reveals near-duplicates that the graph does not link. No edges documented. https://apple.github.io/embedding-atlas/embedding-view.html | Second overview tab | Medium | `x,y` or embeddings |
| N7 | **Crossfilter facets with Mosaic and DuckDB-WASM** over a static Parquet export. This also suits a no-daemon KB. https://github.com/uwdata/mosaic | Table view | Medium | Parquet or Arrow export |
| N8 | **MCP Apps card:** `ui://kb/entity` reuses the viewer component. `_meta.ui.resourceUri`, CSP restrictive by default, `visibility: ["app"]` for app-only tools. https://github.com/modelcontextprotocol/ext-apps | Entity card in chat | Medium | None |
| N9 | **Hybrid semantic search:** KURE-v1 modestly beats bge-m3 on its own card, and newer models lead a Korean leaderboard. Re-check before choosing. https://huggingface.co/nlpai-lab/KURE-v1, https://discuss.pytorch.kr/t/ko-embedding-leaderboard/11416 | Search | Medium-high | Embeddings, hybrid endpoint |
| N10 | **Saved views as plain files** in the repo, as Obsidian Bases does with notes as a database. https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10/ | Table view | Low | None |

**Korean warning for N5 and N6:** Embedding Atlas's `TextSummarizer` uses c-TF-IDF with `Intl.Segmenter` and an English stemmer (https://github.com/apple/embedding-atlas/blob/main/packages/component/src/lib/text_summarizer/text_summarizer.ts). Given the local segmenter test above, auto-labels on Korean would be particle-attached eojeol such as "지식그래프의". Pass your own labels through the `labels` prop with `autoLabelEnabled: false`.

## 5. Fashionable ideas to skip

| Skip | Why |
|---|---|
| **LLM chat or GraphRAG query box in the viewer** | The viewer is read-only and deterministic, and agents already reach the KB through MCP. Evidence for graph retrieval is mixed: recent studies report GraphRAG "often performs worse" (https://arxiv.org/abs/2506.05690); a systematic evaluation finds "distinct strengths" by task (https://arxiv.org/abs/2502.11371). |
| **Graphiti, GraphRAG or LightRAG as the backend** | The KB has its own claim model. Graphiti needs a graph DB and an LLM key, and its MCP server states it has no auth or prompt-injection protection (https://github.com/getzep/graphiti). LightRAG calls its file-based defaults test-only (https://github.com/HKUDS/LightRAG). Borrow schemas and UI, not the runtime. |
| **FastGraphRAG-style noun-phrase graphs** | Microsoft calls the result noisier, and the default NLP is mainly suited to English (https://microsoft.github.io/graphrag/index/methods/). Wrong for Korean-capable claims with verbatim quotes. |
| **LazyGraphRAG** | I found no open-source release. Microsoft ships it through Discovery and Azure Local (https://www.microsoft.com/en-us/research/project/graphrag/). |
| **Continuous zoom via heat diffusion and Poincaré embeddings** | A single-author preprint (https://www.alphaxiv.org/abs/2603.08965). Discrete levels suit about 10k nodes. |
| **GPU force simulation at this scale** | cosmos.gl targets hundreds of thousands of points, has no built-in labels, and is WebGL only. Labels matter more here, and M2 removes the need for live simulation. Revisit only if measurements fail. |
| **Nomic Atlas** | A hosted product. Python client last released 2025-11-11 (3.9.0), with no licence detected on the repo. Embedding Atlas covers local use. |
| **A2UI, AG-UI, generative UI** | Views are fixed, so runtime-generated UI adds risk without value. Versions are moving: the June blog shows v0.9, and the repo's latest tag is `cli-v0.1.0` from 2026-10-30. Hosts need a native renderer for two of the three patterns (https://developers.googleblog.com/a2ui-and-mcp-apps/). |
| **Full RDF, PROV-O or nanopublication stack** | Adopt the shape in M9. Formal graphs and signing serve inter-organisation exchange, which a solo KB does not need **(my inference)**. |
| **Elasticsearch with Nori** | A standard Korean analyzer path (mecab-ko-dic; https://www.elastic.co/docs/reference/elasticsearch/plugins/analysis-nori), but it adds an always-on cluster, against the KB's principle. |
| **XTDB or Datomic as storage for the viewer** | Take the query semantics only. Storage belongs to the KB's ADR. I did not evaluate their runtime needs. |
| **3D graph views, push-based live updates** | 3D is my judgement call, with no study behind it here. For updates, 30-60s polling already meets the stated target. |

## 6. Consolidated contract asks for the KB

Ranked by how much later pain each avoids.

| # | Ask | From |
|---|---|---|
| C1 | Split `superseded` by reason, and define `dead` | M4 |
| C2 | Define the time fields exactly: valid from/to, observed, recorded. Decide whether observed and recorded differ | M3 |
| C3 | All reads take `valid_at`, `observed_at`; responses echo `basis` | M3 |
| C4 | `quote.selector` (`exact`, `prefix`, `suffix`, `start`, `end`), `snapshot_id`, hash, NFC rule | M7 |
| C5 | `/changes?since=<seq>` with `run_id`, `actor`; monotonic integer cursor | M8 |
| C6 | `generated_by` on claims, separate from `origin` | M9 |
| C7 | `predicate`, typed value, cardinality, server `best` flag, optional rank | M5, M11 |
| C8 | `aliases[]` on entities; `/search` hides the engine and returns offsets | M10 |
| C9 | Overview artifact with positions, community path, `layout_version` | M1, M2 |
| C10 | Fixtures must cover: a corrected value, a world-changed value, overlapping values, a back-filled claim with old valid time and new recorded time, a dead source, a Korean NFD quote, a 2-syllable query | All |

## 7. Gateway implications

- **Stateless MCP simplifies aggregation.** Sessions and the handshake are gone, and every request carries version and capabilities in `_meta` (https://modelcontextprotocol.io/specification/2026-07-28/changelog). A thin gateway needs no sticky routing or session store.
- **Routing and logging without parsing bodies.** `Mcp-Method` and `Mcp-Name` headers are required on Streamable HTTP POST, and the MCP blog names gateways as a use (https://blog.modelcontextprotocol.io/posts/2026-07-28/). OTel `traceparent` conventions in `_meta` give request tracing.
- **Caching is built in.** `ttlMs` and `cacheScope` on list and read results fit a shared process well. `tools/list` should be deterministically ordered, which matters when merging servers.
- **Must pass through untouched (my inference):** `_meta.ui.*`, `ui://` reads, and the `extensions` capability field. If the aggregator prefixes tool names, it must still map resource URIs correctly, or MCP Apps break.
- **Mixed versions (my inference):** Servers on 2025-11-25 still use `initialize`. If any such server is kept, the gateway must speak both. Prefer writing in-repo servers against 2026-07-28 only.
- **Avoid deprecated parts.** Do not add Dynamic Client Registration (deprecated in favour of CIMD), Sampling, Roots or Logging.
- **Label untrusted content (my inference).** KB content with `origin: external` is untrusted text that reaches LLMs through MCP tools. Keep `origin` in tool results so agents can treat it as data. Graphiti's README warning (above) shows that this is not solved by default.
- **Viewer path.** The feed, cursor reads and static overview artifacts in section 6 are cacheable, so the gateway can stay a small, single always-on process in front of file-based KB reads.

## 8. Shortlist status

| Project | Release | Licence | Activity | Runtime | No Docker? | Fit |
|---|---|---|---|---|---|---|
| sigma | 4.0.4, 2026-10-27 (4.0.0 on 2026-10-08) | MIT | 2026-10-27 | Browser, WebGL 2 | Yes | Adopt as candidate. Very new major, with breaking changes |
| graspologic-native | 1.3.1, 2026-06-14 | MIT | 2026-06-14 | Python wheel; exact Python range not determined | Yes, expected | Adopt for batch Leiden |
| es-hangul | 2.4.0, npm change 2026-08-24 | MIT | 2026-08-27 | Node or browser | Yes | Adopt |
| kiwi-nlp / Kiwi | 0.24.1, 2026-10-19 | Apache-2.0 | 2026-10-27 | WASM from npm | Yes | Adapt, optional precision layer |
| Embedding Atlas | 0.26.0, 2026-10-15 | MIT | 2026-10-29 | npm components or Python tool; WebGPU renderer present in repo | Yes | Adapt, later tab |
| @modelcontextprotocol/ext-apps | 2.0.4, 2026-10-27 | Moving MIT to Apache-2.0; npm says MIT | 2026-10-29 | Node 20+ | Yes | Adapt, optional |
| Mosaic | 0.34.3, 2026-10-29 | GitHub shows NOASSERTION; not checked further | 2026-10-30 | Browser with DuckDB-WASM | Yes, expected | Adapt, optional |
| Toponymy | 0.5.4, 2026-09-04 | MIT | 2026-10-26 | Python >=3.10, embedder, LLM; beta | Yes | Adapt, optional |
| minigraf-visualizer | No release read; last commit 2026-09-27 | Apache-2.0 or MIT | 14 commits, 0 stars | React, WASM | Yes | Design reference only |
| cosmos.gl | 3.5.1, 2026-10-05 | MIT | 2026-10-29 | Browser, WebGL 2, luma.gl ~9.3 | Yes | Reject for now, fallback |
| Graphiti | 0.31.2, 2026-10-20 | Apache-2.0 | 2026-10-28 | Python >=3.10, graph DB, LLM key | Yes; Docker optional, FalkorDB Lite embedded | Reject as dependency, adopt the model |
| GraphRAG | 3.3.0, 2026-10-08 | MIT | 2026-10-29 | Python, LLM; versions not verified | Not determined, likely | Reject as dependency, adopt the schema |
| LightRAG | 1.5.7, 2026-09-02 | MIT | 2026-10-29 | Python, LLM | Yes | Reject |
| XTDB | 2.2.0, 2026-10-21 | MPL-2.0 | 2026-10-30 | Not determined | Not determined | Reject here, borrow the query idea |
| A2UI | cli-v0.1.0, 2026-10-30 | Apache-2.0 | 2026-10-31 | Host renderer | Not relevant | Reject |

## 9. Limits of this research

- **Embedding Atlas paper:** The PDF text would not decode, so I only confirmed the abstract page. Details come from docs and the repo tree. "WebGPU with WebGL 2 fallback" is from a secondary source; the repo does contain a `webgpu_renderer` directory.
- **Sigma and cosmos.gl:** No performance figures are stated for sigma 4. Neither has been measured at 10k nodes and 50k edges with labels in this project.
- **Graph RAG papers:** I read abstracts only. arXiv 2503.04338 lists no venue on its page, so I did not cite it as a VLDB paper.
- **Korean:** The benchmark is tiny and self-reported. I found no primary comparison of mecab-ko and trigram, and no Kiwi-based FTS5 tokenizer. The bigram design in M10 is untested.
- **MCP Apps support:** The matrix is community-maintained. Treat the Claude Code gap as "not listed", and re-check.
- **LLM Wiki scale limits:** Reported limits of 200 or 1,000 files come from secondary sources and conflict, so I did not use them.
- **Secondary sources:** These were used only to find primary sources, except where marked.
