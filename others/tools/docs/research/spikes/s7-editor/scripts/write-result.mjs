import { readFile, writeFile } from 'node:fs/promises';

const changeReasons = {
  'setext-headings': 'Setext 제목을 ATX(# / ##) 제목으로 출력한다.',
  'emphasis-edges': '단어 안의 밑줄을 \\_로 이스케이프한다. 텍스트와 강조 범위는 같다.',
  links: '자동 링크 <https://…>를 [https://…](https://…)로 출력한다. href와 제목은 같다.',
  'tilde-code-fence': '바깥 물결 펜스 4개를 최소 안전 길이 3개로 줄인다. 내부 백틱 3개와 코드 내용은 그대로다.',
  'indented-code': '들여쓴 코드를 백틱 펜스 코드로 출력한다. 언어·내용은 같다.',
  'inline-code-edges': 'CommonMark가 제거하는 인라인 코드 양끝 패딩 공백을 생략한다. 코드 값은 같다.',
  'escaped-html': '백슬래시로 보호한 < 문자를 &lt; 엔터티로 출력한다. HTML 노드는 생기지 않는다.',
  'entities-and-escapes': '문단 중간의 불필요한 \\#를 #로 출력한다. &copy;, 숫자 엔터티와 나머지 이스케이프는 보존한다.',
};

export async function writeResult(results) {
  const editors = ['milkdown', 'tiptap'];
  const retained = results.metadata.imeRetainedFrom;
  const row = name => {
    const { ime, roundtrip: rt, bundle } = results[name];
    return `| ${name} | ${ime.pass} / ${ime.fail} / ${ime.notRun} | ${ime.cdpSimulatedPass ?? '-'} / ${ime.cdpSimulatedFail ?? '-'} | ${rt.identical} / ${rt.normalizedOnly} / ${rt.failed} | ${rt.structureChanged} | ${bundle.total.rawBytes.toLocaleString('en-US')} / ${bundle.total.gzipBytes.toLocaleString('en-US')} |`;
  };
  const rt = results.tiptap.roundtrip;
  const original = rt.originalCorpus;
  const passed = rt.failed <= 8 && rt.structureChanged === 0
    && rt.samples.filter(s => s.wikiTokensPreservedVerbatim !== null).every(s => s.identical && s.wikiTokensPreservedVerbatim)
    && ['tilde-code-fence', ...['backtick', 'tilde'].flatMap(kind => [3, 4, 5].map(n => `${kind}-run-${n}`))].every(id => rt.samples.some(s => s.id === id && s.codeBlocks.preserved));
  const changed = rt.samples.filter(s => s.classification === 'failed');
  const normalized = rt.samples.filter(s => s.classification === 'normalized-only').map(s => `\`${s.id}\``).join(', ');
  const section = `## RESULT — Tiptap Markdown 보존 (${results.metadata.generatedAt.slice(0, 10)})

**소유자는 loupe v2 편집기로 Tiptap을 선택했다. M0a 1–3번은 ${passed ? '통과했다' : '미통과다'}.** 기존 36개에서 바이트 일치 / 개행 정규화 / 그 외 변경은 **${original.identical} / ${original.normalizedOnly} / ${original.failed}**(수정 전 5 / 14 / 17), 재파싱 구조 변경은 **${rt.structureChanged}건**이다. 내부 백틱·물결 연속 3·4·5개와 공개 ID·강조·코드/링크 문맥 위키 링크 ${rt.total - original.total}개 표본을 추가한 전체 ${rt.total}개 결과는 다음과 같다.

| 편집기 | 기존 IME genuine 통과 / 실패 / 미실행 | 기존 IME cdpSimulated 통과 / 실패 | 왕복 바이트 일치 / 개행 정규화 / 그 외 변경 | 구조 변경 | 전체 번들 raw / gzip (bytes) |
|---|---:|---:|---:|---:|---:|
${editors.map(row).join('\n')}

${retained ? `이번 실행은 **브라우저 없는 모델 왕복·번들 재측정**이다. IME 데이터는 ${retained.generatedAt}(Chromium ${retained.browser})의 기존 객체를 그대로 보존했고 재측정하지 않았다.` : 'IME와 왕복의 실행 경로는 results.json의 metadata.browserExecution 및 roundtrip.browserVerified에 기록했다.'} 기존 genuine 0/13과 cdpSimulated 13/0은 실제 Windows 한국어 IME 통과를 뜻하지 않는다. CDP Input.insertText의 compositionend는 untrusted이며, 기존 genuine 판정을 바꾸지 않았다.

### 구현과 읽기 경로 대조

- 설치된 Tiptap 3.32.0의 MarkdownManager·CodeBlock·목록·Link·HardBreak 확장과 marked 소스를 확인해 확장 훅으로 고쳤다(2026-11-04). 패키지 설치나 네트워크 사용은 없다. 구현은 \`src/tiptap-markdown.js\`, 공통 설정은 \`src/tiptap-extensions.js\`다. 원문 전체를 캐시해 반환하거나 저장 문자열을 사후 치환하지 않는다.
- 펜스는 입력의 백틱/물결 종류를 기억하고, 코드 안 같은 문자의 최대 연속 길이 + 1(최소 3)로 출력한다. 들여쓴 코드는 백틱으로 출력한다. \`backtick-run-3/4/5\`, \`tilde-run-3/4/5\`, 기존 \`tilde-code-fence\` 모두 코드 블록의 lang/meta/value와 전체 remark AST가 일치한다.
- \`wikiLink\`는 인라인 원자 노드다. \`[[id]]\` 및 기존 \`[[id|표시 이름]]\`의 원문을 저장·출력하며 DOM에는 안전한 span 텍스트만 넣는다. 라벨 조회·검색 UI는 이 스파이크 범위 밖이다. \`wiki-links\`, \`wiki-public-ids\`, 300회 반복의 \`long-line\`, 강조 안의 \`wiki-formatted\`, 코드·외부 링크 문맥의 \`wiki-contexts\` 전체가 바이트 일치이고 \\[[가 없다.
- 실제 읽기 변환 위치는 \`tools/loupe/src/render/pipeline.ts:50\`(정규식), \`:54\`(\`linkNodeRefs\`), \`:59–61\`(ID 검사), ID 규칙은 \`tools/loupe/src/ids.ts:13–19\`이다. **remark 플러그인이 아니라 remark→rehype→sanitize 뒤 HAST 변환**이다. \`scripts/markdown-diagnostics.mjs\`가 이 모듈을 읽기 전용 import하여 각 표본의 입력/출력에서 실제 ID 목록을 얻고 편집기 노드 목록과 비교한다. 순서와 중복도 비교하며 코드는 추출하지 않는다.
- 기존 \`wiki-links\`의 읽기 ID는 \`["id", "문서-123"]\`다. 공백이 있는 별칭 \`[[id|표시 이름]]\`은 reader도 ID로 읽지 않는다. 스파이크는 기존 별칭을 손상 없이 보존하며 새 별칭 쓰기를 KB 계약으로 인정하지 않는다(설계 4.4). \`wiki-public-ids\`는 \`["e:product:claude-code", "c-123", "문서-123"]\`를 얻는다.
- 강조·링크가 원자 노드 앞뒤에서 끊기지 않도록 직렬화용 임시 JSON에서만 소스 표기를 투명 텍스트로 펼친다. 편집기 문서는 바꾸지 않는다. 혼합 목록을 한 목록으로 유지하고 loose 목록의 빈 줄을 보존한다. 참조 링크 문법·정의, HTML 모양 문자열과 엔터티는 각 노드의 원문 속성으로 보존한다. raw HTML 토큰은 브라우저 DOM 파싱 전에 문자 노드로 보내며 실제 HTML로 해석하지 않는다. 링크의 Markdown 파싱과 DOM href는 http/https만 허용한다. 기존 표·이미지 오프라인 어댑터는 그대로다. 이미지/첨부 정책·붙여넣기 악성 입력·Trusted Types·실제 브라우저 DOM 안전 검증은 완료 주장에 포함하지 않는다.

### 남은 변경 — 표본별

분류 기준을 바꾸지 않았다. **CRLF/CR→LF 후 마지막 LF 하나 제거**만 정규화한다. 그 외 바이트 변화는 의미가 같아도 failed다. 기존 \`astEqualDiagnosticOnly\` 비교도 위치만 제거한 remark-parse + remark-gfm 전체 AST의 엄격 일치 그대로이며, 참조 정의·텍스트·공백·코드 내용 등을 제거하지 않는다. 새 \`structureChanged\`는 이 비교가 false인 개수다.

| 표본 | 남은 바이트 차이(전부 AST 일치) |
|---|---|
${changed.map(s => `| \`${s.id}\` | ${changeReasons[s.id] ?? 'results.json의 정확 diff 참조'} |`).join('\n')}

개행 정규화만 필요한 표본(${rt.normalizedOnly}개): ${normalized}. \`crlf\`는 CRLF→LF 및 마지막 LF 제거이고, 나머지는 마지막 LF 하나 제거다. 바이트 일치 표본은 다른 변경이 없다. 전체 입력/출력·UTF-8 크기·SHA-256·정확 교체 hunk는 \`results.json\`에 남겼다.

### 측정·검증과 범위

- Node 모델 경로는 앱과 같은 Tiptap 확장 및 같은 독립 marked 설정을 사용한다. MarkdownManager.parse → schema.nodeFromJSON → doc.check → MarkdownManager.serialize를 실행한다. 원자 노드의 화면·선택·IME는 확인하지 않았다. \`roundtrip.browserVerified=false\`는 기존 IME 기록과 구분한다.
- Milkdown 코드·패키지·IME 결과는 수정하지 않았다. 측정만 같은 확장 코퍼스에 다시 수행했다. 기존 Tiptap 36개는 순서·내용을 그대로 두고 ${rt.total - original.total}개만 뒤에 추가했다. \`originalCorpus\`에 원래 36개의 분류도 따로 남겼다.
- 번들은 Vite ${results.metadata.versions.vite} 프로덕션 독립 빌드, 최소화, 소스맵 없음이다. 동일 React UI·측정 API·CSS·HTML을 포함한다. gzip은 Node zlib.gzipSync(level 9)로 파일별 압축 후 합산했다. 공식 Tiptap table/image 확장이 없어 기존 \`src/tiptap-gfm.js\` 어댑터를 사용한다. 공식 표 UI나 loupe 통합 편집 청크 크기의 측정이 아니다.
- \`verify.mjs\`는 기존 코퍼스/바이트/정규화/diff/번들 해시/압축 크기/IME 검사를 유지하고 분류·실제 remark AST·코드 블록·Tiptap 실시간 왕복·읽기 ID 대조·펜스 길이·failed≤8을 추가로 검증한다. 저장된 결과만 자체 일관성 검사하는 데서 실제 직렬화기 실행까지 강화했다.
- 이번에는 Chromium을 실행하지 않았다. 보존된 13개 IME 사례는 한글 음절별 입력, 문단 처음/중간/끝, 목록/제목/표/링크, 조합 중 Enter/Ctrl+Enter/Backspace, undo, 블록 이동이다. 실제 Windows 11 Microsoft 한국어 IME와 Chrome/Edge에서 물리키로 최종 문자·커서·중복/누락·명령 오작동을 확인해야 한다. 후보 창·재변환·포커스 복귀·TSF와 OS 키 순서는 CDP가 증명하지 못한다.
- 외부 쓰기·설치·커밋은 없다. Codex 워커는 tower KB 도구에 접근할 수 없어 KB 저장은 하지 못했다. KB에 남길 결정: 읽기 위키 변환은 HAST 단계이며 별칭의 공백 때문에 ID 추출에서 제외된다. strict AST 비교와 원래 바이트 분류를 별개로 유지해야 한다.

### 재실행

브라우저 없는 재측정은 기존 IME 객체를 그대로 보존한다. 아래 종료 코드 0은 모델 왕복/번들/검증 성공이며 새 IME 근거가 아니다.

\`\`\`sh
cd /home/user/sagae-tools/docs/research/spikes/s7-editor
node scripts/measure.mjs --model-only
node scripts/verify.mjs
\`\`\`

Chromium을 실행할 수 있는 소유자 환경에서만 \`node scripts/measure.mjs\`로 브라우저·CDP를 재측정한다. Chromium 기동 실패 시 모델/번들을 기록하고 종료 코드 2를 돌려준다.
`;
  const readme = await readFile('README.md', 'utf8');
  await writeFile('README.md', readme.split('\n## RESULT')[0].trimEnd().replace('스파이크 코드는 이 폴더에 없다.', '구현·측정 코드는 src/와 scripts/에 있다.') + '\n\n' + section);
}
