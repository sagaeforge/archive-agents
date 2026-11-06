// The table of a database view (design v2 11.3 M4, 4.3): the node view of a ```loupe-view block (editor/DocParts.tsx ViewBlock).
// It lists the first-party records of the type of the definition, narrows them by the person's filter, and edits a property cell in place. A cell edit goes to the save
// machine of its record (rowSaver.ts), which sends the whole record with the whole `props`. Every value reaches the screen as a text child or the value of a field of
// React; nothing here sets markup (design 4.5).
import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isComposing } from '../wm/model.ts';
import { windows } from '../wm/opener.ts';
import { listRows, type Listed, type ListStatus } from './api.ts';
import { cellText, columnValue, filterRows, parseCell, sortRows, STATUS_LABEL, type Row } from './rows.ts';
import type { RowSaver } from './rowSaver.ts';
import { DbScope } from './scope.ts';
import { rowSaverFor } from './savers.ts';
import { filterStore, useFilter, type Filter } from './store.ts';
import { COLUMN_KEYS, COLUMN_LABEL, isPropColumn, parseView, type ColumnKey, type ViewDef } from './view.ts';
import './db.css';

const TYPE_NAME = { Note: '메모', Page: '문서' } as const;
const isColumn = (k: string): k is ColumnKey => (COLUMN_KEYS as readonly string[]).includes(k);
const labelOf = (k: string) => (isColumn(k) ? COLUMN_LABEL[k] : k);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const when = (iso: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
const KEY = (type: string, status: ListStatus) => ['loupe', 'db', type, status] as const;
const without = <T extends object>(o: T, k: keyof T): T => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k)) as T;

/** `readOnly`: a past version of a document. The records are the present ones, not those of that version, so the block says what it is and reads nothing. */
export function DbView({ source, readOnly = false }: { source: string; readOnly?: boolean }) {
  const parsed = useMemo(() => parseView(source), [source]);
  if (!parsed.ok) return <div className="dbv" data-testid="db-view-invalid" role="status">보기 정의를 읽을 수 없다 · {parsed.reason}</div>;
  if (readOnly) return <div className="dbv" data-testid="db-view-static" role="status">데이터베이스 · {TYPE_NAME[parsed.def.type]} · {parsed.def.columns.map((c) => COLUMN_LABEL[c]).join(', ')}</div>;
  return <Table source={source} def={parsed.def} />;
}

function Table({ source, def }: { source: string; def: ViewDef }) {
  const scope = useContext(DbScope);
  const qc = useQueryClient();
  const initial = useMemo<Filter>(() => ({ text: def.filter.text, tag: def.filter.tag, status: 'active' }), [def]);
  const filter = useFilter(scope, source, initial);
  const set = (patch: Partial<Filter>) => filterStore.set(scope, source, patch, initial);
  // The filter narrows what was read; only the status asks the KB again (a record that is not active is not in the default answer).
  const list = useQuery({ queryKey: KEY(def.type, filter.status), queryFn: () => listRows(def.type, filter.status), staleTime: 30_000 });
  const all = list.data?.rows;
  const shown = useMemo(() => (all ? sortRows(filterRows(all, filter), def.sort) : []), [all, filter, def.sort]);

  const patchRow = useCallback((id: string, p: Partial<Row>) => { qc.setQueryData<Listed>(KEY(def.type, filter.status), (old) => old && { ...old, rows: old.rows.map((r) => (r.id === id ? { ...r, ...p } : r)) }); }, [qc, def.type, filter.status]);
  const dropRow = useCallback((id: string) => { qc.setQueryData<Listed>(KEY(def.type, filter.status), (old) => old && { ...old, rows: old.rows.filter((r) => r.id !== id) }); }, [qc, def.type, filter.status]);
  const reload = useCallback(() => { void qc.invalidateQueries({ queryKey: ['loupe', 'db'] }); }, [qc]);

  return <div className="dbv" data-testid="db-view" data-type={def.type}>
    <div className="dbv-bar">
      <strong>{TYPE_NAME[def.type]} 표</strong>
      <input type="text" className="dbv-filter" data-testid="db-filter-text" aria-label="제목 검색" placeholder="제목" value={filter.text} onChange={(e) => set({ text: e.target.value })} />
      <input type="text" className="dbv-filter" data-testid="db-filter-tag" aria-label="태그 거르기" placeholder="태그" value={filter.tag} onChange={(e) => set({ tag: e.target.value })} />
      <select data-testid="db-filter-status" aria-label="상태" value={filter.status} onChange={(e) => set({ status: e.target.value === 'dead' ? 'dead' : 'active' })}>
        <option value="active">{STATUS_LABEL.active}</option>
        <option value="dead">{STATUS_LABEL.dead}</option>
      </select>
      <button type="button" data-testid="db-filter-clear" onClick={() => filterStore.clear(scope, source)}>필터 지우기</button>
      <button type="button" data-testid="db-refresh" onClick={reload}>새로 고침</button>
      {all && <span className="dbv-count" data-testid="db-count" data-shown={shown.length} data-total={all.length} role="status">{shown.length} / {all.length}행</span>}
    </div>
    {list.isError && <p role="alert" data-testid="db-error">행을 읽지 못했다</p>}
    {!all && !list.isError && <p role="status">행을 읽는 중</p>}
    {all && <table className="dbv-table" data-testid="db-table">
      <thead><tr>{def.columns.map((c) => <th key={c} data-col={c} scope="col">{COLUMN_LABEL[c]}</th>)}<td aria-hidden="true" /></tr></thead>
      <tbody>{shown.map((row) => <RowView key={row.id} row={row} def={def} scope={scope} patch={patchRow} drop={dropRow} reload={reload} />)}</tbody>
    </table>}
    {all && shown.length === 0 && <p className="dbv-empty" data-testid="db-empty" role="status">{all.length === 0 ? '기록이 없다' : '맞는 행이 없다'}</p>}
    {list.data?.more && <p className="dbv-empty" data-testid="db-more" role="status">처음 {all?.length}행만 보인다</p>}
  </div>;
}

type RowProps = { row: Row; def: ViewDef; scope: string; patch: (id: string, p: Partial<Row>) => void; drop: (id: string) => void; reload: () => void };

function RowView({ row, def, scope, patch, drop, reload }: RowProps) {
  const saver: RowSaver = rowSaverFor(scope, row.id);
  const snap = useSyncExternalStore(saver.subscribe, saver.get);
  const [drafts, setDrafts] = useState<Partial<Record<ColumnKey, string>>>({});
  const [invalid, setInvalid] = useState<ColumnKey | null>(null);
  // The text the pre-check holds, until the person sends it anyway, fixes it or gives it up. The saver keeps the value for the send; this keeps it in the field.
  const [held, setHeld] = useState<{ col: ColumnKey; text: string } | null>(null);
  const boxes = useRef<Partial<Record<ColumnKey, HTMLInputElement | null>>>({});

  // The KB's version of this row is newer than the list's (a save of this window, or "저쪽 것 가져오기"): the list takes it.
  useEffect(() => {
    if (snap.version !== null && snap.props && snap.version > row.version) patch(row.id, { version: snap.version, props: snap.props, label: snap.title ?? row.label });
  }, [snap.version, snap.props, snap.title, row.version, row.id, row.label, patch]);
  useEffect(() => { if (snap.state === 'quarantined') drop(row.id); }, [snap.state, drop, row.id]);

  if (snap.state === 'quarantined') return null;
  const editable = row.status === 'active' && row.id !== scope;
  const shownProps = { ...row.props, ...snap.cells };

  const send = async (col: ColumnKey, value: unknown, text: string, anyway = false) => {
    await saver.edit(row.version, col, value, anyway ? { anyway: true } : {});
    setHeld(saver.get().state === 'blocked' ? { col, text } : null);
  };
  const commitText = (col: ColumnKey) => {
    const text = drafts[col];
    if (text === undefined) return;
    const parsed = parseCell(col, text);
    if (!parsed.ok) { setInvalid(col); return; }
    setInvalid(null);
    setDrafts((d) => without(d, col));
    if (same(parsed.value, shownProps[col])) return;
    void send(col, parsed.value, text);
  };
  const keys = (col: ColumnKey) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e.nativeEvent)) return;
    if (e.key === 'Enter') { e.preventDefault(); commitText(col); }
    else if (e.key === 'Escape') { e.stopPropagation(); setInvalid(null); setDrafts((d) => without(d, col)); setHeld(null); saver.dismiss(); }
  };

  const cellOf = (col: ColumnKey) => {
    if (col === 'title') return <span role="link" tabIndex={0} dir="auto" className="dbv-title" onClick={() => windows.open(row.id)} onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e.nativeEvent)) windows.open(row.id); }}>{row.label}</span>;
    if (!isPropColumn(def.type, col)) return col === 'recorded_at' ? when(row.recorded_at) : cellText(col, columnValue(row, col));
    const label = `${labelOf(col)} · ${row.label}`;
    if (col === 'pinned') {
      return <input type="checkbox" data-testid="db-input" aria-label={label} checked={shownProps.pinned === true} disabled={!editable} onChange={(e) => void send('pinned', e.target.checked, '')} />;
    }
    const text = held?.col === col ? held.text : drafts[col] ?? cellText(col, shownProps[col]);
    return <input type="text" data-testid="db-input" dir="auto" aria-label={label} aria-invalid={invalid === col ? true : undefined} value={text} disabled={!editable}
      ref={(el) => { boxes.current[col] = el; }}
      onChange={(e) => { setInvalid(null); setDrafts((d) => ({ ...d, [col]: e.target.value })); }}
      onBlur={() => commitText(col)} onKeyDown={keys(col)} />;
  };

  const chip = snap.state === 'saving' ? '저장 중' : snap.state === 'pending' ? `보내는 중 · ${snap.detail ?? ''}` : snap.state === 'offline' ? '끊김 · 다시 보내는 중' : snap.state === 'throttled' ? snap.detail ?? '' : '';
  const span = def.columns.length + 1;
  const c = snap.conflict;
  const rules = [...new Set(snap.hits.map((h) => `${h.rule} (${h.field === 'props' ? '속성' : h.field === 'title' ? '제목' : '본문'})`))];

  return <Fragment>
    <tr data-testid="db-row" data-id={row.id} data-state={snap.state}>
      {def.columns.map((col) => <td key={col} data-testid="db-cell" data-col={col}>{cellOf(col)}</td>)}
      <td className="dbv-chip" data-testid="db-chip" role="status">{chip}</td>
    </tr>
    {(c || snap.hitsFrom || snap.state === 'invalid' || snap.state === 'auth') && <tr className="dbv-band-row"><td colSpan={span}>
      {c && <section className="memo-band" data-tone="error" data-testid="db-conflict" data-id={row.id} role="alert">
        <strong>다른 곳에서 v{c.current.version}으로 바뀌었다{c.current.actor ? ` · ${c.current.actor}` : ''}</strong>
        {c.current.status !== 'active' ? '다른 곳에서 보관됨' : <div className="memo-cols">
          <div><small>내 변경</small><ul>{Object.entries(c.mine).map(([k, v]) => <li key={k}>{labelOf(k)}: {cellText(isColumn(k) ? k : 'icon', v) || '(비움)'}</li>)}</ul></div>
          <div><small>저쪽</small><ul>{def.columns.filter((x) => isPropColumn(def.type, x)).map((x) => <li key={x}>{COLUMN_LABEL[x]}: {cellText(x, c.current.props[x]) || '(비움)'}</li>)}</ul></div>
        </div>}
        <div className="memo-actions">
          <button type="button" data-testid="db-take-theirs" onClick={() => { const dead = c.current.status !== 'active'; saver.takeTheirs(); if (dead) reload(); }}>{c.current.status === 'active' ? '저쪽 것 가져오기' : '닫기'}</button>
          {c.current.status === 'active' && <button type="button" data-testid="db-keep-mine" onClick={() => void saver.keepMine()}>내 것으로 덮어쓰기</button>}
        </div>
      </section>}
      {snap.hitsFrom && <section className="memo-band" data-tone="error" data-testid="db-secret" data-source={snap.hitsFrom} data-id={row.id} role="alert">
        <strong>{snap.hitsFrom === 'kb' ? '저장 거절 · KB가 비밀로 보았다' : '저장 전 검사에 걸림'}</strong>
        <ul>{rules.map((r) => <li key={r}>규칙 {r}</li>)}</ul>
        {snap.hitsFrom === 'kb' ? '저장된 곳이 없다. 저장 전 검사가 놓친 것이다. 입력한 값은 지웠다.' : '이 값은 보내지 않았다.'}
        <div className="memo-actions">
          {snap.hitsFrom === 'precheck' && held && <>
            <button type="button" data-testid="db-fix" onClick={() => boxes.current[held.col]?.focus()}>고치기</button>
            <button type="button" data-testid="db-send-anyway" onClick={() => { const p = parseCell(held.col, held.text); if (p.ok) void send(held.col, p.value, held.text, true); }}>일반으로 보내기</button>
          </>}
          <button type="button" data-testid="db-dismiss" onClick={() => { setHeld(null); setDrafts({}); saver.dismiss(); }}>{snap.hitsFrom === 'precheck' ? '취소' : '닫기'}</button>
        </div>
      </section>}
      {(snap.state === 'invalid' || snap.state === 'auth') && <section className="memo-band" data-tone="error" data-testid="db-problem" data-id={row.id} role="alert">
        <strong>저장하지 못했다 · {snap.detail}</strong>
        <div className="memo-actions"><button type="button" data-testid="db-dismiss" onClick={() => saver.dismiss()}>닫기</button></div>
      </section>}
    </td></tr>}
  </Fragment>;
}
