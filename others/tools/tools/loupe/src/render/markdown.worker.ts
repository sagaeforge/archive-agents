import { highlightTree } from './highlight.ts';
import { linkNodeRefs, markdownToTree } from './pipeline.ts';

self.onmessage = async (e: MessageEvent<{ id: number; text: string; wikilinks: boolean }>) => {
  const { id, text, wikilinks } = e.data;
  try {
    const parsed = await markdownToTree(text);
    const tree = wikilinks ? linkNodeRefs(parsed) : parsed;
    // A failed highlight costs colour, not the page.
    const out = await highlightTree(tree).catch(() => tree);
    self.postMessage({ id, tree: out });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
