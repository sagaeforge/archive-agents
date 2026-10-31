// Logging reverse proxy between a real client and a gateway. Streams bodies untouched.
// usage: tap.mjs <listenPort> <targetPort> <logfile>
import { appendFileSync } from 'node:fs';
import { createServer, request } from 'node:http';

const [listen, target, log] = process.argv.slice(2);
const summarize = (body) => {
  try {
    const j = JSON.parse(body);
    return { method: j.method, id: j.id, name: j.params?.name ?? j.params?.uri, pv: j.params?.protocolVersion ?? j.params?._meta?.['io.modelcontextprotocol/protocolVersion'] };
  } catch {
    return { method: body ? 'unparsed' : undefined };
  }
};

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const t0 = Date.now();
    const rec = {
      t: t0,
      http: req.method,
      ...summarize(body.toString()),
      hdrPv: req.headers['mcp-protocol-version'],
      hdrMethod: req.headers['mcp-method'],
      hdrName: req.headers['mcp-name'],
      session: req.headers['mcp-session-id'] ? req.headers['mcp-session-id'].slice(0, 8) : undefined,
      ua: req.headers['user-agent']?.slice(0, 40),
    };
    appendFileSync(log, `${JSON.stringify({ ...rec, started: true })}\n`);
    const up = request(
      { host: '127.0.0.1', port: Number(target), method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${target}` } },
      (r) => {
        rec.status = r.statusCode;
        rec.ct = r.headers['content-type']?.slice(0, 24);
        rec.respSession = r.headers['mcp-session-id'] ? r.headers['mcp-session-id'].slice(0, 8) : undefined;
        res.writeHead(r.statusCode, r.headers);
        const parts = [];
        r.on('data', (c) => {
          res.write(c);
          if (parts.length < 64) parts.push(c);
        });
        r.on('end', () => {
          res.end();
          rec.ms = Date.now() - t0;
          const text = Buffer.concat(parts).toString();
          const m = /"protocolVersion":"([^"]+)"/.exec(text);
          if (m) rec.negotiated = m[1];
          const e = /"error":\{"code":(-?\d+),"message":"([^"]{0,80})/.exec(text);
          if (e) rec.err = `${e[1]} ${e[2]}`;
          const sv = /"supportedVersions":(\[[^\]]*\])/.exec(text);
          if (sv) rec.supported = sv[1];
          appendFileSync(log, `${JSON.stringify(rec)}\n`);
        });
      },
    );
    up.on('error', (e) => {
      rec.status = 0;
      rec.err = e.code;
      appendFileSync(log, `${JSON.stringify(rec)}\n`);
      res.writeHead(502);
      res.end();
    });
    req.on('close', () => { if (!res.writableEnded && res.destroyed) up.destroy(); });
    up.end(body);
  });
}).listen(Number(listen), '127.0.0.1');
