// The basic unit of an entity page (design 5). The body is `statement`. The rest is what lets you judge it.
import { useState, type ReactNode } from 'react';
import type { Claim, Predicate, SchemaCatalog } from '../client/model/index.ts';
import { Chip, Instant } from '../components/bits.tsx';
import { fallbackLabel, NodeLink } from '../components/NodeLink.tsx';
import { useClaimHistory, useNodeBrief } from '../data/hooks.ts';
import { classifyId } from '../ids.ts';
import { formatValid } from '../time/format.ts';
import { useTimeBasis, useTimeNavigate } from '../time/useTimeBasis.ts';
import { claimState, isUnverified, SUPERSEDE_LABEL, verificationLabel, SUPERSEDE_NEUTRAL, supersedeOutcome, type ClaimStateKind } from './claimState.ts';
import { EvidencePill, EvidenceVerdict } from './EvidencePill.tsx';
import { valueLabel } from './labels.ts';

// Labels for the open sets in a claim's meta line. A value the catalog adds later shows as it is (C 2.10).
const KIND_LABEL: Record<string, string> = { event: '사건', state: '상태', howto: '방법' };
const METHOD_LABEL: Record<string, string> = { deterministic: '규칙 추출', llm: 'LLM 추출', human: '사람 기록' };

const STATE_CHIP: Partial<Record<ClaimStateKind, ReactNode>> = {
  ended: <Chip data-testid="state-chip">유효 종료</Chip>,
  scheduled: <Chip tone="info" data-testid="state-chip">발효 예정</Chip>,
  dead: <Chip data-testid="state-chip">죽은 데이터</Chip>,
};

/** origin, sensitivity and status at the first catalog value are the common case and stay out of the way. Anything else is a chip. */
export function quietChips(c: Pick<Claim, 'origin' | 'sensitivity' | 'liveness'>, enums: SchemaCatalog['enums'] | undefined): string[] {
  const e = enums as Record<string, string[] | undefined> | undefined;
  const out: string[] = [];
  if (c.origin && c.origin !== e?.origin?.[0]) out.push(c.origin);
  if (c.sensitivity && c.sensitivity !== e?.sensitivity?.[0]) out.push(c.sensitivity);
  if (c.liveness && c.liveness !== 'active') out.push(c.liveness);
  return out;
}

export function ClaimValue({ claim, predicate }: { claim: Claim; predicate: Predicate | undefined }) {
  const q = Object.entries(claim.qualifiers ?? {});
  if (claim.value == null && !claim.object && q.length === 0) return null;
  const kind = predicate?.value_kind;
  return (
    <p className="claim-value">
      {claim.value != null && (
        // value is always a string (C 3). value_kind picks the look; an unknown kind shows the value as it is.
        <span data-kind={kind} className={kind === 'version' ? 'font-mono' : kind === 'number' ? 'tabular-nums' : undefined} data-testid="claim-value">{claim.value}</span>
      )}
      {claim.unit && <span className="text-faint"> {claim.unit}</span>}
      {claim.object && (classifyId(claim.object) === 'entity' ? <NodeLink id={claim.object}>{fallbackLabel(claim.object)}</NodeLink> : <span>{claim.object}</span>)}
      {q.map(([k, v]) => <span key={k} className="text-faint">{k}: {String(v)}</span>)}
    </p>
  );
}

/** The chip and the one action of a card that is no longer current. Neutral until the history is read, then exactly one outcome. */
function SupersedeState({ claim }: { claim: Claim }) {
  const [open, setOpen] = useState(false);
  const h = useClaimHistory(claim.id, open);
  // The subject is read only to tell a withdrawal from a status inherited from a superseded subject.
  const subject = useNodeBrief(open && !claim.status_basis ? claim.subject : undefined);
  const items = h.data?.data.chains.flatMap((c) => c.items ?? []).filter((i) => i.id === claim.id) ?? [];
  const next = items.map((i) => i.superseded_by).find(Boolean);
  const read = open && h.isSuccess;
  const outcome = read ? supersedeOutcome({ successor: next, mergedInto: claim.merged_into_final || claim.merged_into, subjectStatus: subject.data?.status, statusBasis: claim.status_basis }) : null;
  const waiting = read && outcome === 'unknown' && subject.isPending;
  // The inherited case needs no history to be known: the claim says so itself.
  if (claim.status_basis === 'subject') return <Chip data-testid="state-chip" data-outcome="by-subject">{SUPERSEDE_LABEL['by-subject']}</Chip>;
  const label = outcome && !waiting ? SUPERSEDE_LABEL[outcome] : SUPERSEDE_NEUTRAL;
  return (
    <>
      <Chip data-testid="state-chip" data-outcome={waiting ? undefined : outcome ?? undefined}>{label}</Chip>
      {!open && <button type="button" className="text-action" onClick={() => setOpen(true)} data-testid="find-successor">후속 주장 찾기</button>}
      {open && h.isPending && <span className="text-xs text-faint">찾는 중</span>}
      {open && h.isError && <span className="text-xs text-danger">이력을 읽지 못했다</span>}
      {outcome === 'replaced' && next && <NodeLink id={next} testid="successor" className="link text-xs">후속 주장으로</NodeLink>}
    </>
  );
}

export function ClaimCard({ claim, pageId, predicate, enums, firstObserved }: {
  claim: Claim; pageId?: string; predicate: Predicate | undefined; enums: SchemaCatalog['enums'] | undefined;
  /** The earliest version's time, known where the versions are (the claim page). A superseded row's own time is the time it was replaced. */
  firstObserved?: string;
}) {
  const t = useTimeBasis();
  const go = useTimeNavigate();
  const state = claimState(claim, t.valid ? Date.parse(t.valid) : Date.now());
  const unverified = isUnverified(claim);
  const lastConfirmed = claim.evidence?.map((e) => e.last_confirmed_at).filter((x): x is string => !!x).sort().at(-1);
  const valid = formatValid(claim.valid);
  const kbSays = verificationLabel(claim.verification);
  const chips = quietChips(claim, enums);
  const superseded = state === 'superseded';
  // The button targets when the claim was first believed. For a superseded row only the versions can say; without them it is not offered.
  const observedAt = superseded ? firstObserved : claim.recorded_at;
  return (
    <article className="claim" data-state={state} data-testid="claim-card" data-claim={claim.id} data-unverified={unverified || undefined}>
      {claim.stance === 'attributed' && <p className="claim-speaker" data-testid="speaker">{claim.speaker ? <><bdi>{claim.speaker}</bdi>의 말</> : '귀속 주장'}</p>}
      <p className="claim-statement" dir="auto">
        {claim.statement}
        {claim.evidence && claim.evidence.length > 0 && <span className="pills">{claim.evidence.map((e, i) => <EvidencePill key={e.id} claim={claim} evidence={e} n={i + 1} />)}</span>}
      </p>
      <ClaimValue claim={claim} predicate={predicate} />
      <div className="claim-meta">
        {valid && <span data-emphasis={state === 'ended' || undefined} data-testid="claim-valid">유효 {valid}</span>}
        {observedAt && <span data-testid="claim-observed">관측 <Instant iso={observedAt} /></span>}
        {superseded && (!observedAt || observedAt !== claim.recorded_at) && <span data-testid="claim-replaced-at">대체 기록 <Instant iso={claim.recorded_at} /></span>}
        {lastConfirmed && <span>재확인 <Instant iso={lastConfirmed} /></span>}
        {kbSays && <span data-testid="kb-verification">{kbSays}</span>}
        {claim.evidence?.map((e, i) => <EvidenceVerdict key={e.id} evidence={e} n={i + 1} many={(claim.evidence?.length ?? 0) > 1} />)}
        <span>{KIND_LABEL[claim.kind] ?? claim.kind}</span>
        {claim.method !== 'llm' && <span>{METHOD_LABEL[claim.method] ?? claim.method}</span>}
        {(!claim.evidence || claim.evidence.length === 0) && <span>인용 없음</span>}
        {claim.evidence?.some((e) => e.evidence_state === 'archived_only') && <Chip data-testid="archived-only">옛 스냅샷에만 있음</Chip>}
        {claim.evidence?.some((e) => e.support_check === 'unsupported') && <Chip tone="warn" data-testid="unsupported">원문이 뒷받침하지 않음</Chip>}
        {STATE_CHIP[state]}
        {unverified && <Chip tone="warn" data-testid="unverified-chip">미검증</Chip>}
        {chips.map((c) => <Chip key={c}>{valueLabel(c)}</Chip>)}
        {superseded && <SupersedeState claim={claim} />}
        {pageId && claim.subject !== pageId && <span>주어 <NodeLink id={claim.subject} className="link">{fallbackLabel(claim.subject)}</NodeLink></span>}
      </div>
      <div className="claim-actions">
        {observedAt && <button type="button" className="claim-action" onClick={() => go({ as_of_observed: observedAt })} data-testid="to-observed">이 주장이 관측된 시점으로</button>}
        <NodeLink id={claim.id} className="claim-action" testid="open-claim">주장 열기</NodeLink>
      </div>
    </article>
  );
}
