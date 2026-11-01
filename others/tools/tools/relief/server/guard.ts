// Host, Origin and Fetch Metadata checks (design 11), as in loupe: a foreign page can make the browser send requests here; none may pass.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostnameOf = (hostHeader: string) => { try { return new URL(`http://${hostHeader}`).hostname; } catch { return ''; } };

export type Rejection = { status: 403; code: string; message: string };

/** @param header lower-case header lookup */
export function guard(header: (name: string) => string | undefined): Rejection | null {
  const host = header('host');
  if (!host || !LOCAL_HOSTS.has(hostnameOf(host))) return { status: 403, code: 'host_rejected', message: 'Host is not a local name' };
  const origin = header('origin');
  if (origin !== undefined && (origin === 'null' || !LOCAL_HOSTS.has(hostnameOf(origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''))))) {
    return { status: 403, code: 'origin_rejected', message: 'Origin is not local' };
  }
  const site = header('sec-fetch-site');
  if ((site === 'cross-site' || site === 'same-site') && header('sec-fetch-mode') !== 'navigate') {
    return { status: 403, code: 'cross_site_rejected', message: 'Cross-site request' };
  }
  return null;
}

/** The browser reads nothing but this origin. */
const POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "base-uri 'none'", "form-action 'none'",
];
/** For the <meta> tag, where a browser ignores frame-ancestors and logs an error for it. */
export const META_CSP = POLICY.join('; ');
export const APP_CSP = [...POLICY, "frame-ancestors 'none'"].join('; ');
