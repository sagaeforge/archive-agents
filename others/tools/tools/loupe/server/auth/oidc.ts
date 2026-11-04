// The OpenID Connect side (design v2 6.1): authorization code + PKCE S256 over a loopback redirect, done by oauth4webapi 3.8.8.
// No OIDC crypto of our own: discovery, the token request, ID token claims (iss, aud, exp, iat, nonce) and the signature check
// against the provider's JWKS are the library's. Metadata and JWKS live in memory only and are fetched at the first login (6.4).
import * as oauth from 'oauth4webapi';
import type { ClientFile } from './files.ts';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
/** Google documents both spellings of its issuer in ID tokens; its discovery document names the https one. */
const ISSUER_ALIASES: Record<string, string[]> = { [GOOGLE_ISSUER]: ['accounts.google.com'] };

export type OidcSettings = {
  issuer: string;
  client: ClientFile;
  /** Extra accepted `iss` spellings. Default: the Google alias above for Google, none otherwise. */
  issuerAliases?: string[];
};

export type Begin = { state: string; nonce: string; verifier: string; url: string };
export type Claims = { sub: string; email?: string; email_verified?: boolean };

/** A failure the caller may show: `code` is a fixed word, never a value from the provider. */
export class LoginFailure extends Error {
  readonly code: 'provider_unreachable' | 'provider_error' | 'exchange_failed' | 'id_token_invalid';
  readonly detail: string | undefined;
  constructor(code: LoginFailure['code'], detail?: string) { super(code); this.name = 'LoginFailure'; this.code = code; this.detail = detail; }
}

const loopback = (u: string) => { try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'; } catch { return false; } };
// oauth4webapi exposes this symbol for issuers with more than one spelling; it is not in its .d.ts, so it is looked up and may be absent.
const EXPECTED_ISSUER = (oauth as unknown as Record<string, symbol | undefined>)._expectedIssuer;

export class Oidc {
  private as: oauth.AuthorizationServer | null = null;
  private asFor = '';
  private readonly settings: () => OidcSettings;
  constructor(settings: () => OidcSettings) { this.settings = settings; }

  private opts(issuer: string) {
    // Plain HTTP only for a provider on this machine, which is the test provider. Google is https.
    return loopback(issuer) ? { [oauth.allowInsecureRequests]: true } : {};
  }

  async metadata(): Promise<oauth.AuthorizationServer> {
    const { issuer, issuerAliases } = this.settings();
    if (this.as && this.asFor === issuer) return this.as;
    let as: oauth.AuthorizationServer;
    try {
      const u = new URL(issuer);
      as = await oauth.processDiscoveryResponse(u, await oauth.discoveryRequest(u, { algorithm: 'oidc', ...this.opts(issuer) }));
    } catch (e) {
      throw new LoginFailure('provider_unreachable', (e as { code?: string }).code);
    }
    const aliases = issuerAliases ?? ISSUER_ALIASES[issuer] ?? [];
    if (EXPECTED_ISSUER && aliases.length) {
      (as as unknown as Record<symbol, unknown>)[EXPECTED_ISSUER] = (r: { claims: { iss?: unknown } }) => (typeof r.claims.iss === 'string' && aliases.includes(r.claims.iss) ? r.claims.iss : as.issuer);
    }
    this.as = as; this.asFor = issuer;
    return as;
  }

  /** New state, nonce and PKCE verifier, and the authorization URL that carries them. */
  /** `redirectUri` is the callback of the allowlisted origin the login started on; the same value must be used in finish(). */
  async begin(p: { scope: string; redirectUri: string; loginHint?: string | undefined }): Promise<Begin> {
    const as = await this.metadata();
    if (!as.authorization_endpoint) throw new LoginFailure('provider_unreachable', 'no authorization_endpoint');
    const { client } = this.settings();
    const redirectUri = p.redirectUri;
    // 32 random bytes each (oauth4webapi's generators): 256 bits as the design asks.
    const state = oauth.generateRandomState(), nonce = oauth.generateRandomNonce(), verifier = oauth.generateRandomCodeVerifier();
    const url = new URL(as.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, scope: p.scope,
      state, nonce, code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      prompt: 'select_account', ...(p.loginHint ? { login_hint: p.loginHint } : {}),
      // No access_type=offline: Google then returns no refresh token (6.1 step 2).
    }).toString();
    return { state, nonce, verifier, url: url.href };
  }

  /** Trades the code for an ID token and returns its checked claims. The Google tokens are dropped here and never stored. */
  async finish(callback: { code: string; state: string }, expected: { state: string; nonce: string; verifier: string; redirectUri: string }): Promise<Claims> {
    const as = await this.metadata();
    const { client, issuer } = this.settings();
    const redirectUri = expected.redirectUri;
    const c: oauth.Client = { client_id: client.client_id };
    const opts = this.opts(issuer);
    let params: URLSearchParams;
    try { params = oauth.validateAuthResponse(as, c, new URLSearchParams({ code: callback.code, state: callback.state }), expected.state); } catch (e) {
      throw new LoginFailure('provider_error', (e as { code?: string }).code);
    }
    let res: Response;
    try { res = await oauth.authorizationCodeGrantRequest(as, c, oauth.ClientSecretPost(client.client_secret), params, redirectUri, expected.verifier, opts); } catch (e) {
      throw new LoginFailure('provider_unreachable', (e as { code?: string }).code);
    }
    let result: oauth.TokenEndpointResponse;
    try {
      result = await oauth.processAuthorizationCodeResponse(as, c, res, { expectedNonce: expected.nonce, requireIdToken: true });
    } catch (e) {
      const code = (e as { code?: string }).code;
      throw new LoginFailure(code === oauth.RESPONSE_BODY_ERROR ? 'exchange_failed' : 'id_token_invalid', code);
    }
    try { await oauth.validateApplicationLevelSignature(as, res, opts); } catch (e) {
      throw new LoginFailure('id_token_invalid', (e as { code?: string }).code ?? 'signature');
    }
    const claims = oauth.getValidatedIdTokenClaims(result);
    if (!claims || typeof claims.sub !== 'string' || !claims.sub) throw new LoginFailure('id_token_invalid', 'sub');
    const out: Claims = { sub: claims.sub };
    if (typeof claims.email === 'string') out.email = claims.email;
    if (typeof claims.email_verified === 'boolean') out.email_verified = claims.email_verified;
    return out;
  }
}
