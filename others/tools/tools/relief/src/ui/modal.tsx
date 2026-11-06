// A centred dialog: focus moves in, Tab stays in, Esc and the backdrop close it, and focus goes back where it was.
import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { const back = before && before !== document.body && before.isConnected ? before : document.querySelector<HTMLElement>('[data-testid="map"]'); back?.focus(); };
  }, []);
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key !== 'Tab') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null);
    if (!items.length) { ev.preventDefault(); return; }
    const first = items[0]!; const last = items.at(-1)!; const at = document.activeElement;
    if (ev.shiftKey && (at === first || at === ref.current)) { ev.preventDefault(); last.focus(); } else if (!ev.shiftKey && at === last) { ev.preventDefault(); first.focus(); }
  };
  return (
    <div className="backdrop" data-testid="backdrop" onPointerDown={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} data-testid="modal" onKeyDown={onKey}>
        <button type="button" className="modal-close" aria-label="닫기" data-testid="modal-close" onClick={onClose}>닫기</button>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
