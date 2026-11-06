// The part of graphology's read API that the home screen and the e2e probes use, without graphology: the 3D path needs only ids, labels and ends.
export class MiniGraph {
  private readonly labelOf = new Map<string, string>();
  private readonly sizeOf = new Map<string, number>();
  private readonly ends = new Map<string, readonly [string, string]>();
  private readonly nbrs = new Map<string, Set<string>>();

  clear() { this.labelOf.clear(); this.sizeOf.clear(); this.ends.clear(); this.nbrs.clear(); }
  addNode(id: string, label: string, size: number) { this.labelOf.set(id, label); this.sizeOf.set(id, size); this.nbrs.set(id, new Set()); }
  addEdge(key: string, src: string, dst: string) {
    this.ends.set(key, [src, dst]);
    if (src !== dst) { this.nbrs.get(src)!.add(dst); this.nbrs.get(dst)!.add(src); }
  }
  get order() { return this.labelOf.size; }
  hasNode(id: string) { return this.labelOf.has(id); }
  nodes() { return [...this.labelOf.keys()]; }
  edges() { return [...this.ends.keys()]; }
  extremities(key: string): [string, string] { const e = this.ends.get(key)!; return [e[0], e[1]]; }
  label(id: string) { return this.labelOf.get(id) ?? id; }
  neighbors(id: string): string[] { return [...(this.nbrs.get(id) ?? [])]; }
  /** Distinct neighbours: parallel edges must not make a node look bigger (same rule as `degrees`). */
  degree(id: string) { return this.nbrs.get(id)?.size ?? 0; }
}
