import { useState } from 'react';
import { Check, Link2 } from 'lucide-react';

export async function copyCurrentLink(): Promise<boolean> {
  // The URL always carries the time basis, so the copied link reproduces the screen (design 4).
  try { await navigator.clipboard.writeText(location.href); return true; } catch { return false; }
}

export function CopyLink({ label = '링크 복사' }: { label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const click = async () => {
    setState((await copyCurrentLink()) ? 'done' : 'failed');
    setTimeout(() => setState('idle'), 1600);
  };
  return (
    <button type="button" className="text-action" onClick={() => void click()} data-testid="copy-link">
      {state === 'done' ? <Check className="size-3.5" aria-hidden /> : <Link2 className="size-3.5" aria-hidden />}
      {state === 'done' ? '복사했다' : state === 'failed' ? '복사하지 못했다' : label}
    </button>
  );
}
