// One upstream: its connection, state, backoff and the last good snapshot of its lists.
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, ProtocolError, ProtocolErrorCode, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Prompt, Resource, ResourceTemplateType, Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Agent } from 'undici';
import { sha256, type UpstreamConfig } from './config.js';
import { event, redact } from './log.js';

export const VERSION = '0.1.0';
// retryWaitMs keeps a call that meets backoff inside 2 s. slackMs is what a retry needs to be up inside that wait. maxBytes is one stdio message.
export const LIMITS = { connectMs: 1_000, startMs: 15_000, listMs: 3_000, connectWaitMs: 4_000, retryWaitMs: 1_900, slackMs: 500, maxBytes: 2 ** 26, ringBytes: 65_536 };
// A closed loopback port hangs on this host. Headers and body are unlimited: long silent calls and listen streams are normal.
const dispatcher = new Agent({ connect: { timeout: LIMITS.connectMs }, headersTimeout: 0, bodyTimeout: 0 });
const limited: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);
export const describe = (err: unknown) => redact([(err as Error).message ?? String(err), (err as { cause?: { code?: string } }).cause?.code].filter(Boolean).join(': '));
const closed = (err: unknown) => /^(fetch failed|terminated)$/.test((err as Error).message) || (err as SdkHttpError).status === 404;

export class Upstream {
  state: 'connecting' | 'ready' | 'backoff' = 'connecting';
  client: Client | null = null;
  lists = { tools: [] as Tool[], prompts: [] as Prompt[], resources: [] as Resource[], resourceTemplates: [] as ResourceTemplateType[] };
  stdio: StdioClientTransport | null = null;
  stderr = Buffer.alloc(0);
  lastError?: string;
  toolsChangedAt?: string;
  toolHashes: Map<string, string> | null = null; // Null until the first tools/list answer. An empty first list is a baseline like any other.
  static onLists = () => {}; // Set by merge.ts, which owns what a new snapshot means.
  attempt = 0;
  readonly settled: Promise<unknown>; // The end of the first attempt or connectWaitMs, whichever comes first.
  private failed = 0;
  private at = 0; // By state: ready since, or next retry due.
  private retryTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private refreshes = Promise.resolve();

  constructor(public cfg: UpstreamConfig) {
    this.settled = Promise.race([this.connect(), sleep(LIMITS.connectWaitMs)]);
  }

  get era() { return this.client?.getNegotiatedProtocolVersion(); }

  // Consecutive failures. 60 s in ready clears them.
  get failures() { return this.state === 'ready' && performance.now() - this.at >= 60_000 ? 0 : this.failed; }

  private async connect() {
    this.attempt += 1;
    this.state = 'connecting';
    const { command, args, env, cwd, url, headers } = this.cfg;
    const watched = { autoRefresh: false, onChanged: () => void this.refresh() };
    // stdio stays on the 2025 handshake any server speaks; `auto` there would spawn a probe sibling.
    const http = url ? { versionNegotiation: { mode: 'auto' as const }, capabilities: { elicitation: { form: {} } } } : {};
    const listChanged = { tools: watched, prompts: watched, resources: watched };
    const client = (this.client = new Client({ name: 'tower', version: VERSION }, { ...http, inputRequired: { autoFulfill: false }, listChanged }));
    this.stdio = url ? null : new StdioClientTransport({ command: command!, args, env, cwd, stderr: 'pipe', maxBufferSize: LIMITS.maxBytes });
    this.stdio?.stderr?.on('data', (chunk: Buffer) => (this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-LIMITS.ringBytes)));
    // The only signal of a dead SSE stream, or of a message over maxBufferSize. No request settles on its own after either.
    client.onerror = (err) => void (client === this.client && /^(SSE stream disconnected|ReadBuffer exceeded)/.test(err.message) && this.down(err));
    try {
      const transport = this.stdio ?? new StreamableHTTPClientTransport(new URL(url!), { requestInit: { headers }, fetch: limited });
      // The SDK's timeout covers requests only, and the notification that ends the handshake is not one.
      await Promise.race([client.connect(transport, { timeout: LIMITS.startMs }), sleep(LIMITS.startMs).then(() => Promise.reject(new Error('start timed out')))]);
      if (client !== this.client) return void (await client.close()); // Replaced while it connected. Closing it then may not have reached the probe.
      client.onclose = () => this.client === client && this.down(new Error('child exited'));
      this.at = performance.now();
      this.state = 'ready';
      event('upstream_state', this.cfg.name, { state: this.state });
      await this.refresh();
    } catch (err) {
      if (client === this.client) this.down(err);
    }
  }

  private detach() {
    const client = this.client;
    this.client = null;
    clearTimeout(this.retryTimer);
    return client?.close().catch(() => {});
  }

  private down(err: unknown) {
    void this.detach();
    this.lastError = describe(err);
    const delay = Math.min(30_000, 250 * 2 ** this.failures);
    this.failed = this.failures + 1;
    this.at = performance.now() + delay;
    this.state = 'backoff';
    event('upstream_state', this.cfg.name, { state: this.state, delay, error: this.lastError });
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  // Only this leaves ready: anything else is an answer tower cannot use. A hung child stays, a dead one whose helper holds stdout open shows only here.
  private lost = (err: unknown) => closed(err) || (!!this.stdio?.pid && !existsSync(`/proc/${this.stdio.pid}`));

  // Waits out a connect in progress or a retry due soon. A retry that cannot be up inside the limit fails now.
  private async ready() {
    const end = performance.now() + (this.state === 'backoff' ? LIMITS.retryWaitMs : LIMITS.connectWaitMs);
    while (this.state !== 'ready' && performance.now() < end && !(this.state === 'backoff' && this.at + LIMITS.slackMs > end)) await sleep(20);
    if (this.state !== 'ready' || !this.client) throw new Error(`is down${this.lastError ? `: ${this.lastError}` : ''}`);
    return this.client;
  }

  async use<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.ready();
    try {
      return await fn(client);
    } catch (err) {
      if (this.client === client && this.lost(err)) this.down(err);
      if (!(err instanceof SdkHttpError && err.status === 404)) throw err;
      return fn(await this.ready()); // A restarted session-based upstream did not run the request, so one retry is safe.
    }
  }

  // Serial: a change that arrives during a refresh gets its own refresh after it.
  private refresh = () => (this.refreshes = this.refreshes.then(() => this.fetchLists()));

  private async fetchLists() {
    const client = this.client;
    if (!client || this.state !== 'ready') return;
    const caps = client.getServerCapabilities();
    const options = { timeout: LIMITS.listMs, cacheMode: 'refresh' as const };
    const failed: [string, unknown][] = [];
    // Each list stands alone: one that fails keeps its last good copy. Method not found is a server without that list, which is no failure.
    const keep = <T>(key: string, list: Promise<T>) => list.catch((err: unknown) => {
      if (!(err instanceof ProtocolError && err.code === ProtocolErrorCode.MethodNotFound)) failed.push([key, err]);
      return this.lists as never;
    });
    const [{ tools }, { prompts }, { resources }, { resourceTemplates }] = await Promise.all([
      caps?.tools ? keep('tools', client.listTools(undefined, options)) : { tools: [] },
      caps?.prompts ? keep('prompts', client.listPrompts(undefined, options)) : { prompts: [] },
      caps?.resources ? keep('resources', client.listResources(undefined, options)) : { resources: [] },
      caps?.resources ? keep('resourceTemplates', client.listResourceTemplates(undefined, options)) : { resourceTemplates: [] },
    ]);
    const hashes = new Map(tools.map((t) => [t.name, sha256(JSON.stringify([t.description, t.inputSchema, t.annotations]))]));
    const changed = [...new Set([...hashes.keys(), ...(this.toolHashes?.keys() ?? [])])].filter((name) => hashes.get(name) !== this.toolHashes?.get(name));
    if (this.toolHashes && changed.length) event('tools_changed', this.cfg.name, { names: changed });
    this.toolsChangedAt = this.toolHashes && changed.length ? new Date().toISOString() : this.toolsChangedAt;
    if (tools !== this.lists.tools) this.toolHashes = hashes; // A failed list hands back the last good one, which is no first snapshot.
    this.lists = { tools, prompts, resources, resourceTemplates };
    this.lastError = failed.map(([key, err]) => `${key}: ${describe(err)}`).join('; ') || undefined;
    for (const [, err] of failed) if (client === this.client && this.lost(err)) this.down(err);
    Upstream.onLists();
    clearTimeout(this.refreshTimer);
    const next = this.toolHashes ? this.cfg.refreshIntervalMs : LIMITS.listMs; // Until a first list arrives, retry soon whatever the interval says.
    if (this.client && next > 0) this.refreshTimer = setTimeout(() => void this.refresh(), next);
  }

  // A connection change, or `tower restart`: same name, new connection, calls in flight end as errors. Anything else swaps in place.
  async apply(cfg: UpstreamConfig, force = false) {
    const reconnect = force || cfg.fingerprint !== this.cfg.fingerprint;
    this.cfg = cfg;
    if (!reconnect) return this.refresh();
    this.failed = 0;
    void this.detach();
    return this.connect();
  }

  close = () => this.detach();
}
