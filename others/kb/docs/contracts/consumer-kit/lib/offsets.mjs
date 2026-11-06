// 인용 위치 변환. 계약 2.11: 서버의 start/end는 코드포인트 오프셋이다. JS 문자열은 UTF-16 코드 유닛으로 센다.
// 코드포인트 오프셋으로 String.prototype.slice를 부르면 이모지(서로게이트 쌍) 뒤에서 어긋난다.

/** 코드포인트 오프셋 cp를 UTF-16 오프셋으로 바꾼다. cp가 문자열 길이를 넘으면 RangeError. */
export function cpToUtf16(text, cp) {
  if (!Number.isInteger(cp) || cp < 0) throw new RangeError(`코드포인트 오프셋 오류: ${cp}`);
  let u = 0;
  let n = 0;
  while (n < cp) {
    if (u >= text.length) throw new RangeError(`오프셋 ${cp}가 본문(${n} 코드포인트)을 넘는다`);
    const c = text.codePointAt(u);
    u += c > 0xffff ? 2 : 1;
    n += 1;
  }
  return u;
}

/** [start, end) 코드포인트 구간을 잘라낸다. */
export function sliceByCodepoints(text, start, end) {
  const a = cpToUtf16(text, start);
  const b = a + cpToUtf16(text.slice(a), end - start);
  return text.slice(a, b);
}

/** 문자열의 코드포인트 수. */
export function codepointLength(text) {
  let n = 0;
  for (const _ of text) n += 1; // eslint-disable-line no-unused-vars
  return n;
}
