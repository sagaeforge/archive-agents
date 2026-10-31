import { useMemo, useState } from 'react';
import type { Claim, Predicate, SchemaCatalog } from '../client/model/index.ts';
import { TimeMark } from '../components/bits.tsx';
import { ClaimCard } from './ClaimCard.tsx';
import { foldRows, groupClaims, type ClaimGroup, type ClaimRow } from './claimState.ts';

type Ctx = { pageId: string; predicates: Map<string, Predicate>; enums: SchemaCatalog['enums'] | undefined };

function Row({ row, ctx }: { row: ClaimRow; ctx: Ctx }) {
  const card = (c: Claim) => <ClaimCard key={c.id} claim={c} pageId={ctx.pageId} predicate={c.predicate ? ctx.predicates.get(c.predicate) : undefined} enums={ctx.enums} />;
  if (row.kind === 'single') return card(row.claim);
  // No winner: a conflict_group has none (design 5). The caption says so.
  return (
    <div className="conflict" data-testid="conflict-group" data-group={row.group}>
      <p className="conflict-note">출처마다 다른 주장이다. 어느 쪽이 맞는지 정하지 않는다.</p>
      <div className="conflict-cards">{row.claims.map(card)}</div>
    </div>
  );
}

function Group({ group, ctx }: { group: ClaimGroup; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const { shown, hidden, hiddenClaims } = foldRows(group.rows);
  return (
    <section className="claim-group" data-testid="claim-group" data-predicate={group.predicate ?? ''}>
      <header className="claim-group-head">
        <h3 dir="auto">{group.label}</h3>
        {group.claimCount > 1 && <span className="tabular-nums">{group.claimCount}</span>}
        <TimeMark className="ml-auto" />
      </header>
      {shown.map((r, i) => <Row key={r.kind === 'single' ? r.claim.id : r.group ?? i} row={r} ctx={ctx} />)}
      {open && hidden.map((r, i) => <Row key={r.kind === 'single' ? r.claim.id : r.group ?? i} row={r} ctx={ctx} />)}
      {!open && hiddenClaims > 0 && <button type="button" className="text-action mt-1" onClick={() => setOpen(true)} data-testid="fold-more">{hiddenClaims}개 더</button>}
    </section>
  );
}

export function ClaimGroups({ claims, pageId, schema }: { claims: readonly Claim[]; pageId: string; schema: SchemaCatalog | undefined }) {
  const predicates = useMemo(() => schema?.predicates ?? [], [schema]);
  const groups = useMemo(() => groupClaims(claims, predicates), [claims, predicates]);
  const ctx: Ctx = useMemo(() => ({ pageId, predicates: new Map(predicates.map((p) => [p.id, p])), enums: schema?.enums }), [pageId, predicates, schema]);
  return <>{groups.map((g) => <Group key={g.key} group={g} ctx={ctx} />)}</>;
}
