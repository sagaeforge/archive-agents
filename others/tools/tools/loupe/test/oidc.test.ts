// Oidc.finish against a provider that sets authorization_response_iss_parameter_supported (as Google does).
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoginFailure, Oidc } from '../server/auth/oidc.ts';

let srv: Server;
let issuer = '';
let tokenCalls = 0;

beforeAll(async () => {
  srv = createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
    if (req.url === '/.well-known/openid-configuration') {
      json(200, {
        issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        authorization_response_iss_parameter_supported: true,
      });
    } else if (req.url === '/token') { tokenCalls++; json(400, { error: 'invalid_grant' }); } else json(404, {});
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  issuer = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }));

const expected = { state: 's1', nonce: 'n1', verifier: 'v'.repeat(43), redirectUri: 'http://localhost:1/auth/google/callback' };
const oidc = () => new Oidc(() => ({ issuer, client: { client_id: 'c', client_secret: 'x' } }));
const codeOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof LoginFailure ? e.code : 'other'));

describe('Oidc.finish and the iss callback parameter', () => {
  it('passes the callback iss to the response check, so the code reaches the token endpoint', async () => {
    tokenCalls = 0;
    // The token endpoint answers invalid_grant: that is "exchange_failed", which is past the iss check ("provider_error").
    expect(await codeOf(oidc().finish({ code: 'c', state: 's1', iss: issuer }, expected))).toBe('exchange_failed');
    expect(tokenCalls).toBe(1);
  });
  it('still refuses a callback with no iss when the provider says it sends one', async () => {
    tokenCalls = 0;
    expect(await codeOf(oidc().finish({ code: 'c', state: 's1' }, expected))).toBe('provider_error');
    expect(tokenCalls).toBe(0);
  });
  it('refuses an iss that is not the issuer', async () => {
    tokenCalls = 0;
    expect(await codeOf(oidc().finish({ code: 'c', state: 's1', iss: 'https://evil.example' }, expected))).toBe('provider_error');
    expect(tokenCalls).toBe(0);
  });
});
