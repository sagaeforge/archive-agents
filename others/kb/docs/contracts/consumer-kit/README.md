# 소비자 키트 (Node 26)

KB 계약 fixture를 소비자(sagae-tools) 쪽에서 검증하는 패키지다. 합성 fixture(`../fixtures/`)와 계약 원본(`../openapi.yaml`)을 읽는다.
복사해서 쓰고, 이 폴더와 `../fixtures/`를 같이 가져간다. 파괴 변경 절차는 계약 8장이다.

## 쓰는 법

```
cd docs/contracts/consumer-kit
npm ci            # ajv 8.20.0, yaml 2.9.1만 깔린다. package-lock.json으로 고정
node verify.mjs   # 통과하면 exit 0. 다른 위치에 복사했으면 --contract <docs/contracts 사본 폴더>
```

Node 26이 필요하다(`zlib.zstdDecompressSync`를 쓴다). `bun:sqlite` 같은 런타임 전용 API에 기대지 않는다.

## verify.mjs가 확인하는 것

1. `openapi.yaml`을 ajv(2020-12, `discriminator: true`)로 컴파일한다. 스키마 검증을 손수 만들지 않는다.
2. fixture의 모든 응답이 해당 경로와 상태 코드의 응답 스키마를 통과한다.
3. 인용 위치: 서버의 `start`, `end`는 코드포인트 오프셋이다. `lib/offsets.mjs`로 UTF-16 오프셋으로 바꿔 자르면 `exact`와 정확히 일치한다. 이모지 뒤 인용은 순진한 `slice`가 어긋나는 사례다.
4. export(zstd)를 풀고 매니페스트의 `sha256`, `bytes`, 노드와 엣지 수와 맞춘다.
5. fixture를 Unix 소켓 위의 가짜 서버로 내보내고 `examples/unix-socket.mjs`의 클라이언트로 다시 받아 저장된 응답과 같은지 본다.

## 예시

- `examples/unix-socket.mjs`: Unix 소켓(`/home/user/sagae-kb-data/run/read.sock`, 0600, 토큰 없음)으로 GET. `kbGet`, `kbJson`을 낸다. 조건부 GET은 `If-None-Match`, 부분 읽기는 `Range` 헤더로 보낸다.
- `examples/offsets.mjs`: 코드포인트 오프셋을 UTF-16으로 바꾸는 예. `node examples/offsets.mjs`.

## 알아 둘 점

- 형식(`date-time` 등) 검사는 하지 않는다(`ajv-formats`를 쓰지 않는다). 구조, 형, `required`, 열거값, discriminator를 본다.
- `/v1/snapshots/{id}/raw`의 200, 206은 원 Content-Type을 그대로 주는데 계약의 `content`에는 `application/octet-stream`만 선언돼 있다. 키트는 이를 허용하고 `참고:`로 한 줄 남긴다.
- zstd 바이트는 libzstd 판에 따라 달라질 수 있다. 해시가 어긋나면 KB 쪽 fixture를 다시 받는다.
