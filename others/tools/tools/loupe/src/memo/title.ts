// The title of a memo (design v2 2.5): the first line, without its Markdown head mark, cut at 60 graphemes with an ellipsis. A first line with
// nothing in it gets the time (KST). The KB takes a title of 1 to 300 characters (ADR-0005 4.2).
const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const MAX_GRAPHEMES = 60;
const MAX_CODE_POINTS = 300;

/** The serializer escapes punctuation; a title is shown as the person typed it. */
const unescapeMarkdown = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>$&:])/g, '$1');

function stamp(now: Date, label: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return `${label} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** `label` is the name a title without a first line carries: `메모` for a memo, `문서` for a document (design v2 M2: a `Page` is saved by the same path). */
export function titleOf(markdown: string, now: Date, label = '메모'): string {
  const first = markdown.split(/\r?\n/, 1)[0] ?? '';
  const text = unescapeMarkdown(first.trim().replace(/^(?:#{1,6}|[-*+]|>)\s*/, '').replace(/^(?:[-*+>]\s*)+/, '')).trim();
  if (!text) return stamp(now, label);
  const parts = [...segmenter.segment(text)].map((s) => s.segment);
  if (parts.length <= MAX_GRAPHEMES && [...text].length <= MAX_CODE_POINTS) return text;
  let kept = parts.slice(0, MAX_GRAPHEMES);
  while ([...kept.join('')].length + 1 > MAX_CODE_POINTS) kept = kept.slice(0, -1);
  return `${kept.join('')}…`;
}
