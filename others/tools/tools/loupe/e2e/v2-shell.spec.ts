import { test, expect } from './support/test.ts';
import { RESEARCH } from './support/ports.ts';
const discarded=['.rail','.tab-bar','.context-panel','.side-panel','[data-testid="rail"]','[data-testid="tab-bar"]','[data-testid="context-panel"]','.workspace > header','.workspace > footer','[data-testid="relations"]'];
test('panel-free home, keyboard focus, click and timed hover previews',async({page})=>{
  await page.goto(RESEARCH+'/#/');
  for(const selector of discarded) await expect(page.locator(selector)).toHaveCount(0);
  const node=page.getByRole('option',{name:'M0c 작업 공간',exact:true});
  // Tab reaches the visible-node accessibility list, in topic-first order.
  await page.getByTestId('palette-button').focus();
  for(let i=0;i<8 && !(await node.evaluate(e=>e===document.activeElement));i++) await page.keyboard.press('Tab');
  await expect(node).toBeFocused();
  await expect(page.getByTestId('node-preview')).toContainText('M0c 작업 공간');
  await page.keyboard.press('Escape'); await expect(page.getByTestId('node-preview')).toHaveCount(0);
  await page.getByTestId('graph-node-list').getByRole('option').nth(1).hover();
  await expect(page.getByTestId('node-preview')).toBeVisible();
  await page.mouse.move(790,40); await expect(page.getByTestId('node-preview')).toHaveCount(0);
  await node.click(); await expect(page.getByTestId('node-preview')).toBeVisible();
  await page.keyboard.press('Enter'); await expect(page.getByTestId('wm-window')).toHaveCount(1);
});
test('find is inline, previews arrow selection, ignores IME Enter and opens on Enter',async({page})=>{
  await page.goto(RESEARCH+'/#/'); await page.keyboard.press('Control+k');
  const input=page.getByTestId('palette-input'); await input.fill('M0c');
  await expect(page.getByTestId('palette-hit').first()).toBeVisible();
  await input.dispatchEvent('keydown',{key:'Enter',keyCode:229,isComposing:true});
  await expect(page.getByTestId('wm-window')).toHaveCount(0);
  await input.dispatchEvent('keydown',{key:'ArrowDown',keyCode:229,isComposing:true});
  await page.keyboard.press('ArrowDown'); await expect(page.getByTestId('node-preview')).toBeVisible();
  await page.keyboard.press('Enter'); await expect(page.getByTestId('wm-window')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('a deep link opens only its window and never exposes first-party title in browser metadata',async({page})=>{
  await page.goto(RESEARCH+'/#/w/f-m0c-note');
  await expect(page.getByTestId('wm-window')).toHaveCount(1);
  await expect(page.getByTestId('node-title')).toHaveText('M0c 비공개 메모 제목');
  await expect(page).toHaveTitle('loupe · 메모');
  expect(decodeURIComponent(page.url())).not.toContain('비공개');
  const saved=await page.evaluate(()=>sessionStorage.getItem('loupe.windows.v2'));
  expect(saved).not.toMatch(/비공개|body|title/);
  await page.goto(RESEARCH+'/#/w/f-m0c-page');
  await expect(page.getByTestId('wm-window')).toHaveCount(1);
  await expect(page.getByTestId('wm-window')).toHaveAttribute('data-id','f-m0c-page');
  await expect(page).toHaveTitle('loupe · 문서');
});
