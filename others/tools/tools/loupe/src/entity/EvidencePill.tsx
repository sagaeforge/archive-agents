// One numbered pill per evidence (design 5). Hover shows the quote and starts the lazy check, click goes to the quote in the source.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Claim, Evidence } from '../client/model/index.ts';
import { useVerdict } from '../data/hooks.ts';
import { VERDICT_LABEL } from '../quote/verify.ts';

export function EvidencePill({ claim, evidence, n }: { claim: Claim; evidence: Evidence; n: number }) {
  const [opened, setOpened] = useState(false);
  const verdict = useVerdict(evidence, opened);
  const v = verdict.data;
  return (
    <span className="pill-wrap">
      <Tooltip onOpenChange={(o) => { if (o) setOpened(true); }}>
        <TooltipTrigger
          render={<Link to="/source/$id" params={{ id: evidence.snapshot_id }} search={{ claim: claim.id, ev: evidence.id }} className="pill" data-verdict={v?.kind} data-testid="evidence-pill" data-ev={evidence.id} aria-label={`근거 ${n}: 원문으로 이동`} />}
        >
          {n}
        </TooltipTrigger>
        <TooltipContent className="quote-tip" data-testid="pill-tip">
          <span className="block">
            {evidence.selector_kind === 'jsonpointer'
              ? <code className="break-all">{evidence.json_pointer}</code>
              : <q className="block max-h-40 overflow-hidden" dir="auto">{evidence.exact ?? '인용 없음'}</q>}
            <span className="mt-1 block opacity-70" data-testid="pill-verdict">{verdict.isFetching ? '확인하는 중' : v ? VERDICT_LABEL[v.kind] : verdict.isError ? '확인하지 못했다' : ''}</span>
          </span>
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

/** The result of the viewer's quote check, in the card's meta line. It is not next to the pill: the pill must never move under the pointer. */
export function EvidenceVerdict({ evidence, n, many }: { evidence: Evidence; n: number; many: boolean }) {
  const v = useVerdict(evidence, false).data;
  if (!v) return null;
  return <span className="verdict" data-kind={v.kind} data-n={many ? n : undefined} title={`근거 ${n}`} data-testid="verdict">{VERDICT_LABEL[v.kind]}</span>;
}
