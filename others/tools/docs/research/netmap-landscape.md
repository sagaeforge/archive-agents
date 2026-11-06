# Isometric live infrastructure map: landscape survey

Date: 2026-11-01. Read-only research. Nothing installed. Method limits are in section 0.

## 0. Method and limits
- KB search (4 queries: Cloudcraft isometric / 아이소메트릭 인프라 다이어그램 / isoflow / network topology proxmox) returned only unrelated cards (tower, proxmox plugin work). No prior KB fact on this topic.
- Prior repo work reused: `docs/research/spike-results.md` (sigma 4 Hangul label failure at :202; SwiftShader headless numbers at :218, :231; real-GPU 165 Hz at :192), `ui-blocks.md:56-97`, `trends.md:201`. `tools/loupe/package.json:62` pins sigma 4.0.3.
- Auth check was done on docs/READMEs only. I did not read source code of any candidate. Treat "no broad credentials" as unverified unless stated.
- Facts marked (inference) are my reasoning, not a sourced claim.
- GitHub facts come from `gh api` on 2026-11-01. npm facts come from registry.npmjs.org on 2026-11-01. Sizes come from bundlephobia (whole package, minified / gzip).

## 1. The product the owner remembers
**Cloudcraft, now "Cloudcraft in Datadog"** (confirmed).
- Acquisition: Datadog blog "Datadog acquires Cloudcraft", 2022-11-21, https://www.datadoghq.com/blog/datadog-acquires-cloudcraft.md. Press release dated 2022-11-03 (PR Newswire via https://www.streetinsider.com/PRNewswire/Datadog+Acquires+Cloudcraft+to+Create+Live+Cloud+Architecture+Diagrams/20790230.html). It says live, real-time diagrams of customers' cloud architectures. The blog does not use the words "isometric" or "3D".
- In-Datadog product docs, fetched 2026-11-01, https://docs.datadoghq.com/datadog_cloudcraft/:
  - Platforms: AWS, Azure, GCP, OCI, vSphere. vSphere needs the Datadog Agent plus the vSphere integration.
  - Quote: "A real-time diagram of the resources is displayed in your environment."
  - Projection: "Toggle the projection from 3D (default) to 2D."
  - Overlays: Infrastructure, Observability, Security, Cost, APM (AWS only, Preview). vSphere gets only Infrastructure and Monitors.
  - Interactions: zoom reveals more names; hover shows basics; click opens a side panel (observability, cost, security); search greys out non-matches; Group By splits into sections. Grouping by `service` tag shows "a raised block".
  - Scale: more than 10,000 resources must be filtered first.
  - Access: `cloudcraft_read` permission, read-only.
- Dashboard widget, https://docs.datadoghq.com/dashboards/widgets/cloudcraft_diagram/ (fetched 2026-11-01): toggle between top-down and "isometric (3D) projection"; AWS, Azure, GCP; one overlay at a time; filter by type/region/tag; "Find in diagram".
- Standalone Cloudcraft docs (https://docs.datadoghq.com/cloudcraft, 2026-11-01): "aesthetic, real-time 3D visualizations"; AWS and Azure. Third-party pages (Jentic, Last9, GetApp; unofficial) describe isometric blocks and Live Sync, with live import behind the Pro plan.

What makes it 2.5D, from the docs above:
1. A switchable projection: isometric (default) vs top-down.
2. Resources as icon blocks. Grouping is shown as raised blocks or sections.
3. One overlay selected at a time recolors/annotates the same layout (infra, observability, security, cost).
4. Read-only live data, with filter and search by tags.
5. Click opens a side panel instead of editing in place.

Verdict for sagae: **borrow the design, reject the product.** No Proxmox, LXC, or Docker source; the only on-prem source is vSphere; it needs a Datadog account and Agent.

## 2. Verdict table

| # | Candidate | Version / date | License | Size | Maintenance | Verdict |
|---|---|---|---|---|---|---|
| 1 | Cloudcraft in Datadog | docs 2026-11-01 | commercial SaaS | n/a | active | borrow design |
| 1 | Cloudcraft standalone | docs 2026-11-01 | commercial | n/a | active | reject (AWS/Azure only) |
| 2 | Scanopy | v0.19.5, 2026-10-30 | AGPL-3.0 | Rust server + agents | pushed 2026-10-31, 5.9k stars | borrow ideas, reject now |
| 2 | NetBox + netbox-topology-views | NetBox 4.7.4 (2026-10-27); plugin v5.0.0 (2026-10-19) | Apache-2.0 | full Django app + DB | active | reject (too heavy) |
| 2 | Grafana node graph | per docs 2026-11-01 | AGPL-3.0 (oss-viewers.md:137) | n/a | active | borrow data model |
| 3 | Isoflow (community) | npm 1.1.1, 2024-09-29; repo pushed 2025-09-17 | MIT | ~1.1 MB unpacked, deps gsap, paper, zustand | slow: no release in 13 months | borrow / prototype only |
| 3 | FossFLOW | npm 1.0.5, 2025-07-04; stan-smith repo returns 404 on 2026-11-01 | MIT per npm | same deps as Isoflow | canonical repo unreachable | reject |
| 4 | three.js, orthographic | r187 / 0.187.0, 2026-10-30 | MIT | 742 KB / 186 KB gz | very active | use if depth or lighting is needed |
| 4 | PixiJS | v8.22.0, 2026-10-01 | MIT | 925 KB / 264 KB gz | active | reject (no need) |
| 4 | deck.gl | 9.4.1 (npm); latest release tag v9.3.12 on GitHub | MIT | core 772 KB / 218 KB gz | active | reject (map-centric) |
| 4 | Plain SVG / Canvas 2D with iso transform | n/a | n/a | 0 KB | n/a | **use** |
| 5 | ELK (elkjs) | 0.12.1, 2026-10-28 | EPL-2.0 OR GPL-3.0-or-later | 1.46 MB / 447 KB gz | active | **use** |
| 5 | dagre (@dagrejs/dagre) | 3.1.3, 2026-10-24 | MIT | 47 KB / 16 KB gz | active | use for flat layers only |
| 5 | WebCola | v3.3.8 (2018), repo pushed 2026-04-30 | MIT | not measured | release stale | reject |

## 3. Bucket details

### 2. Source of truth and topology tools
- **Scanopy**: README says it builds topology from SNMP, LLDP, ARP, plus the Docker API; SNMP needs read access to network gear; exports SVG/Mermaid. Source: https://github.com/scanopy/scanopy (gh api 2026-11-01). Release-note drafts (website repo PRs) mention L2 view and multiple views. It actively scans the network, so it would touch real infrastructure with SNMP and Docker API access. That is outside this task, and the project says a read-only viewer. Use only as a reference for discovery ideas.
- **NetBox + topology-views**: plugin README (2026-11-01) says coordinates can be stored in a custom field and it needs view permissions. NetBox needs its own database and an API token. It is an inventory system, not a live viewer.
- **Grafana node graph**, https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/ (2026-11-01): default 200 visible nodes; layouts Layered (default), Force, Grid; "Layered layout can be slow when the graph has more than 500 nodes"; edges frame needs `id`,`source`,`target`; nodes frame needs `id`. The nodes/edges frame is a good minimal data shape for the map.
- **Others looked at, not ranked (bucket cap)**: Homepage Proxmox widget needs an API token and shows only VM/LXC counts and CPU/memory (https://gethomepage.dev/widgets/services/proxmox/, 2026-11-01); GPL-3.0, v2.7.0. ProxCenter has a Proxmox topology page with Infrastructure/Network/Geographic views, but its license is not stated in the page I fetched (https://proxcenter-docs.pages.dev/infrastructure/topology, 2026-11-01), so I did not recommend it. Grafana's Proxmox dashboards are metrics, not topology (grafana.com dashboards 14710-14712, 12909).
- **Gap**: no existing tool combines Proxmox cluster + guests + containers + external links into one isometric live view. The repo already has a Proxmox data path (tower proxmox MCP tools, listed in this session).

### 3. Isometric diagram tools
- **Isoflow community edition**: React component, MIT, `npm install isoflow @isoflow/isopacks` (README, gh api 2026-11-01). Open-core with a paid Pro. Peer deps react >=17. Per the DeepWiki API index (https://deepwiki.com/markmanx/isoflow/2-getting-started, third-party, 2026-11-01) it has modes EDITABLE, EXPLORABLE_READONLY and NON_INTERACTIVE, validates `initialData` against a schema, fills its container, and cannot be server-rendered. The official docs site (isoflow.io/docs) returned HTTP 403 to my fetch, so the prop list is unverified. It takes a static model, so live data would mean regenerating the model. Per README its feature is a drag-and-drop editor for icons, regions and connectors; no overlay or live-metric support is documented. Last release 2024-09-29; a 13-month gap.
- **FossFLOW**: PWA built on Isoflow, npm `fossflow` 1.0.5 (2025-07-04). `gh api repos/stan-smith/fossflow` and the github.com page both returned 404 on 2026-11-01, so the canonical repo could not be checked. A search showed forks only, e.g. Abrar74774/FossFLOW (pushed 2026-10-07). Licenses conflict between sources. Reject.
- **Cloudcraft**: not embeddable and not self-hostable (SaaS).

### 4. Renderers (50 to 500 objects)
| | Label legibility | Hit-testing | GPU cost | Bundle | Headless test |
|---|---|---|---|---|---|
| SVG / Canvas 2D | Real browser text; Hangul works. Sigma 4's own SDF labels failed on Hangul (spike-results.md:202) | SVG: native DOM events. Canvas: manual picking | Low at this size (inference; not measured here) | 0 KB | Best: DOM and Playwright assertions, screenshot diff |
| three.js ortho | No built-in text; add-ons are TextGeometry or CSS2DRenderer overlays | `raycaster.setFromCamera` works with orthographic cameras | Needs WebGL | 186 KB gz | WebGL needs SwiftShader: the earlier spike measured 3.6-11 fps for 10k-node sigma scenes (spike-results.md:231); a 500-object scene is far smaller (inference) |
| PixiJS 8 | Text, BitmapText, HTMLText; BitmapText needs pre-baked glyphs, so Hangul is a risk (inference) | Built-in event system (not fetched) | WebGL/WebGPU | 264 KB gz | same WebGL limit |
| deck.gl | Text layers (not fetched) | picking built in | WebGL | 218 KB gz (core only) | same WebGL limit |

Sources: https://threejs.org/docs (2026-11-01, index only; the Raycaster note is from general knowledge, flagged), https://pixijs.com/8.x/guides/components/scene-objects/text (2026-11-01).

### 5. Auto layout
- **ELK**: Hierarchy Handling `org.eclipse.elk.hierarchyHandling`, Port Constraints, Layer Constraint `org.eclipse.elk.layered.layering.layerConstraint`, Layer ID, Layout Partitioning (https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html, 2026-11-01). Compound nodes, ports and layer pinning cover node → VM/LXC → Docker nesting. Dual license EPL-2.0 OR GPL-3.0 is fine for a private tool.
- **dagre**: `rankdir` TB/BT/LR/RL, `ranker` network-simplex/tight-tree/longest-path (wiki, 2026-11-01). The wiki did not document compound graphs, so nesting is unverified. Small and MIT.
- **Mapping 2D layout onto isometric planes (inference, design suggestion)**: give each tier (external links, Proxmox nodes, VMs/LXC, Docker) its own plane at height z. Run the layout per plane or with ELK layer constraints, then project each (x, y, z) with screen x = (x − y)·cos30°, screen y = (x + y)·sin30° − z. Draw back to front by x + y + z. Edges between tiers become vertical or diagonal links.

## 4. Recommendations
1. Product: Cloudcraft in Datadog. Borrow the 3D/2D toggle, one overlay at a time, side panel, raised group blocks.
2. Source: none of the tools fits. Keep the existing Proxmox MCP/tower path as the source and use Grafana's nodes/edges shape as the data contract.
3. Isometric tool: build it. Use Isoflow only as a throwaway prototype of the look.
4. Renderer: SVG with an isometric transform first. Move to three.js orthographic only if depth, lighting or more than a few thousand elements appear.
5. Layout: ELK for nested tiers, with a per-plane projection. dagre if tiers stay flat.

## 5. Open items not verified
- Isoflow's exact props and data schema (official docs returned 403).
- dagre compound-graph support.
- deck.gl OrthographicView and Pixi hit-testing details were not fetched.
- No performance run for any 500-object scene. All GPU-cost statements for this size are inference.
