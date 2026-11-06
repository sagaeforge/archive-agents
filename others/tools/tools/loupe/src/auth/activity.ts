// What counts as use of the session (Codex review of M0b, finding 4): only a person's input. Background polls must not keep an
// unattended tab signed in, so a request carries X-Loupe-Activity: 1 only when there was input since the last request that did.
// While someone works without making requests (reading, typing), a light ping reports that input once a minute.
let lastInput = 0;
let reported = 0;
let started = false;

const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function trackActivity(): () => void {
  if (started || typeof window === 'undefined') return () => undefined;
  started = true;
  // Only the browser's own events: a script's dispatchEvent is not input (isTrusted false). The header stays a hint: a script that
  // holds the bearer can set it itself (Codex re-review C).
  const on = (e: Event) => { if (e.isTrusted) lastInput = Date.now(); };
  for (const e of EVENTS) window.addEventListener(e, on, { capture: true, passive: true });
  return () => { for (const e of EVENTS) window.removeEventListener(e, on, { capture: true }); started = false; };
}

/** True when there was input not yet reported. */
export const activityPending = () => lastInput > reported;

/** The header for the next request: present once per burst of input. */
export function activityHeader(): Record<string, string> {
  if (!activityPending()) return {};
  reported = Date.now();
  return { 'x-loupe-activity': '1' };
}
