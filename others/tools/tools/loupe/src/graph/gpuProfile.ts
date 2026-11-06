// A page cannot choose the GPU: the adapter is per Chrome process and `powerPreference` is ignored (design 6.1.1). So there are no runtime tiers:
// a static profile is picked from the renderer string the process already has.
export type GraphProfile = {
  name: 'default' | 'radeon';
  hideEdgesOnMove: boolean;
  antialiasEdges: boolean;
  /** Ceiling on the label budget K. */
  maxLabels: number;
  /** Whether the 20k/100k view may be chosen. */
  allow20k: boolean;
};

export const DEFAULT_PROFILE: GraphProfile = { name: 'default', hideEdgesOnMove: false, antialiasEdges: true, maxLabels: 400, allow20k: true };
export const RADEON_PROFILE: GraphProfile = { name: 'radeon', hideEdgesOnMove: true, antialiasEdges: false, maxLabels: 100, allow20k: false };

export const profileFor = (renderer: string | null | undefined): GraphProfile => (renderer && /radeon/i.test(renderer) ? RADEON_PROFILE : DEFAULT_PROFILE);

/** A throwaway context, read before sigma is built because the profile decides how it is built. Null when there is no WebGL2 at all. */
export function readWebglRenderer(): string | null {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return null;
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** `K = min(400, round(w × h / 15000))` in CSS px (design 6.1), under the profile's ceiling. */
export const labelBudget = (width: number, height: number, profile: GraphProfile) => Math.min(profile.maxLabels, Math.round((width * height) / 15_000));

export const canUse20k = (profile: GraphProfile) => profile.allow20k;
export const DEFAULT_LIMITS = { limit: 10_000, edge_limit: 50_000 } as const;
export const WIDE_LIMITS = { limit: 20_000, edge_limit: 100_000 } as const;
