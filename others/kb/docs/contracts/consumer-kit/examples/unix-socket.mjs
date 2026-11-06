// 사용: node examples/unix-socket.mjs [소켓경로] [경로]
// 기본 소켓은 /home/user/sagae-kb-data/run/read.sock (0600, 토큰 없음). 같은 사용자만 연결한다.
// Node 표준 http만 쓴다. bun:sqlite 같은 런타임 전용 API에 기대지 않는다.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SOCKET = '/home/user/sagae-kb-data/run/read.sock';

/** GET 한 번. 반환: { status, headers, body: Buffer }. 304는 body가 비어 있다. */
export function kbGet(socketPath, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: target, method: 'GET', headers: { host: 'localhost', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** JSON 본문을 읽는다. 오류(application/problem+json)도 객체로 돌려준다. */
export async function kbJson(socketPath, target, headers = {}) {
  const r = await kbGet(socketPath, target, headers);
  return { ...r, json: r.body.length ? JSON.parse(r.body.toString('utf8')) : null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const socket = process.argv[2] ?? DEFAULT_SOCKET;
  const target = process.argv[3] ?? '/v1/meta';
  const r = await kbJson(socket, target);
  console.log(r.status, r.headers.etag ?? '', JSON.stringify(r.json)?.slice(0, 300));
}
