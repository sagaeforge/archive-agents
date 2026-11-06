// Small pure labels for the entity screens, kept apart from React so they can be tested directly.
import type { CheckTally } from '../data/hooks.ts';

/** `domain` is an array since contract 0.3.0. Join with a separator; an empty or missing list gives nothing to show. */
export const domainText = (d: readonly string[] | null | undefined): string => (d ?? []).filter((x) => x !== '').join(' · ');

/** The tally after "인용 전체 확인": it says how many failed and how many quotes were not found, and that unread claims were skipped. */
export function checkSummary(t: CheckTally, unread: boolean): string {
  const parts: string[] = [];
  if (t.failed > 0) parts.push(`${t.total}건 중 ${t.failed}건은 읽지 못해 확인하지 못했다`);
  else parts.push(`${t.total}건 확인했다`);
  if (t.notFound > 0) parts.push(`${t.notFound}건은 인용을 찾지 못했다`);
  if (unread) parts.push('아직 읽지 않은 주장은 포함하지 않았다');
  return parts.join('. ');
}

/** Relations for the header link: what is loaded, with a plus when the page says there is more. */
export function relationCount(edges: { out?: readonly unknown[]; in?: readonly unknown[]; truncated?: boolean } | undefined): string {
  const n = (edges?.out?.length ?? 0) + (edges?.in?.length ?? 0);
  return `${n}${edges?.truncated ? '+' : ''}`;
}

// Open sets shown in Korean text. A value this table does not know is shown as the KB wrote it (C 2.10).
const VALUE_LABEL: Record<string, string> = {
  external: '외부', first_party: '직접 기록', public: '공개', internal: '내부', private: '비공개', secret: '비밀',
  primary: '1차 출처', secondary: '2차 출처', unknown: '출처 미상',
};
export const valueLabel = (v: string): string => (Object.hasOwn(VALUE_LABEL, v) ? VALUE_LABEL[v]! : v);
