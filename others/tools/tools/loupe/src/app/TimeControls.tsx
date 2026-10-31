// The time chip, the amber band and the frame. The URL holds the basis; the chip only holds a draft while it is open (design 4).
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { Clock } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { envelopeStore } from '../data/envelopeStore.ts';
import { formatKst, formatValidAxis, isoFromDateInput, isoFromKstInput, kstInputFromIso } from '../time/format.ts';
import { VIEW_LABEL } from '../time/parse.ts';
import { useIsPastView, useTimeNavigate, useTimeSearch, useViewKind } from '../time/useTimeBasis.ts';
import { CopyLink } from './CopyLink.tsx';

export function useTimeActions() {
  const go = useTimeNavigate();
  const env = useSyncExternalStore(envelopeStore.subscribe, envelopeStore.get);
  return {
    toPresent: () => go({ as_of_valid: undefined, as_of_observed: undefined }),
    /** Pins the observed axis to the current data_as_of, which makes the link reproducible (design 4). */
    pinNow: () => { const at = env.meta?.data_as_of; if (at) go({ as_of_observed: at }); },
    set: go,
    canPin: !!env.meta?.data_as_of,
  };
}

/** The patch for 적용: an axis whose input was not edited is left out, so applying with no edits changes nothing.
 *  The inputs are coarser than the URL (a date, whole seconds), and writing them back would move the basis. */
export function chipPatch(edited: { valid: boolean; observed: boolean }, values: { valid: string; observed: string }):
  { patch: { as_of_valid?: string | undefined; as_of_observed?: string | undefined }; bad: boolean } {
  const patch: { as_of_valid?: string | undefined; as_of_observed?: string | undefined } = {};
  let bad = false;
  if (edited.valid) { const v = values.valid ? isoFromDateInput(values.valid) : undefined; if (v === null) bad = true; else patch.as_of_valid = v; }
  if (edited.observed) { const o = values.observed ? isoFromKstInput(values.observed) : undefined; if (o === null) bad = true; else patch.as_of_observed = o; }
  return { patch, bad };
}

export function TimeChip() {
  const s = useTimeSearch();
  const past = useIsPastView();
  const kind = useViewKind();
  const [edited, setEdited] = useState({ valid: false, observed: false });
  const { toPresent, pinNow, set, canPin } = useTimeActions();
  const [open, setOpen] = useState(false);
  const [valid, setValid] = useState('');
  const [observed, setObserved] = useState('');
  const [bad, setBad] = useState(false);

  const onOpen = (next: boolean) => {
    if (next) {
      setValid(s.as_of_valid?.slice(0, 10) ?? '');
      setObserved(s.as_of_observed ? kstInputFromIso(s.as_of_observed) : '');
      setEdited({ valid: false, observed: false });
      setBad(false);
    }
    setOpen(next);
  };
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const { patch, bad: invalid } = chipPatch(edited, { valid, observed });
    if (invalid) { setBad(true); return; }
    if (Object.keys(patch).length > 0) set(patch);
    setOpen(false);
  };
  const close = (f: () => void) => () => { f(); setOpen(false); };

  return (
    <Popover open={open} onOpenChange={onOpen}>
      <PopoverTrigger data-testid="time-chip" data-past={past || undefined} className="time-chip">
        <Clock className="size-3.5" aria-hidden />{kind === 'live' ? '현재' : VIEW_LABEL[kind]}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-76 gap-3 p-3.5">
        <form onSubmit={apply} className="flex flex-col gap-3" data-testid="time-form">
          <label className="field">
            <span>유효 시점</span>
            <input type="date" value={valid} onChange={(e) => { setValid(e.target.value); setEdited((x) => ({ ...x, valid: true })); }} data-testid="time-valid" />
            <small>그날 어떤 사실이었나. 날짜 그대로 쓴다.</small>
          </label>
          <label className="field">
            <span>관측 시점 (KST)</span>
            <input type="datetime-local" step={1} value={observed} onChange={(e) => { setObserved(e.target.value); setEdited((x) => ({ ...x, observed: true })); }} data-testid="time-observed" />
            <small>그때까지 무엇을 알고 있었나.</small>
          </label>
          {bad && <p role="alert" className="text-sm text-danger">날짜를 읽지 못했다.</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="submit" size="sm" data-testid="time-apply">적용</Button>
            {past && <Button type="button" size="sm" variant="ghost" onClick={close(toPresent)} data-testid="time-present">현재로</Button>}
            <Button type="button" size="sm" variant="ghost" disabled={!canPin} onClick={close(pinNow)} data-testid="time-pin">지금으로 고정</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function TimeBand() {
  const s = useTimeSearch();
  const kind = useViewKind();
  const { toPresent } = useTimeActions();
  return (
    <div role="status" data-testid="time-band" className="time-band">
      <strong className="font-semibold" data-kind={kind}>{kind === 'live' ? '과거 보기' : VIEW_LABEL[kind]}</strong>
      {s.as_of_valid && <span title={s.as_of_valid}>유효 {formatValidAxis(s.as_of_valid)}</span>}
      {s.as_of_observed && <span title={s.as_of_observed}>관측 {formatKst(s.as_of_observed)}</span>}
      <button type="button" className="underline underline-offset-2" onClick={toPresent} data-testid="band-present">현재로</button>
      <span className="ml-auto"><CopyLink /></span>
    </div>
  );
}
