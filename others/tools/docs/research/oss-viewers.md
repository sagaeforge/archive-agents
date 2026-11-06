# Can an existing app BE the viewer?

Track: existing applications. Research date: 2026-10-31. Nothing was installed or executed; only web pages, GitHub metadata and PyPI/npm metadata were read. Every performance statement below is either a project's own claim, a user anecdote, or my inference, and is labelled as such. No candidate was measured against the provisional targets (10k nodes / 50k edges, p95 under 200ms).

## 1. Verdict

No. No application found covers more than about half of the nine required views against an external read-only source, and none handles the four hard requirements together: external source, bitemporal query, claim-level quote provenance, 10k/50k graph.

The closest **data model** is in products that insist on owning the store (Graphiti, Utopia, Wikibase). The closest **read path** is in tools with no concept of claims or graphs (Datasette). Nothing sits in the intersection. One project says this outright: graphiti-lens exists because "Nothing off-the-shelf understands Graphiti's bitemporal edges" ([README](https://github.com/abouchard11/graphiti-lens)).

| Decision | Scope |
|---|---|
| **Build thin** | Graph overview, neighbor expansion, entity detail, point-in-time, history, source view with quote highlighting, change feed. These are the views whose meaning comes from the KB's model. Build as a small client over the OpenAPI contract, on rendering libraries (library track decides which). |
| **Adopt, optional sidecar** | Datasette, only for table/facets and an ad-hoc SQL console, only if the KB can publish a read-only SQLite artifact (its store, or an export). Not a dependency of the viewer. |
| **Adopt, as an export target** | Gephi Lite for ad-hoc analysis of filtered subgraphs under its stated cap. |
| **Adapt, later and optional** | One-way Obsidian vault projection of the *current* state. A convenience for reading and linking from notes, not the viewer. |
| **Borrow, do not run** | graphiti-lens interaction patterns; Wikibase statement/rank concepts. |

Korean search does not get solved by any app here. It is a KB indexing decision that the viewer should consume through the contract.

## 2. What is hard here, and how each option fares

Legend: Y works as shipped. A works with a thin adapter. P partial or with a serious compromise. N not possible without building it yourself.

| Option | External read-only source | Bitemporal query | Claim provenance + quote highlight | Supersession history | 10k/50k graph |
|---|---|---|---|---|---|
| Obsidian + generated vault | A (one-way projection) | P (tables only, see 3.1) | A (generated highlights) | P (depends on claims as files) | P (unmeasured, anecdotes negative) |
| Quartz v5 | A (one-way projection) | N at runtime (build-time only) | A (generated) | A (generated pages) | P (d3-force on main thread) |
| Datasette | Y on SQLite only | Y for tables | A (custom pages) | A | N (no graph plugin) |
| Gephi Lite | A (file export) | N (no time support documented) | N | N | P (cap 10k nodes or 20k edges) |
| Grafana | A | P (time picker fits valid time, not two axes) | N | P | N (200 visible nodes by default) |
| Graphiti + any UI | N (owns store) | Y | P (episodes, no quote spans) | Y | N (no UI) |
| LightRAG WebUI, Cognee UI | N (owns store) | N | N | N | P/N (LightRAG default 1000 nodes) |
| Utopia | N (owns store) | Y by design | Y by design, unverified at quote level | Y | Unknown |
| Wikibase | N (owns store) | P (qualifiers) | P (references, not spans) | P (ranks) | N |
| Trilium, SiYuan, Logseq DB, SilverBullet | N (import into own store) | N | N | P (note versions only) | P/N |
| AFFiNE, AppFlowy, Outline, Docmost | N | N | N | N | N |
| NocoDB, Baserow, Teable, Grist | N or P | N | N | N | N |
| Metabase, Evidence, Observable Framework | Y/A | P (parameterised SQL) | N | P | N |
| NeoDash, G.V(), Memgraph Lab, AWS Graph Explorer | N (require a graph DB) | N | N | N | Varies |

## 3. Serious options in depth

### 3.1 Obsidian with a generated vault and Bases

**Status.** Desktop 1.15.0 on 2026-10-22 ([changelog](https://obsidian.md/changelog/)). Proprietary, not open source: the terms prohibit reverse engineering and decompiling ([terms](https://obsidian.md/terms)). Free for personal and commercial use. It therefore fails the "open-source" framing and, more importantly, its graph cannot be modified.

**What fits well.** It needs no daemon, which matches the KB's principle: a batch job writes Markdown. Read-only is safe by construction, because the vault is a derived projection and the KB cannot be damaged. The cost is that any note a user edits is silently overwritten on the next run, and I found no official read-only vault mode.

**The central problem: rows are files.** "Base rows currently directly and only represent files" (a user's description in a [feature request](https://forum.obsidian.md/t/bases-data-source-from-single-csv-json-special-markdown-file-instead-of-note-properties/103622) with no staff response or roadmap commitment); the docs say data is stored in "local Markdown files and their properties" ([help](https://obsidian.md/help/bases)). There is no CSV/JSON source and no joins: "There is no `from` or `source` like in SQL or Dataview" ([syntax](https://obsidian.md/help/bases/syntax)). That forces a choice with no good answer:

- **Claims as properties or body text of the entity note.** The vault stays small, but Bases cannot filter individual claims, so point-in-time and history in tables are lost.
- **Each claim version as its own file.** Bases works, but file count becomes entities + claim versions + sources. With 10k entities and even a handful of claims each plus history, this plausibly reaches 50-100k files (my arithmetic; the KB's real ratio is unknown). User reports put the comfort zone near or below that: one user says above 25k files is impractical for the graph ([forum](https://forum.obsidian.md/t/obsidian-graph-view-doesnt-work-for-a-large-vault/106287/5)); another with about 10,500 files traced a 280 ms stall every 2 seconds to property processing ([bug report](https://forum.obsidian.md/t/performance-280-ms-renderer-stall-every-2-seconds-in-large-vault-caused-by-getallpropertyinfos/117693)); another says going from 40k to 10k notes restored speed ([forum](https://forum.obsidian.md/t/help-obsidian-lags-with-many-notes/82241)). These are anecdotes, not benchmarks.

**Bitemporal, partly.** There is a usable trick. In an embedded base, `this` is the embedding note ([syntax](https://obsidian.md/help/bases/syntax)), so a note with `as_of_valid` and `as_of_observed` properties can drive filters comparing against each claim's dates. This gives a working as-of table, given claims as files. It does not reach the graph: graph filters accept search terms only ([help](https://obsidian.md/help/plugins/graph)), and search has no documented date comparison ([search help](https://obsidian.md/help/plugins/search)). A point-in-time graph therefore needs a separate generated vault per date.

**Provenance.** Achievable through generation: write the source snapshot as a note, wrap the quote in `==highlight==`, add a block id, and link the claim to `[[source#^claim-id]]`. This is the one requirement where projection does well, because the generator controls the text. (Design inference from standard Obsidian syntax, not tested.)

**Korean search.** The search docs describe matching per word and nothing about CJK ([help](https://obsidian.md/help/plugins/search)). Omnisearch defers CJK to a separate plugin and is reported as finding far fewer matches ([issue #257](https://github.com/scambier/obsidian-omnisearch/issues/257)). The CJK plugins I found target Chinese variants, not Hangul segmentation. Regex substring search over the vault may work, but this is untested.

**Graph links.** Body wikilinks are safe. Property links are not: per a [plugin page](https://community.obsidian.md/plugins/frontmatter-markdown-links), a property holding several links in one value is treated as one broken link, so the generator should write edges into the body.

**WSL2 is a specific trap.** A vault at a `\\wsl$` path fails with an EISDIR watcher error in user reports, and polling via `CHOKIDAR_USEPOLLING` had not fixed it ([thread](https://forum.obsidian.md/t/support-for-vaults-in-windows-subsystem-for-linux-wsl/8580)). So a generator in WSL2 should write to a Windows path, or Obsidian must run inside WSL2. I found no official statement and no WSLg/AppImage confirmation. Watcher misses under bulk changes are also reported ([bug](https://forum.obsidian.md/t/windows-sometimes-changes-made-outside-of-obsidian-are-not-reflected-in-the-files-pane/73451)), which matters for 30-60s refresh. Obsidian CLI needs the desktop app running; Obsidian Headless is a Sync client in open beta requiring a Sync subscription ([docs](https://obsidian.md/help/headless)), so neither helps.

**Extending it.** Custom Bases views are an official API ([guide](https://docs.obsidian.md/plugins/guides/bases-view)). A plugin could also call the KB API and render its own graph, but at that point you are building the viewer inside a closed host. The third-party graph plugins (Fast 3D Graph, Advanced Graph View) claim tens of thousands of notes; their claims are unverified.

**Verdict: adapt, later, optional, current state only.** Project entities plus current claims, one file per entity, with source notes. Do not attempt history or as-of in the vault. Does not satisfy the requirement as the viewer.

### 3.2 Quartz v5

**Status.** Default branch `v5`; `v5.0.0` tagged 2026-03-14; latest commits September 2026, repo pushed 2026-10-25 (GitHub API). MIT. Node 22+, npm 10.9+ ([site](https://quartz.jzhao.xyz/)). Runs without Docker. Note the GitHub "latest release" still shows v4.0.8 from 2023, which is misleading; use tags.

**What is new and relevant.** Plugins are now separate repos, and `BasesPage` renders `.base` files ([docs](https://github.com/jackyzha0/quartz/blob/v5/docs/plugins/BasesPage.md)). But "Base views are server-side rendered HTML baked at build time", and its map view is a placeholder. So there is no runtime as-of parameter of any kind. Point-in-time means a rebuild per date.

**Korean.** Search uses FlexSearch and tokenizes CJK per character, including the Hangul syllable range 0xAC00-0xD7AF ([source](https://github.com/quartz-community/search/blob/main/src/components/scripts/search.inline.ts)). This is high recall and low precision, but better than Obsidian's undocumented behaviour, and it runs client-side, so the index must be shipped to the browser. That cost at 10k+ pages is unmeasured.

**Graph.** Depth-limited local graph and a global graph ([docs](https://raw.githubusercontent.com/jackyzha0/quartz/v4/docs/features/graph%20view.md)). The implementation uses d3 `forceSimulation` with Pixi ([source](https://github.com/quartz-community/graph/blob/main/src/components/scripts/graph.inline.ts)). I found no published scale figure. My inference: a d3-force simulation at 10k/50k in the browser will not be a good overview, though the local graph is fine.

**Fit.** Same "rows are files" constraint, with the same generator as Obsidian. Better than Obsidian on one axis: it is plain static output that the gateway can serve, with no desktop dependency. Rebuild-on-change conflicts with 30-60s polling unless rebuilds are incremental. The site lists incremental rebuilds for content edits, but I did not verify that this applies outside the local dev server. Virtual pages exist ([issue #2575](https://github.com/jackyzha0/quartz/issues/2575)), which may let a plugin generate pages without files; I did not verify this path.

**Verdict: reject as the viewer.** If a static publish target is ever wanted, reuse the Obsidian generator's output.

### 3.3 Datasette

**Status.** Stable 0.65.5 (2026-09-16) and alpha 1.0a41 (2026-09-24) ([releases](https://github.com/simonw/datasette/releases), [changelog](https://docs.datasette.io/en/latest/changelog.html)). Apache-2.0, Python 3.10+ ([PyPI](https://pypi.org/pypi/datasette/json)). This machine has Python 3.14.4 and pip; `uv` and Docker are not needed. Repo pushed 2026-10-31.

**Security note.** 2026 releases include a SQL injection fix (1.0a38/0.65.3) and a broad security release (1.0a39). Pin a version, keep it updated, and do not expose it directly.

**Why it is the best partial fit.** It treats SQLite files as read-only, offers parameterised canned queries with JSON output on any URL ([docs](https://docs.datasette.io/en/stable/sql_queries.html)), and is designed for reverse-proxy mounting with `base_url` ([settings](https://docs.datasette.io/en/stable/settings.html)).

| Requirement | Result |
|---|---|
| External read-only | Yes, provided the KB is SQLite or exports it. Not usable against other stores. |
| Bitemporal | Yes in tables. A canned query with `:valid_at` and `:observed_at` gets its own page and JSON endpoint. This is the only tool found where an as-of query is a config entry. |
| Table with facets | Yes. Column, array and date facets. Explicit facet time limit defaults to 200 ms ([docs](https://docs.datasette.io/en/stable/facets.html), [settings](https://docs.datasette.io/en/stable/settings.html)). Faceting on search results is not stated in the facet docs; verify. |
| Entity detail, source view | Adapter. Custom page templates with path parameters (`templates/pages/entity/{id}.html`) plus `datasette-template-sql`, and extra JS for highlighting ([docs](https://docs.datasette.io/en/stable/custom_templates.html)). |
| History | Adapter. Canned query plus `datasette-plot`. |
| Change feed | Adapter. A canned query ordered by observed time. |
| Graph | No. The [plugin directory](https://datasette.io/plugins) has no node-edge plugin, and a GitHub search found none. A custom page could host a graph library, which means you are building that part. |
| Korean FTS | Weak. FTS5 `unicode61` treats a contiguous letter run as one token, so no Korean word segmentation (my inference from the [spec](https://www.sqlite.org/fts5.html)). The `trigram` tokenizer states "Substrings consisting of fewer than 3 unicode characters do not match any rows", and many Korean terms are two syllables. A tokenized column in the KB helps, but the stock search box does not transform the user's query, so the UI still needs a custom path. |

**Limits to set.** `max_returned_rows` defaults to 1000 and `sql_time_limit_ms` to 1000 ([settings](https://docs.datasette.io/en/stable/settings.html)). A full graph payload exceeds the row default.

**The trap: it bypasses the contract.** Datasette reads tables, not the KB's OpenAPI document. Any page built on it couples to the storage schema, and its JSON shape is its own, so it cannot simply implement the contract. It is cheapest as a sidecar on a KB-published artifact whose schema the KB owns as part of the contract. It is a poor foundation for the main viewer. An MVP built wholly from Datasette templates is possible and fast, but it stops being thin once the graph is added, and it would have to be rewritten if the KB does not use SQLite.

**Verdict: adopt as an optional sidecar** for table/facets and ad-hoc SQL, conditional on the KB ADR. If the KB's store is not SQLite and it publishes no SQLite export, drop it.

### 3.4 Gephi Lite

**Status.** v1.1.0 on 2026-10-06, GPL-3.0, repo pushed 2026-10-07 (GitHub API). Web app built on sigma.js and graphology ([README](https://github.com/gephi/gephi-lite)). Runs in the browser; self-hosting builds a static bundle, Docker is optional for production serving.

**Capabilities.** Loads GEXF, GraphML or its JSON through a `?file=` URL, given CORS ([docs](https://docs.gephi.org/lite/user-manual/share-graph-as-url)). Embeddable by iframe, with a broadcast driver that gained selection APIs in 1.1.0 ([docs](https://docs.gephi.org/lite/integration/embed), [release](https://github.com/gephi/gephi-lite/releases/tag/%40gephi%2Fgephi-lite%401.1.0)).

**The limit.** The maintainers state "no more than 10k nodes or 20k edges, at the moment" ([v1 post](https://gephi.wordpress.com/2025/10/08/gephi-lite-v1/)). That is below the 50k-edge target, so the whole-KB overview is out. No time or dynamic support is mentioned in the README, release notes or v1 post. No claim, quote or source concept exists.

**Verdict: adopt as an export target only.** An "Open in Gephi Lite" link for a filtered subgraph is a few lines of work if the backend can emit GEXF or graphology JSON. It runs in its own frame or tab, which also keeps GPL code out of the viewer bundle (not legal advice).

### 3.5 Graph UIs shipped with KG systems

- **Graphiti** v0.31.2 (2026-10-20), Apache-2.0. Has the model: "explicit bi-temporal tracking with automatic fact invalidation", with facts traced to episodes. But no UI, and it requires Neo4j, FalkorDB or Neptune plus an LLM key ([README](https://github.com/getzep/graphiti)). The README tells you to "Build your own tools". It is a competitor to the KB's store, not a viewer.
- **graphiti-lens** v1.0.0 (2026-10-20), Apache-2.0, 0 stars, Neo4j only. Unusable directly, but it is the most useful reference found: an "As of" scrubber dims edges not live on a date; a "Hide superseded" toggle removes them from layout; state uses dash patterns as well as colour; a plain-text `/api/explain` mirrors the UI; every query runs in a READ transaction; health reports `not_measured` rather than a false zero. It also records a relevant library fact: canvas was chosen over WebGL because sigma could not draw dashed edges without a custom shader ([README](https://github.com/abouchard11/graphiti-lens)). The library track should weigh this, because superseded edges need a visual encoding.
- **LightRAG WebUI** v1.5.7 (2026-09-02), MIT. React, sigma 3, graphology. Good neighbor expansion and node panel ([walkthrough](https://habr.com/ru/articles/1036652/)), but it reads LightRAG's own store and `DEFAULT_MAX_GRAPH_NODES` is 1000 ([constants](https://github.com/HKUDS/LightRAG/blob/main/lightrag/constants.py)). No temporal or quote support found. Useful as a code reference for a sigma/graphology React setup.
- **Cognee** v1.6.6 (2026-10-29), Apache-2.0. Local UI on ports 3000/8000 via `cognee.start_ui()` ([docs](https://docs.cognee.ai/cognee-cloud/local-ui)), plus static HTML export. Own store, no temporal view found.
- **Utopia** Apache-2.0, 8.6k stars, repo active 2026-10-31. Conceptually the nearest thing found: two timelines, corrections close old versions and link new ones, per-fact provenance, a graph browser. But it is v0.1 with a changing schema, is a full KB that owns its data in Postgres with pgvector, and Docker is the documented path ([README](https://github.com/deeplethe/utopia)). I found no sign its UI can point at another store. Worth a look as a **KB-track** reference, and worth watching. Reject as viewer.
- **Wikibase** The closest published claim model: statements with qualifiers, references and ranks, where deprecated rank resembles superseded and qualifiers carry validity ([data model](https://www.mediawiki.org/wiki/Wikibase/DataModel)). Wikibase Suite (BSD-3-Clause) is Docker Compose with MediaWiki, MariaDB, OpenSearch, a query service and more ([repo](https://github.com/wmde/wikibase-suite)). Far too heavy and needs Docker. Reject; borrow the statement concepts for the entity page.

### 3.6 Graph tools

| Tool | Status | Verdict |
|---|---|---|
| NeoDash | README: "no longer maintained, use at your own risk" ([repo](https://github.com/neo4j-contrib/neodash)). Last release 2.4.11, 2025-08-04. | Reject |
| G.V() | Commercial EULA, $60 per seat per month or $600 per year, 3-week trial, no free tier ([pricing](https://gdotv.com/pricing)). | Reject |
| Memgraph Lab | Tied to Memgraph, Docker quick start, Linux desktop exists ([docs](https://memgraph.com/docs/data-visualization/install-and-connect)). License not determined from those pages; no public source repo found. | Reject |
| AWS Graph Explorer | v3.3.0 (2026-10-09), Apache-2.0. Needs a Gremlin, openCypher or SPARQL endpoint; docs lead with Docker ([repo](https://github.com/aws/graph-explorer)). | Reject unless the KB becomes a graph DB |
| FalkorDB Browser | v2.7.3 (2026-10-25). FalkorDB only. | Reject |
| Kuzu Explorer | Archived (GitHub API). | Reject |
| Grafana | v13.3.0 (2026-10-27), AGPL-3.0. Node graph shows up to 200 visible nodes by default ([docs](https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/)), which happens to match neighbor expansion, but has no overview and no quote view, and the time picker maps to only one axis. | Reject |

### 3.7 Note apps

All require data to be imported into their own store, so each adds a sync job and a second copy with no bitemporal semantics.

| App | Status | Why not |
|---|---|---|
| SilverBullet 2.12.1 (2026-10-12), MIT | Markdown in a folder, so it would take a generated vault. Docker or source build (Node 24+, Rust) ([README](https://github.com/silverbulletmd/silverbullet)). Maintainer reports 25k pages without major issues on 2.12 ([#2196](https://github.com/silverbulletmd/silverbullet/issues/2196)). | Object queries scan rather than use a real DB ([#1754](https://github.com/silverbulletmd/silverbullet/issues/1754)). Read-only servers reportedly index only at boot (older thread). The most scriptable of this group, but it offers nothing Obsidian projection does not. |
| Logseq 2.0.2 (2026-10-07), AGPL-3.0 | DB version is still beta, and the README warns "data loss is possible" ([README](https://github.com/logseq/logseq)). | Own SQLite; ~2 GB RAM and 40-second freeze reported ([#13327](https://github.com/logseq/logseq/issues/13327)). |
| Trilium v0.106.1 (2026-10-23), AGPL-3.0 | ETAPI, note maps, versions; claims 100k notes ([README](https://github.com/TriliumNext/Trilium)). Server runs without Docker. | Versions are note edits, not valid time. Import via API into its own DB. Note map scale unknown. |
| SiYuan v3.8.9 (2026-10-29), AGPL-3.0 | Own `.sy` JSON with SQLite index ([README](https://github.com/siyuan-note/siyuan)). | Several 2026 publish-mode access-control CVEs, e.g. [CVE-2026-45371](https://cve.imfht.com/detail/CVE-2026-45371?lang=en), which matter for its read-only surface. |
| AFFiNE v0.27.4 (2026-08-18) | Mixed license. Compose file uses Redis and pgvector Postgres ([compose](https://github.com/toeverything/AFFiNE/blob/canary/.docker/selfhost/compose.yml)). | Collaborative editor; wrong shape. Needs Docker or an equivalent manual setup. |
| AppFlowy 0.14.11 (2026-10-26) | Client AGPL; the current server is closed-source under a commercial agreement, legacy repo AGPL ([AppFlowy-Cloud](https://github.com/AppFlowy-IO/AppFlowy-Cloud)). | Wrong shape; server licensing is a further negative. |
| Outline v1.12.0 (2026-10-23) | BSL 1.1 ([license](https://github.com/outline/outline/blob/main/LICENSE)). Postgres and Redis ([env](https://github.com/outline/outline/blob/main/.env.sample)). | Team wiki; wrong shape. |
| Docmost v0.97.0 (2026-10-25), AGPL-3.0 | Docker recommended, with Postgres and Redis ([docs](https://docmost.com/docs/installation)). | Team wiki; wrong shape. |

Also seen, not pursued: Anytype and Foam (own store / VS Code), Dendron (no push since 2025-11).

### 3.8 Data and BI tools

| Tool | Status | Verdict |
|---|---|---|
| NocoDB 2026.10.1 | Connects external Postgres/MySQL with Allow Data Edit off for read-only; SQLite not listed ([docs](https://nocodb.com/docs/product-docs/data-sources/connect-to-data-source/)). License is the "Sustainable Use License", not OSI open source ([LICENSE](https://github.com/nocodb/nocodb/blob/develop/LICENSE.md)). | Reject. Nearest of this group, but a heavier Datasette with no graph, and the KB would need to be Postgres/MySQL. |
| Baserow 2.4.1 | Forum reply says it cannot browse an existing DB; data sync copies in ([thread](https://community.baserow.io/t/connecting-baserow-and-metabase-or-connect-to-external-db/9152)). | Reject |
| Teable | AGPL core, MIT packages ([LICENSE](https://github.com/teableio/teable/blob/develop/LICENSE)). Needs full control of its own Postgres ([forum](https://community.teable.ai/t/can-we-directly-use-teable-s-postgresql-server/36)). | Reject |
| Grist v1.7.22 | Apache-2.0, no Docker path via build ([README](https://github.com/gristlabs/grist-core)). Hosted limits top out at 150k rows, and Grist recommends staying under 20 MB ([limits](https://support.getgrist.com/limits/)). Revision history is document-level. | Reject |
| Metabase v0.65.2 | AGPL plus enterprise. JAR needs Java 25; SQLite officially supported ([docs](https://www.metabase.com/docs/latest/databases/connecting)). | Reject. A JVM service conflicts with the minimal-process principle, and it has no graph. |
| Evidence | MIT core, npm 40.1.8 from 2026-02. The repo is mid-rewrite toward a hosted Studio, Query Engine v3 ([repo](https://github.com/evidence-dev/evidence), [docs](https://github.com/evidence-dev/evidence/blob/main/docs/index.mdx)). Current data-source docs list no SQLite page. | Reject, direction uncertain |
| Observable Framework | ISC. Last release v1.13.4 (2026-03-02), last commit 2026-05-15 (GitHub API), so activity has slowed. Static data apps. | Reject here. It is a build tool rather than an app. |

## 4. View coverage

Y as shipped, A thin adapter, P partial, blank none. Datasette assumes a SQLite source; Obsidian assumes claims as files.

| View | Obsidian | Quartz | Datasette | Gephi Lite | LightRAG UI | Grist | NocoDB |
|---|---|---|---|---|---|---|---|
| Graph overview | P | P | | P (under cap) | P | | |
| Neighbor expansion | Y (local graph) | Y (1-hop default) | | | Y | | |
| Entity detail | A | A | A | | P | A | |
| Table + facets | Y (Bases filters) | P (static) | Y | P | | Y | Y |
| Korean FTS | P (untested) | P (per character) | P | | | | |
| Point-in-time | P (tables only) | | Y (tables only) | | | | |
| History / time series | P | A (static) | A | | | | |
| Source + quote highlight | A | A | A | | | | |
| Change feed | A (Bases on observed date) | A (static) | A | | | | |

Reading the table: no column is free of gaps, and the two columns with the broadest coverage cover Korean search only partially and the graph poorly or not at all. Note that Obsidian's A/P marks rely on the claims-as-files layout, whose scale is the thing in doubt.

## 5. Per-view conclusion

| View | Decision | Reason |
|---|---|---|
| Graph overview | **Build** | Only sigma-class renderers reach this size and no app accepts it. Gephi Lite caps below target. |
| Neighbor expansion | **Build** | Must carry as-of and superseded-edge semantics. |
| Entity detail | **Build** | Claim, source and status layout is KB-specific. |
| Table + facets | **Adopt Datasette** if SQLite is available; otherwise build a plain table in the viewer | Saves real work; removable. |
| Korean FTS | **Contract**, not a viewer decision | No app solves it. The KB must own tokenization and expose search. |
| Point-in-time | **Build** | Datasette covers tables as a stopgap, but nothing covers an as-of graph. |
| History / time series | **Build** | Simple chart plus supersession chain. |
| Source + quote highlight | **Build** | Needs verbatim quote location; no app offers it. Small: a text view plus match highlighting. |
| Change feed | **Build** | Trivial list over a contract endpoint with polling. |

The build is smaller than it sounds. Five of these are lists or detail pages over a contract, and the only technically hard one is the graph, which a library covers.

## 6. Gateway implications

- Nothing shortlisted requires a Docker host, so all of this fits WSL2 now and Proxmox later.
- The custom viewer is static files plus API calls. The gateway serves it.
- Datasette is a process to run behind the gateway with `base_url`. Keep it on a private port, and it can be started only when needed.
- Gephi Lite is static too. Self-host it behind the gateway, which removes the CORS requirement for `?file=` because both are same-origin.
- Obsidian needs no gateway, but it cannot use one either; it reads files.
- Rejected apps with their own login (Outline, Docmost) would have added auth complications. Staying with Datasette avoids that: the gateway owns auth.

## 7. Risks and unknowns

1. **KB ADR is the pivot.** Storage engine and daemon decision determine whether Datasette applies at all.
2. **Claim volume is unknown.** The Obsidian file-count argument rests on an assumed ratio.
3. **No measurements.** Obsidian, Quartz and Datasette figures are not from this workload. A KB fixture sized to target would settle them.
4. **Sources.** Obsidian scale evidence is forum anecdote, some of it old. Absence-of-feature claims ("no read-only mode", "no time support") mean I did not find it in the pages read.
5. **Unverified:** Quartz virtual-page path; Datasette facets on search results; Memgraph Lab license; Metabase runtime behaviour beyond the fetched docs; whether Utopia's UI could read another store.
