// Theme, text size and motion (design v2 2.8, "모양"): this browser's localStorage only, never the server. Applied as attributes of
// <html> when this module loads, before the app paints, so a reload shows the choice at once.
import { useSyncExternalStore } from 'react';
import './appearance.css';

export type Theme = 'system' | 'light' | 'dark';
export type TextSize = 'small' | 'normal' | 'large';
export type Motion = 'system' | 'reduce';
export type Appearance = { theme: Theme; size: TextSize; motion: Motion };

export const APPEARANCE_KEY = 'loupe.appearance';
const DEFAULT: Appearance = { theme: 'system', size: 'normal', motion: 'system' };
const THEMES: readonly Theme[] = ['system', 'light', 'dark'], SIZES: readonly TextSize[] = ['small', 'normal', 'large'], MOTIONS: readonly Motion[] = ['system', 'reduce'];
const pick = <T extends string>(all: readonly T[], v: unknown, d: T): T => (all as readonly unknown[]).includes(v) ? v as T : d;

function read(): Appearance {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? 'null');
    const o = v && typeof v === 'object' ? v as Record<string, unknown> : {};
    return { theme: pick(THEMES, o.theme, DEFAULT.theme), size: pick(SIZES, o.size, DEFAULT.size), motion: pick(MOTIONS, o.motion, DEFAULT.motion) };
  } catch { return DEFAULT; }
}

const dark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
let state: Appearance = read();
const subs = new Set<() => void>();

function apply(a: Appearance) {
  const h = document.documentElement;
  // `data-theme` is always the theme in force; 'system' resolves to what the OS asks for now.
  h.dataset.theme = a.theme === 'system' ? (dark?.matches ? 'dark' : 'light') : a.theme;
  h.dataset.textSize = a.size;
  h.dataset.motion = a.motion === 'reduce' ? 'reduce' : 'system';
}
apply(state);
dark?.addEventListener('change', () => { if (state.theme === 'system') apply(state); });

export const appearance = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  set(patch: Partial<Appearance>) {
    state = { ...state, ...patch };
    try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(state)); } catch { /* storage refused: the choice lasts until the tab closes */ }
    apply(state);
    subs.forEach((f) => f());
  },
};
export const useAppearance = () => useSyncExternalStore(appearance.subscribe, appearance.get);

// Default visibility of new documents and topics (design v2 2.8, "기본 공개 범위"). Notes are always private. Read by the create windows (M1).
export type Visibility = 'private' | 'internal';
export type Defaults = { document: Visibility; topic: Visibility };
export const DEFAULTS_KEY = 'loupe.defaults';
export function readDefaults(): Defaults {
  try {
    const o = JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? 'null') as Record<string, unknown> | null;
    return { document: pick(['private', 'internal'], o?.document, 'private'), topic: pick(['private', 'internal'], o?.topic, 'private') };
  } catch { return { document: 'private', topic: 'private' }; }
}
export function writeDefaults(d: Defaults) { try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); } catch { /* storage refused */ } }
