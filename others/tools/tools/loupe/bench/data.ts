// Synthetic directed multigraph for the budget in design 11: the shape of the overview response, plus a real layout from the production code.
// Hub-heavy like the S3 data, with parallel edges and a share of superseded ones, because S3 and S5 measured neither (design 6.1).
import { coldLayout } from '../src/graph/layoutCore.ts';
import { layoutInput, seededRandom } from '../src/graph/layoutInput.ts';

export const SIZES: Record<string, { nodes: number; edges: number }> = { '10k': { nodes: 10_000, edges: 51_000 }, '10k50k': { nodes: 10_000, edges: 50_000 }, '20k': { nodes: 20_000, edges: 100_000 } };

const SYLLABLES = '가나다라마바사아자차카타파하고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후그느드르므브스으즈츠크트프흐기니디리미비시이지치키티피히'.split('');

export function buildBenchGraph(nodes: number, edges: number) {
  const r = seededRandom(5);
  const ids = Array.from({ length: nodes }, (_, i) => `e:tool:n${String(i).padStart(6, '0')}`);
  const label = () => Array.from({ length: 3 + Math.floor(r() * 7) }, () => SYLLABLES[Math.floor(r() * SYLLABLES.length)]).join('');
  const nodeRows = ids.map((id) => [id, 'Tool', label(), 'external', 'active']);
  const pick = () => Math.floor(nodes * r() ** 2.4); // a few hubs, like the S3 graph
  const edgeRows: unknown[][] = [];
  const pairs: (readonly [string, string])[] = [];
  for (let i = 0; i < edges; i++) {
    const parallel = i > 0 && r() < 0.06;
    const prev = pairs[pairs.length - 1]!;
    const a = parallel ? prev[0] : ids[pick()]!;
    let b = parallel ? prev[1] : ids[Math.floor(r() * nodes)]!;
    if (a === b) b = ids[(ids.indexOf(a) + 1) % nodes]!;
    pairs.push([a, b]);
    edgeRows.push([`r-${i}`, a, b, parallel ? 'PART_OF' : 'USES', r() < 0.03 ? 'superseded' : 'active']);
  }
  const input = layoutInput({ ids, pairs });
  const { xy, community } = coldLayout(input);
  return {
    nodes: { columns: ['id', 'type', 'label', 'origin', 'status'], rows: nodeRows },
    edges: { columns: ['id', 'src', 'dst', 'rtype', 'status'], rows: edgeRows },
    ids: input.ids, xy: [...xy], community: [...community],
  };
}
