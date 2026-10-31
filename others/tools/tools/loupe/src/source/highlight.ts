// The quote is painted with the CSS Custom Highlight API: no DOM change, so React and the highlight cannot fight (design 5).
import { cpIndex } from '../quote/codepoints.ts';

export const HIGHLIGHT_NAME = 'loupe-quote';

export type LoadedText = { text: string; start: number; end: number };
export type QuoteRange = { start: number; end: number };

export const rangeIsLoaded = (v: LoadedText, r: QuoteRange) => r.start >= v.start && r.end <= v.end;

/** The DOM range of a code point range. Offsets are absolute, so the window start comes off first. */
export function domRange(textNode: Text, view: LoadedText, r: QuoteRange): Range {
  const ix = cpIndex(view.text);
  const dom = new Range();
  dom.setStart(textNode, ix.toUtf16(r.start - view.start));
  dom.setEnd(textNode, ix.toUtf16(r.end - view.start));
  return dom;
}
export const paint = (r: Range) => { if (typeof Highlight !== 'undefined' && CSS.highlights) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(r)); };
export const clearPaint = () => { if (typeof Highlight !== 'undefined' && CSS.highlights) CSS.highlights.delete(HIGHLIGHT_NAME); };
