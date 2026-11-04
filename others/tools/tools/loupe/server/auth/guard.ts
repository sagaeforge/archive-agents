// The request checks of design v2 6.3. Only the origins on the allowlist (default http://localhost:4812; owner-corrected and ADR-0005 2026-11-04),
// each matched exactly: v1's `localhost` allowance and its `navigate` pass are gone from the data paths. Every function returns a
// refusal or null.
export type Kind =
  /** GET/HEAD /kb/* and GET /auth/* that is not the callback. */
  | 'read'
  /** POST /auth/* and anything on /kb-write/*. */
  | 'post'
  /** GET /auth/google/callback: a top-level navigation coming back from the provider. */
  | 'callback'
  /** The app's own files. */
  | 'static';

export type Refusal = { status: 403 | 405 | 415; code: string; title: string };
type Header = (name: string) => string | undefined;

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostnameOf = (hostHeader: string) => { try { return new URL(`http://${hostHeader}`).hostname; } catch { return ''; } };

export const kindOf = (path: string, method: string): Kind => {
  if (path === '/auth/google/callback') return 'callback';
  if (path.startsWith('/kb-write/') || path === '/kb-write') return 'post';
  if (path.startsWith('/auth/') || path === '/auth') return method === 'GET' || method === 'HEAD' ? 'read' : 'post';
  if (path.startsWith('/kb/') || path === '/kb') return 'read';
  return 'static';
};

/** The allowlisted origin whose host the request names, or null. */
export function originForHost(host: string | undefined, origins: readonly string[]): string | null {
  if (!host) return null;
  return origins.find((o) => new URL(o).host === host) ?? null;
}

/**
 * 127.0.0.1 or [::1], for the app's own files: the browser is sent to http://localhost:<port> when that is allowlisted (WebAuthn
 * cannot use an IP as its RP ID; ADR-0005 반영 2026-11-04). sessionStorage and the redirect URI belong to that origin.
 */
export function loopbackAlias(header: Header, origins: readonly string[]): string | null {
  const h = header('host');
  if (!h) return null;
  try {
    const u = new URL(`http://${h}`);
    if (!LOCAL_NAMES.has(u.hostname) || originForHost(h, origins)) return null;
    const port = u.port || '80';
    const target = `http://localhost:${port}`;
    return origins.includes(target) ? target : null;
  } catch { return null; }
}

/** `origin` is the allowlisted origin matched from the Host header (originForHost), or null when none matched. */
export function check(kind: Kind, method: string, header: Header, origin: string | null, path = ''): Refusal | null {
  // Host: exact match with an allowlisted origin. A DNS rebinding name, another port, or `localhost` on the data paths is refused.
  if (!origin || header('host') !== new URL(origin).host) return { status: 403, code: 'host_rejected', title: 'Host is not an allowed origin' };

  const o = header('origin');
  const site = header('sec-fetch-site');
  switch (kind) {
    case 'read':
      if (o !== undefined && o !== origin) return { status: 403, code: 'origin_rejected', title: 'Origin is not this origin' };
      if (site !== undefined && site !== 'same-origin') return { status: 403, code: 'cross_site_rejected', title: 'Not a same-origin request' };
      return null;
    case 'post':
      if (o !== origin) return { status: 403, code: 'origin_rejected', title: 'Origin is missing or not this origin' };
      if (site !== undefined && site !== 'same-origin') return { status: 403, code: 'cross_site_rejected', title: 'Not a same-origin request' };
      if (method !== 'POST') return { status: 405, code: 'method_not_allowed', title: 'POST only' };
      // A form or no-cors request cannot send application/json or a custom header without a preflight, which gets no CORS answer.
      if (!/^application\/json(\s*;.*)?$/i.test(header('content-type') ?? '')) return { status: 415, code: 'content_type_rejected', title: 'application/json only' };
      if (header(path.startsWith('/kb-write') ? 'x-loupe-write' : 'x-loupe-auth') !== '1') return { status: 403, code: 'marker_missing', title: 'Request marker header missing' };
      return null;
    case 'callback':
      // Origin is absent or the provider's on a top-level navigation; the live `state` stands in for it.
      if (method !== 'GET') return { status: 405, code: 'method_not_allowed', title: 'GET only' };
      if (header('sec-fetch-mode') !== 'navigate' || header('sec-fetch-dest') !== 'document') return { status: 403, code: 'not_navigation', title: 'Callback must be a top-level navigation' };
      return null;
    case 'static':
      if (o !== undefined && o !== origin) return { status: 403, code: 'origin_rejected', title: 'Origin is not this origin' };
      // A link from another site may open the app in a tab of its own; nothing else from another site passes.
      if (site !== undefined && site !== 'same-origin' && site !== 'none' && !(header('sec-fetch-mode') === 'navigate' && (header('sec-fetch-dest') ?? 'document') === 'document')) {
        return { status: 403, code: 'cross_site_rejected', title: 'Cross-site request' };
      }
      return null;
  }
}
