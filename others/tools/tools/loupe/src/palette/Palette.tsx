// The keyboard way in (design 2). cmdk with shouldFilter off: ranking and tokenizing belong to the KB search.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CommandDialog, Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import type { SearchHit } from '../client/model/index.ts';
import { useEntitySearch, useLabels } from '../data/hooks.ts';
import { splitHighlights } from '../quote/codepoints.ts';
import { parseDateQuery } from '../time/format.ts';
import { useIsPastView, useTimeBasis } from '../time/useTimeBasis.ts';
import { formatKst, formatValidAxis } from '../time/format.ts';
import type { TimeBasis } from '../time/asOf.ts';
import { useTimeActions } from '../app/TimeControls.tsx';
import { copyCurrentLink } from '../app/CopyLink.tsx';
import { describeError } from '../lib/errors.ts';
import { readRecent } from './recent.ts';
import { setPaletteOpen, usePaletteOpen } from './store.ts';

const DEBOUNCE_MS = 150;

function Marked({ text, ranges }: { text: string; ranges: readonly { start: number; end: number }[] }) {
  return <>{splitHighlights(text, ranges).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}</>;
}

/** What an empty result may say: only titles were searched, and in a past view only the titles of that time. */
export function noEntityMessage(t: TimeBasis): string {
  const at = [t.valid ? `유효 ${formatValidAxis(t.valid)}` : null, t.observed ? `관측 ${formatKst(t.observed)}` : null].filter(Boolean).join(', ');
  return at ? `이름이 일치하는 엔티티가 없다 (${at} 기준). 지금은 있을 수 있다.` : '이름이 일치하는 엔티티가 없다. 주장 문장과 값은 검색하지 않는다.';
}

const trimEllipsis = (s: string) => s.replace(/^…/, '').replace(/…$/, '');

function HitRow({ hit }: { hit: SearchHit }) {
  const same = trimEllipsis(hit.snippet ?? '').trim() === (hit.title ?? '').trim();
  const ranges = (hit.highlights ?? []).map((h) => ({ start: h.start, end: h.end }));
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="min-w-0 flex-1">
        <bdi className="block truncate font-medium">{same ? <Marked text={hit.snippet ?? ''} ranges={ranges} /> : hit.title}</bdi>
        {!same && hit.snippet && <bdi className="block truncate text-xs text-faint"><Marked text={hit.snippet} ranges={ranges} /></bdi>}
      </span>
      <span className="shrink-0 text-xs text-faint">{hit.type}</span>
    </span>
  );
}

type Command_ = { value: string; label: string; hint?: string; run: () => void; testid?: string };

function PaletteBody() {
  const navigate = useNavigate();
  const past = useIsPastView();
  const { toPresent, pinNow, set, canPin } = useTimeActions();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(input), DEBOUNCE_MS); return () => clearTimeout(t); }, [input]);

  const search = useEntitySearch(query);
  const typing = input.trim().length > 0;
  const settled = input === query && !search.isFetching && !search.isPlaceholderData;
  const hits = useMemo(() => {
    const items = typing ? (search.data?.data.items ?? []) : [];
    const seen = new Set<string>();
    return items.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true))); // C 2.4: search pages may repeat an id
  }, [search.data, typing]);

  const recentIds = useMemo(readRecent, []);
  const recent = useLabels(recentIds, true);

  const close = () => setPaletteOpen(false);
  const go = (id: string) => { close(); void navigate({ to: '/node/$id', params: { id } }); };
  const run = (f: () => void) => () => { close(); f(); };

  const needle = input.trim().toLowerCase();
  const wanted = (label: string) => !needle || label.toLowerCase().includes(needle);

  const nav: Command_[] = [
    { value: 'nav:home', label: '처음', run: run(() => void navigate({ to: '/' })) },
    { value: 'nav:status', label: '연결 상태', run: run(() => void navigate({ to: '/status' })) },
    { value: 'nav:graph', label: '그래프', run: run(() => void navigate({ to: '/graph' })) },
  ].filter((c) => wanted(c.label));

  const date = parseDateQuery(input);
  const time: Command_[] = [
    // Observed first: "what was believed then" is the question a dated link answers, and Enter takes the first row.
    // Each row says which question it answers, as the time chip does.
    ...(date ? [{ value: 'time:observed', label: `관측 시점을 ${date.valid ? `${date.display} 00:00 KST` : date.display}로`, hint: '그때까지 무엇을 알고 있었나', run: run(() => set({ as_of_observed: date.observed })), testid: 'cmd-observed' }] : []),
    ...(date?.valid ? [{ value: 'time:valid', label: `유효 시점을 ${date.display}로`, hint: '그날 어떤 사실이었나 (지금 아는 내용으로)', run: run(() => set({ as_of_valid: date.valid! })), testid: 'cmd-valid' }] : []),
    // In a past view the way back stays in the list whatever is typed.
    ...(past ? [{ value: 'time:present', label: '현재로', run: run(toPresent), testid: 'cmd-present' }] : []),
    ...(canPin && wanted('지금으로 고정') ? [{ value: 'time:pin', label: '지금으로 고정', hint: '재현되는 링크를 만든다', run: run(pinNow), testid: 'cmd-pin' }] : []),
    ...(wanted('링크 복사') ? [{ value: 'time:copy', label: '링크 복사', hint: '시간 기준을 포함한다', run: run(() => void copyCurrentLink()) }] : []),
  ];

  const firstValue = hits[0] ? `hit:${hits[0].id}` : (!typing && recent[0] ? `recent:${recent[0].id}` : (time[0] && date ? time[0].value : nav[0]?.value ?? time[0]?.value ?? ''));
  useEffect(() => { setSelected(firstValue); }, [firstValue]);

  // Enter pressed before the debounce and the answer have landed: act on the answer, not on the stale list.
  const pendingEnter = useRef(false);
  // A reopen during the closing transition keeps the old focus scope, so the input takes focus itself.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const f = requestAnimationFrame(() => inputRef.current?.focus()); return () => cancelAnimationFrame(f); }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && typing && !settled && !date) { e.preventDefault(); e.stopPropagation(); pendingEnter.current = true; }
  };
  useEffect(() => {
    if (!pendingEnter.current || !settled) return;
    pendingEnter.current = false;
    if (hits[0]) go(hits[0].id);
  }, [settled, hits]);

  const searchError = typing && search.isError && !search.data ? describeError(search.error) : null;
  // The palette searches names (titles) only, and in a past view only as they were then. Say that, not "nothing exists".
  const nothing = typing && settled && hits.length === 0 && !searchError && !date;
  const basis = useTimeBasis();

  return (
    <Command shouldFilter={false} loop vimBindings={false} value={selected} onValueChange={setSelected} onKeyDownCapture={onKeyDown} className="palette" label="팔레트">
      <CommandInput ref={inputRef} autoFocus value={input} onValueChange={setInput} placeholder="엔티티 이름, 날짜(2026-10-28), 명령" data-testid="palette-input" />
      <CommandList className="max-h-[min(58vh,28rem)]" data-testid="palette-list">
        {nothing && <p role="status" data-testid="palette-empty" className="px-3 py-2 text-sm text-faint">{noEntityMessage(basis)}</p>}
        {searchError && <p role="alert" data-testid="palette-error" className="px-3 py-2 text-sm text-danger">{searchError.title}. {searchError.detail}</p>}
        {typing && !settled && hits.length === 0 && !searchError && <p role="status" className="px-3 py-2 text-sm text-faint">찾는 중</p>}
        {hits.length > 0 && (
          <CommandGroup heading="엔티티">
            {hits.map((h) => (
              <CommandItem key={h.id} value={`hit:${h.id}`} onSelect={() => go(h.id)} data-testid="palette-hit" data-id={h.id}><HitRow hit={h} /></CommandItem>
            ))}
          </CommandGroup>
        )}
        {(nav.length > 0 || (!typing && recent.length > 0)) && (
          <>
            {hits.length > 0 && <CommandSeparator />}
            <CommandGroup heading="이동">
              {!typing && recent.map((r) => (
                <CommandItem key={r.id} value={`recent:${r.id}`} onSelect={() => go(r.id)} data-testid="palette-recent" data-id={r.id}>
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <bdi className={r.label ? 'min-w-0 flex-1 truncate' : 'id min-w-0 flex-1 truncate'}>{r.label ?? r.id}</bdi>
                    <span className="shrink-0 text-xs text-faint">{r.type}</span>
                  </span>
                </CommandItem>
              ))}
              {nav.map((c) => <CommandItem key={c.value} value={c.value} onSelect={c.run}>{c.label}</CommandItem>)}
            </CommandGroup>
          </>
        )}
        {time.length > 0 && (
          <CommandGroup heading="시간">
            {time.map((c) => (
              <CommandItem key={c.value} value={c.value} onSelect={c.run} data-testid={c.testid}>
                <span className="flex-1">{c.label}</span>{c.hint && <span className="text-xs text-faint">{c.hint}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="palette-hints" aria-hidden>
        <span><kbd>↑</kbd><kbd>↓</kbd> 고르기</span><span><kbd>Enter</kbd> 열기</span><span><kbd>Esc</kbd> 닫기</span>
      </div>
    </Command>
  );
}

export function Palette() {
  const open = usePaletteOpen();
  return (
    <CommandDialog open={open} onOpenChange={setPaletteOpen} title="팔레트" description="엔티티를 찾고 화면과 시간을 옮긴다" className="palette-dialog top-[13vh] sm:max-w-xl">
      {open && <PaletteBody />}
    </CommandDialog>
  );
}
