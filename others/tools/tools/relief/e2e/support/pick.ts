import type { Page } from '@playwright/test';

/** Clicks the visible part of an object: the first point of its top face where the browser's hit test returns that object. */
export async function clickObject(page: Page, id: string): Promise<void> {
  const pt = await page.evaluate((want) => {
    const g = document.querySelector(`svg.scene g[data-id="${CSS.escape(want)}"]`); if (!g) return null;
    const faces = [...g.querySelectorAll('polygon')].sort((a) => (a.getAttribute('data-face') === 'top' ? -1 : 1));
    for (const f of faces) {
      const r = f.getBoundingClientRect();
      for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
        const x = r.left + (r.width * i) / 12; const y = r.top + (r.height * j) / 12;
        const hit = document.elementFromPoint(x, y)?.closest('[data-id]') as HTMLElement | null;
        if (hit?.dataset.id === want) return [x, y] as [number, number];
      }
    }
    return null;
  }, id);
  if (!pt) throw new Error(`no visible point on ${id}`);
  await page.mouse.click(pt[0], pt[1]);
}
