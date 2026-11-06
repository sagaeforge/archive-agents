// 사용: node examples/offsets.mjs
// 이모지 뒤 인용을 코드포인트 오프셋으로 잘라 exact와 맞춘다. 순진한 slice는 어긋난다.
import { sliceByCodepoints, cpToUtf16 } from '../lib/offsets.mjs';

const text = '🎬 업로드 규칙: 🎉🎉 매주 한 편 올린다.';
const exact = '매주 한 편 올린다';
const start = 13; // 서버가 준 start (코드포인트)
const end = start + [...exact].length;

console.log('순진한 slice :', JSON.stringify(text.slice(start, end)));
console.log('변환 뒤 slice:', JSON.stringify(sliceByCodepoints(text, start, end)));
console.log('UTF-16 시작  :', cpToUtf16(text, start), '(코드포인트', start, ')');
if (sliceByCodepoints(text, start, end) !== exact) process.exit(1);
