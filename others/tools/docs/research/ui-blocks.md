# Viewer building blocks, assuming a web app (as of 2026-10-31)

Track: building blocks for the read-only KB viewer, plus the server base it shares with the gateway.
Nothing third-party was installed or run. Facts come from `npm view`, `gh api`, repo source and official docs.
No candidate needs Docker for what is recommended; the local environment is Node v26.13.0, Bun 1.4.4, npm 11.20.0, Python 3.14.4 with pip and venv.

## 1. Recommendation

| Layer | Pick | Version (release date) |
|---|---|---|
| Graph render | sigma + graphology + @react-sigma/core | 4.0.4 (2026-10-27), 0.26.0 (2025-01-26), 6.0.0 |
| Layout | graphology-layout-forceatlas2 worker, positions cached; @sigma/layout-fa2-gpu as a spike | 0.10.1 (2022-10-17); 4.0.0 (2026-10-08) |
| Communities | graphology-communities-louvain, run in our own worker | 2.0.2 (2024-12-17) |
| Table | @tanstack/react-table + react-virtual, server-side mode | 9.3.1 (2026-10-12), 3.14.24 (2026-10-29) |
| Timeline, series | ECharts, tree-shaken imports | 6.1.0 (2026-05-19) |
| Markdown | unified, remark, rehype-sanitize, then Shiki | unified 11.0.5, rehype-sanitize 6.0.0, shiki 4.5.0 (2026-10-01) |
| Quote anchoring | W3C selector shape, approx-string-match, a vendored copy of Hypothesis `match-quote.ts`, CSS Custom Highlight API | approx-string-match 2.0.1 (2026-10-09) |
| Palette | cmdk through shadcn `Command`, `shouldFilter={false}` | 1.1.1 (2025-03-14) |
| App | Vite + React + TanStack Router + TanStack Query, SPA only | 8.3.5, 19.3.1, 1.170.46, 5.105.0 |
| UI kit | shadcn on Base UI, Tailwind v4 | shadcn 4.23.0, @base-ui/react 1.9.0, tailwindcss 4.3.3 |
| Server | Hono on Bun, portable to Node 26 | hono 4.13.14 (2026-10-25), bun 1.4.4 (2026-10-22) |
| Contract types | openapi-typescript + openapi-fetch + openapi-react-query | 7.13.0, 0.17.0, 0.5.4 (all 2026-02-11) |
| Mock | Our own thin Hono `kb-mock` over KB fixtures; Prism for day 0 only | @stoplight/prism-cli 5.16.0 (2026-07-17) |
| Contract test | Schemathesis in a Python venv; ajv for fixtures | 4.32.7 (2026-10-27), ajv 8.20.0 |

Why this coheres:

- The viewer is one single-user, read-only, client-heavy SPA. SSR buys nothing, so there is no full-stack framework.
- Hono is the one server dependency. The same framework hosts the viewer's static build, `kb-mock`, the proxy to a KB read API, and MCP over `@hono/mcp`. That matches the gateway request directly.
- The viewer only calls `/api/kb/*` on the gateway. Whether the KB ADR lands on a daemon or no daemon, the gateway can proxy or embed a read adapter, and the viewer does not change.
- There is one mock, and it runs over real HTTP. Schemathesis can therefore prove the mock conforms to the contract, and the same command later runs against the real KB.

## 2. Measured versus unmeasured

No head-to-head benchmark of these graph libraries at 10k nodes / 50k edges was found. One search looked for it and found none; a May 2026 arXiv paper on WebGL graph rendering cites sigma and Cytoscape only qualitatively ([arXiv 2605.17498](https://arxiv.org/html/2605.17498v1)).

| Claim | Status | Conditions |
|---|---|---|
| Cytoscape WebGL: ~20 to 100+ FPS at ~1.2k/16k; ~3 to ~10 FPS at ~3.2k/68k | Published, preliminary | M1 MBP, Chrome, 3.31 preview, "subjective" ([blog](https://blog.js.cytoscape.org/2025/01/13/webgl-preview/)) |
| sigma `antialiasEdges:false` "up to x5"; halving vertices ~6% vs pixel work up to ~80% | Published, relative only | Hundreds of thousands of edges; hardware unstated; no FPS ([docs](https://www.sigmajs.org/how-to/technical/performance/)) |
| Louvain ~938 ms on 50k/994,713 edges; ~52.7 ms on 1k/9,724 | Published | Node benchmark script; hardware unstated ([docs](https://graphology.github.io/standard-library/communities-louvain.html)) |
| cosmos.gl "hundreds of thousands of points and links" | Unmeasured claim | "modern hardware", no numbers ([README](https://github.com/cosmosgl/graph)) |
| reagraph "high-performance" | Unmeasured claim | No figures ([README](https://github.com/reaviz/reagraph)) |
| G6 large-graph performance | Not found | Docs describe routes only ([docs](https://g6.antv.antgroup.com/en/manual/layout/overview)) |
| uPlot 34 ms cold start, 47.9 KB, vs ECharts 55 ms | Published but dated | 2023-03-11, Ryzen 5850U, Chrome 113, ECharts 5.4.1; data size not stated ([README](https://github.com/leeoniya/uPlot)) |
| cmdk "Good performance up to 2,000-3,000 items" | Maintainer statement | No benchmark ([README](https://github.com/dip/cmdk)) |
| Elysia 255,575 req/s vs Hono 203,938 req/s | Published, stale | Bun 0.7.2, 2023-08-06, i7-13700K ([docs](https://elysiajs.com/at-glance.html)) |
| openapi-fetch 300k ops/s, 6 kB | Published, approximate | Project says rough baseline; relative figures are the reliable part ([docs](https://openapi-ts.dev/openapi-fetch/)) |

Sigma at 10k/50k with labels on, FA2 convergence time at that size, and p95 under 200 ms for the overview are all **unmeasured**. Section 12 lists a spike to settle them.

## 3. Graph rendering

| Project | Latest | Licence | Activity | Render | Layout, communities | Fit |
|---|---|---|---|---|---|---|
| sigma + graphology | 4.0.4, 2026-10-27 | MIT | Pushed 2026-10-27, 6 open issues | WebGL 2 | FA2 worker, GPU FA2, Louvain | **Adopt** |
| cosmos.gl `@cosmos.gl/graph` | 3.5.1, 2026-10-08 | MIT | Pushed 2026-10-29, OpenJS governed | WebGL 2 via luma.gl | GPU simulation, no client communities | Reject as primary |
| Cytoscape.js | 3.34.4, 2026-10-15 | MIT | Pushed 2026-10-30 | Canvas, WebGL mode | Many layouts, extension ecosystem | Reject for overview |
| reagraph | 4.32.0, 2026-06-25 | Apache-2.0 | Pushed 2026-06-25 | three.js | graphology-based | Reject |
| react-force-graph | 1.48.3, 2026-09-29 | MIT | 218 open issues | Canvas 2D, three.js 3D | d3-force or ngraph | Reject |
| AntV G6 | 5.1.1, 2026-05-08 | MIT | 333 open issues | Canvas, SVG, WebGL via @antv/g | WASM and GPU layout packages | Reject |

**sigma 4.** The [changelog](https://github.com/jacomyal/sigma.js/blob/main/CHANGELOG.md) describes a rewrite: labels moved into WebGL as signed distance fields, a primitives system replaced multi-program support, a declarative styles API was added, and node dragging and parallel-edge handling are now built in. WebGL 2 is required. The peer range of `@react-sigma/core` 6.0.0 covers `sigma ^4` and `graphology ^0.26`, so the React binding has already caught up.

Performance defaults that matter for 50k edges come from the [performance guide](https://www.sigmajs.org/how-to/technical/performance/):

- Register only `pathLine()` when self-loops are not drawn. Otherwise every edge pays the 66-vertex loop cost.
- Keep `enableEdgeEvents` off, which is already the default.
- Prefer a solid colour near the background over edge opacity.
- Turn off `antialiasEdges` for the overview.

**Hangul labels are a real risk in sigma 4.** This comes from reading [`sdf-atlas.ts`](https://github.com/jacomyal/sigma.js/blob/main/packages/sigma/src/core/sdf-atlas.ts), not from running it:

- Glyphs are generated on demand per Unicode code point, with no shaping. Text must be NFC-normalized, because decomposed jamo would render as separate glyphs.
- Defaults are a 64 px font, 8 px buffer, 2 px margin and a 2048 px atlas. My arithmetic gives about 24 × 24 ≈ 576 full-width glyphs per page, so ordinary Korean text will overflow one page.
- The atlas manager does paginate (`atlasIndex`, a `textures` array). The label shader I read declares a single `u_atlasSize`, and I could not confirm how multi-page drawing is bound. **Test this before committing.** Search of the issue tracker found nothing on CJK.
- Fallback if it fails: disable sigma labels and draw the top-N labels as a DOM overlay.

**Layout.** The [FA2 worker](https://graphology.github.io/standard-library/layout-forceatlas2.html) gives `start/stop/kill`, `barnesHutOptimize` gives O(n log n) repulsion, and nodes need initial positions. Release 0.10.1 dates from 2022, but it is a stable algorithm and reagraph also depends on it.

[`@sigma/layout-fa2-gpu`](https://github.com/jacomyal/sigma.js/tree/main/packages/layout-fa2-gpu) is the attractive alternative. It runs in sigma's own WebGL context, never blocks the main thread, offers `layout.run({duration})` for headless runs, and needs `EXT_color_buffer_float` and `EXT_float_blend`. It only reached 4.0.0 on 2026-10-08, so use it as a spike and keep the worker as the default.

Either way, cache positions per graph version and do not re-run the layout on each 30-60 s poll. Seed new nodes near their neighbours and pin existing ones.

**Communities.** Louvain handles directed graphs and has the published timings above, but the call is synchronous, so run it in a worker. Leiden is not available as a maintained package:

- `graphology-communities-leiden` exists in the repo as `private: true` v0.0.1 and returns 404 on npm.
- Third-party options exist (`@aflsolutions/graphology-communities-leiden` 1.1.1, `ngraph.leiden` 0.3.0), but I did not vet them.
- If Leiden quality matters, compute it on the KB side and ship the community id in the payload.

**Rejected:**

- **cosmos.gl.** A real contender for raw scale and properly MIT under OpenJS, but its README describes no built-in labels, only hooks such as `getSampledLinks()` for drawing your own overlays. Our scale is far below its target range, and entity labels matter more here than million-edge throughput. Revisit if overview targets grow by 10x.
- **`@cosmograph/cosmos`, `@cosmograph/cosmograph`, `@cosmograph/react`.** All are CC-BY-NC-4.0 on npm, so do not confuse them with `@cosmos.gl/graph`.
- **Cytoscape.js.** The WebGL mode was labelled provisional in 3.31, and I found no later statement that it is stable. It draws nodes via a Canvas sprite sheet, with a multi-second first load and dropped edge styles. Its only published FPS figure at comparable density is ~10 FPS at 3.2k/68k. Its strength is rich neighbourhood styling, which sigma 4 now mostly covers.
- **reagraph.** Heavy three.js and react-three stack, no published limits, and a GitHub code search found no `new Worker` in the repo. That is indicative only, since code search can miss files.
- **react-force-graph.** The 2D variant is Canvas, the 3D variant is three.js, and the README does not mention worker layout. A code search of `force-graph` also found no `new Worker`.
- **G6.** Capable, but it offers the largest surface here, 333 open issues, and no large-graph numbers. Its docs even disagree on whether GForce is GPU-accelerated.

## 4. Table and database view

| Project | Latest | Licence | Fit | Reason |
|---|---|---|---|---|
| TanStack Table + Virtual | 9.3.1, 2026-10-12 | MIT | **Adopt** | Headless, so server facets, Korean text and links render as normal DOM |
| AG Grid Community | 36.2.0, 2026-09-16 | MIT | Reject | Set Filter, Multi Filter, Advanced Filter, Columns Tool Panel and Row Grouping are Enterprise only ([pricing](https://www.ag-grid.com/license-pricing/)) |
| Glide Data Grid | 6.0.3, 2024-02-03 | MIT | Reject | No stable release since 2024; latest commit is a 6.0.4 alpha from 2026-01-21 |
| react-data-grid | 7.0.0-beta.63 | MIT | Reject | `latest` is a beta |

AG Grid's excluded features are exactly the facet UI this view needs, so its Community edition leaves us building facets anyway.

TanStack Table v9 went stable on [2026-08-04](https://tanstack.com/blog/announcing-tanstack-table-v9). The API changed: `useTable` replaces `useReactTable`, and features are declared explicitly. Many examples online are still v8, including possibly the shadcn data-table recipe, which I did not check. Keep filtering, sorting and paging in manual server mode, with facet counts from the API.

## 5. Timeline and time series

| Project | Latest | Licence | Fit | Reason |
|---|---|---|---|---|
| ECharts | 6.1.0, 2026-05-19 | Apache-2.0 | **Adopt** | One library covers step lines, intervals via custom series, zoom, brush and histograms |
| uPlot | 1.6.32, 2025-03-14 | MIT | Hold | Fastest, but no intervals and no general interaction; repo active 2026-10-30 |
| Observable Plot | 0.6.17, 2025-02-14 | ISC | Reject | Docs say pan and zoom are "planned for a future release" and brushing is "under development" ([docs](https://github.com/observablehq/plot/blob/main/docs/features/interactions.md)) |
| vis-timeline | 8.5.6, 2026-10-26 | Apache-2.0 or MIT | Reject | Purpose-built and active, but `moment` and `vis-data` peers and no official React wrapper in the README |
| visx | 4.0.0, 2026-06-11 | MIT | Reject | Primitives, so more hand-built chart code than this project wants |

Picking ECharts is a judgement call, based on feature coverage per dependency and not on a benchmark. The history view needs value-over-valid-time, supersession intervals and a brush for the point-in-time cursor, and one library handles all three.

**ECharts security condition.** Tooltips render HTML, and releases have fixed tooltip XSS twice: [5.5.1 and 6.1.0](https://github.com/apache/echarts/releases). The KB holds external text, so any tooltip must use an escaping formatter. Import from `echarts/core` to limit the bundle; bundle size is unmeasured here. Reach for uPlot only if a single series actually exceeds roughly 100k points, which is unlikely for claim history.

## 6. Markdown, source view and quote highlighting

**Pipeline.** `remark-parse` → `remark-gfm` → `remark-rehype` → `rehype-sanitize` → Shiki → `hast-util-to-jsx-runtime`. Do not enable raw HTML passthrough unless needed.

- [rehype-sanitize](https://github.com/rehypejs/rehype-sanitize) follows GitHub's schema and drops anything not allowed. Anything after it is unprotected, so only trusted transforms go there. It prefixes `id` and `name` with `user-content-` to stop DOM clobbering.
- Shiki: [avoid the full bundles](https://shiki.style/guide/best-performance). Use `shiki/core` with the JavaScript regex engine, lazy-load languages, and move highlighting to a worker.
- DOMPurify 3.4.17 is only needed if the KB ever stores raw HTML snapshots. `rehype-sanitize` covers the Markdown path.

**Anchoring.** Store selectors in the [W3C Web Annotation](https://www.w3.org/TR/annotation-model/) shape (a Recommendation dated 2017-02-23) without taking on a framework: `TextQuoteSelector {exact, prefix, suffix}` plus `TextPositionSelector {start, end}`.

| Library | Status | Fit |
|---|---|---|
| `approx-string-match` | 2.0.1, 2026-10-09, MIT | **Adopt** |
| Hypothesis `match-quote.ts` | No npm package; in [`hypothesis/client`](https://github.com/hypothesis/client/tree/main/src/annotator/anchoring), active; BSD-style LICENSE | **Adapt**: vendor the file, keep the notice |
| `@apache-annotator/dom` | 0.2.0, 2021; [repo archived](https://github.com/apache/incubator-annotator) | Reject |
| `dom-anchor-text-quote` | 4.0.2, 2017 | Reject |

Hypothesis's algorithm tries exact `indexOf` first, then approximate search, and scores candidates with quote 50, prefix 20, suffix 20, position hint 2. One detail to fix when vendoring: the doc comment promises `null` below a quality threshold, but the code applies no threshold, so add one and show "quote not located" rather than a wrong highlight.

**Highlighting.** The CSS Custom Highlight API changes no DOM, so it does not fight React, and it is [Baseline 2025](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API). It adds no semantics, so add an accessible cue or use `<mark>` as a fallback.

**Three things the KB contract must pin down:**

1. **Offset unit.** The W3C spec counts Unicode code points, while JS strings index UTF-16 units. Any astral character shifts naive offsets.
2. **Which text offsets refer to.** Prefer the normalized snapshot text. Rendered Markdown differs from its source, so show the plain snapshot for offset-exact highlighting, and use the quote selector with fuzzy matching in the rendered view.
3. **Normalization form.** NFC for Korean text, on both stored quotes and search input.

## 7. Command palette and search UI

| Project | Latest | Activity | Fit |
|---|---|---|---|
| cmdk | 1.1.1, 2025-03-14 | Now `dip/cmdk`; last source change 2025-03, README 2025-10; 54 issues, 26 PRs open | **Adopt** |
| Base UI Autocomplete | @base-ui/react 1.9.0, 2026-10-09 | Active | Fallback |
| kbar | 1.0.0, 2026-08-10 | Revived | Reject |

Korean search is the deciding factor, so I checked the source: cmdk [skips Enter](https://github.com/dip/cmdk/blob/main/cmdk/src/index.tsx) when `isComposing || keyCode === 229`, which is the correct guard. No IME issue turned up in its tracker.

Set `shouldFilter={false}` so the server does ranking and tokenization. That also avoids the 2,000-3,000 item limit. shadcn's [Command](https://ui.shadcn.com/docs/components/command) wraps cmdk, so adoption is one CLI command. cmdk is effectively in maintenance mode and pulls in Radix Dialog, which is acceptable for a small dependency.

If it breaks on a future React, [Base UI Autocomplete](https://base-ui.com/react/components/autocomplete) already supports `filter={null}`, async results, groups and a 10,000-item virtualized example. Its docs do not cover IME or a palette recipe. kbar bundles fuse.js client-side search, which is the wrong model for server-side Korean search.

## 8. App stack

| Option | Latest | Fit | Reason |
|---|---|---|---|
| Vite + React + TanStack Router | 8.3.5, 19.3.1, 1.170.46 | **Adopt** | Client-only; typed search params suit `?asOf=...` URLs; workers supported natively |
| TanStack Start | 1.169.4 | Reject | [Stable 2026-10-13](https://tanstack.com/blog/tanstack-start-1-0), 18 days old; adds a server layer duplicating the gateway |
| Next.js | 16.4.3 | Reject | 192 MB package; RSC and SSR add nothing to a WebGL SPA |
| SvelteKit | 3.1.1 | Reject | Healthy, but `react-sigma`, shadcn and most examples here are React |
| Astro | 7.4.4 | Reject | Content-site model; this app is one interactive island |

Vite [recommends `new Worker(new URL(...), {type:'module'})`](https://vite.dev/guide/features#web-workers) and emits workers as separate chunks. Vite 8 uses Rolldown and [went stable 2026-03-12](https://vite.dev/blog/announcing-vite8).

**Server:**

| Option | Latest | Fit | Reason |
|---|---|---|---|
| Hono | 4.13.14, 2026-10-25 | **Adopt** | No dependencies, runs on Bun and on Node through `@hono/node-server` 2.1.5, has `hono/proxy` and `@hono/mcp` |
| Elysia | 1.4.30, 2026-08-26 | Reject | Best features are code-first types and Eden, which work against a KB-owned contract; 411 open issues |
| `Bun.serve` alone | 1.4.4 | Reject | No middleware, so auth, logging and proxying would be hand-written |

Hono notes from primary sources:

- [`proxy()`](https://hono.dev/docs/helpers/proxy) wraps `fetch` and handles encoding and hop-by-hop headers. The docs warn against forwarding all request headers, because that leaks credentials. Its docs do not describe streaming behaviour, which the gateway track should check for SSE.
- [`@hono/mcp`](https://jsr.io/@hono/mcp@0.3.2) provides Streamable HTTP and lists Bun as supported. npm has 0.3.5. It is pre-1.0.
- The Elysia-versus-Hono throughput gap is from 2023 and irrelevant to a single-user tool.

**Runtime compatibility.** Node 26 satisfies every `engines` field checked, including the strictest ones: Prism `>=24.18.0`, Scalar `>=22.19.0`, Orval and Hey API `>=22.18.0`, Astro `>=22.23.4`.

[Bun's compat page](https://bun.com/docs/runtime/nodejs-compat) targets Node v26 and says Next.js and Express work, but says nothing about Vite or MSW. It also lists `module.register` as a no-op and notes `http.Server` does not extend `net.Server`. So use Bun for install, workspaces and the production gateway, and run Vite and other dev tooling on Node 26 until tested otherwise.

## 9. UI kit

shadcn's [changelog](https://ui.shadcn.com/docs/changelog) lists "Base UI as the Default" and "React Aria" in July 2026. Only the titles were visible to me; third-party mirrors report that Radix remains supported, with new components shipped for both.

- Base UI: stable since December 2025 per third-party sources, 1.9.0 now.
- Tailwind v4: [targets](https://tailwindcss.com/docs/compatibility) Chrome 111+, Safari 16.4+, Firefox 128+, which is fine for a personal tool.
- Note that `@base-ui-components/react` is the older pre-release name. Use `@base-ui/react`.
- Rejected: plain Radix for a new project, since new installs default to Base UI and cmdk already brings in the one Radix piece needed.

## 10. Contract-first tooling

**Client generation**

| Project | Latest | Fit | Reason |
|---|---|---|---|
| openapi-typescript + openapi-fetch | 7.13.0, 0.17.0, 2026-02-11 | **Adopt** | [3.0 and 3.1](https://openapi-ts.dev/introduction), runtime-free types, 6 kB client, TanStack Query wrapper |
| Orval | 8.46.0, 2026-10-30 | Hold | Very active, but generates a large surface, and mock data is [Faker-based](https://orval.dev/docs/guides/msw), not fixtures; docs show MSW 2-style code |
| Hey API | 0.99.0, 2026-06-22 | Reject | Self-described [initial development](https://heyapi.dev/openapi-ts/get-started), exact pinning advised; 661 open issues |

Risk on the adopted option: no release since February, and recent commits I sampled are dependency bumps. It stays low-risk because the output is plain types and `openapi-fetch` is thin, so replacing it would be cheap.

**Mock server**

| Project | Latest | Fit | Reason |
|---|---|---|---|
| Own `kb-mock` on Hono + KB fixtures | n/a | **Adopt** | The only option that can compute neighbours, `as_of` and facets from fixtures |
| Prism | 5.16.0, 2026-07-17 | Adopt, day 0 only | Serves examples or schema-generated data with no code ([docs](https://github.com/stoplightio/prism/blob/master/docs/guides/01-mocking.md)) |
| Scalar mock server | 0.20.3, 2026-10-30 | Reject | [`x-handler`](https://scalar.com/tools/mock-server/custom-request-handler) puts mock JS inside the OpenAPI file, polluting a KB-owned contract |
| MSW + `@mswjs/source` | 3.0.3, 0.5.0 | Reject for now | [3.0.0](https://github.com/mswjs/msw/releases) shipped 2026-09-28 with many breaking changes; adds a second mock that cannot be fuzzed over HTTP |
| Microcks | 1.15.0 | Reject | Server platform, disproportionate here; runtime not checked |

This deviates from "no reinventing" on purpose, and only a little. Prism is stateless and picks responses by status and example, so a neighbour-expansion or point-in-time view would show the same canned body whatever the parameters. A few hundred lines of Hono over fixtures is the minimum that exercises those views. `app.request()` also lets tests call it in process, which removes the need for MSW.

Prism's dependency list includes `@scarf/scarf`, which is an install-analytics package. Check the opt-out before installing.

**Contract testing**

- **Schemathesis** 4.32.7: [supports OpenAPI 3.1 and 3.2](https://schemathesis.readthedocs.io/en/stable/), stateful chains, and checks server errors and schema violations with `curl` reproducers. `uv` is not on PATH, so use a `python3 -m venv` plus `pip install schemathesis`, which the [quick start](https://schemathesis.readthedocs.io/en/stable/quick-start/) allows. Required Python version was not stated, and compatibility with Python 3.14.4 is undetermined.
- **ajv** 8.20.0 (`ajv/dist/2020`) validates KB fixtures against the schema, for JSON Schema 2020-12.
- **KB repo CI, not this repo:** `oasdiff` v1.35.0 (2026-10-28) for breaking changes, and Spectral 6.17.0 or Redocly CLI 2.72.1 for lint.

## 11. What the viewer needs from the KB contract

- Overview payload as compact arrays with stable ids, `community` and optional `x`/`y`, served with `ETag`. My rough estimate is about 4 MB of JSON at 10k/50k before compression, so a p95 under 200 ms is realistic for neighbour expansion but doubtful for the overview unless cached.
- Both time axes as explicit parameters on every read: `as_of_valid` and `as_of_observed`.
- A change-feed cursor, so polling does not refetch the graph.
- Facet counts from the server.
- Quote selectors with the three rules from section 6.

## 12. Spike before committing

About one day, in the next stage, on the actual browser (WSL2 serving to a browser on the Windows host, presumably):

1. Sigma 4 at 10k/50k synthetic: FPS at pan and zoom, with defaults and with the guide's settings.
2. **3,000 distinct Hangul syllables as labels**, to settle the atlas question.
3. FA2 worker versus `@sigma/layout-fa2-gpu`: time to a stable layout.
4. Louvain in a worker: time, including graph serialization.
5. Overview JSON size and parse time.
6. Vite under Node 26 and under `bun --bun`; Hono `proxy()` with streaming.

Exit criterion: if item 1 or 2 fails, try the DOM label overlay first, then cosmos.gl with overlays.

## 13. Unresolved

- Rendered Markdown highlighting may need text-node mapping beyond the vendored `match-quote.ts`; I read the file list and `match-quote.ts`, not `text-range.ts`.
- Snapshot format is undecided. If it includes HTML or PDF, DOMPurify and a different source view are needed.
- Bun 1.4.4 behaviour with Vite 8 and Schemathesis on Python 3.14 are both untested.
- Cytoscape WebGL's current stability: no 3.34 notes were found.
