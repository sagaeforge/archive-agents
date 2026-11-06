// Type, relation and domain filters. The KB does the filtering: this only writes the URL (design 5, the client never filters again).
import type { FacetValue, SchemaCatalog } from '../client/model/index.ts';

const parse = (v: string | undefined) => (v ? v.split(',') : null);

/** Unchecks from "all defaults" and goes back to no parameter when everything is on again, so the default URL stays the default call. */
export function toggleInList(current: string | undefined, all: readonly string[], value: string): string | undefined {
  const on = new Set(parse(current) ?? all);
  if (on.has(value)) on.delete(value); else on.add(value);
  const next = all.filter((v) => on.has(v));
  return next.length === all.length || next.length === 0 ? undefined : next.join(',');
}

function Checks({ legend, name, values, current, onChange }: {
  legend: string; name: string; values: readonly { value: string; count?: number }[]; current: string | undefined; onChange: (next: string | undefined) => void;
}) {
  const on = parse(current);
  const all = values.map((v) => v.value);
  return (
    <fieldset className="graph-filter" data-testid={`graph-filter-${name}`}>
      <legend>{legend}</legend>
      {values.map(({ value, count }) => (
        <label key={value}>
          <input type="checkbox" data-testid={`graph-${name}-${value}`} checked={on ? on.includes(value) : true} onChange={() => { onChange(toggleInList(current, all, value)); }} />
          <span className="min-w-0 truncate" dir="auto">{value}</span>
          {count !== undefined && <span className="graph-filter-count">{count.toLocaleString('ko-KR')}</span>}
        </label>
      ))}
    </fieldset>
  );
}

export function FilterPanel({ schema, typeFacets, domainFacets, types, rtypes, domain, superseded, onTypes, onRtypes, onDomain, onSuperseded }: {
  schema: SchemaCatalog | undefined; typeFacets: readonly FacetValue[]; domainFacets: readonly FacetValue[];
  types: string | undefined; rtypes: string | undefined; domain: string | undefined; superseded: boolean;
  onTypes: (v: string | undefined) => void; onRtypes: (v: string | undefined) => void; onDomain: (v: string | undefined) => void; onSuperseded: (on: boolean) => void;
}) {
  const edgeTypes = (schema?.edge_types ?? []).map((t) => ({ value: t.name }));
  return (
    <aside className="graph-filters" data-testid="graph-filters" aria-label="그래프 필터">
      <Checks legend="타입" name="type" values={typeFacets} current={types} onChange={onTypes} />
      {domainFacets.length > 0 && <Checks legend="도메인" name="domain" values={domainFacets} current={domain} onChange={onDomain} />}
      <details className="graph-filter">
        <summary>관계 타입</summary>
        <Checks legend="관계" name="rtype" values={edgeTypes} current={rtypes} onChange={onRtypes} />
      </details>
      <label className="graph-toggle">
        <input type="checkbox" data-testid="graph-superseded" checked={superseded} onChange={(e) => { onSuperseded(e.target.checked); }} />
        <span>대체된 관계도 보기(점선)</span>
      </label>
    </aside>
  );
}
