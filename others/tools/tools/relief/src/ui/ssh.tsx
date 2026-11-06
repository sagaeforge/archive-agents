// "SSH 명령 복사" (design 1, 19): shows the exact line and puts it on the clipboard. It opens nothing and runs nothing.
import { useEffect, useState } from 'react';
import type { Entity } from '../../server/model/fact.ts';
import { sshOffer } from '../../server/model/ssh.ts';

/** Clipboard API first; where it is denied or absent, a hidden selection and `execCommand`. Returns false when neither worked. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* denied or no secure context: fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

export function SshCopy({ e }: { e: Entity }) {
  const offer = sshOffer(e);
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const command = offer && 'command' in offer ? offer.command : null;
  useEffect(() => setState('idle'), [command, e.id]);
  useEffect(() => { if (state === 'idle') return; const t = setTimeout(() => setState('idle'), 2500); return () => clearTimeout(t); }, [state]);
  if (!offer) return null;
  if (command === null) return <section className="card"><p className="sub" data-testid="ssh-none">SSH 명령 없음 · {'why' in offer ? offer.why : ''}</p></section>;
  return (
    <div className="ssh card" data-testid="ssh">
      <button type="button" data-testid="ssh-copy" data-ssh-command={command} data-state={state} onClick={() => { void copyText(command).then((ok) => setState(ok ? 'done' : 'failed')); }}>
        <b>{state === 'done' ? '복사됨' : 'SSH 복사'}</b>
        <code data-testid="ssh-text">{command}</code>
      </button>
      {state === 'failed' ? <p className="warn" data-testid="ssh-failed">복사하지 못했다 · 위 줄을 직접 선택해 복사한다</p> : null}
    </div>
  );
}
