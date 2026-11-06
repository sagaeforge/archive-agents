import { test, expect } from './support/test.ts';
import { RESEARCH } from './support/ports.ts';
import type { Page } from '@playwright/test';
const windows=(page:Page)=>page.getByTestId('wm-window');
async function openThree(page:Page){
  await page.goto(RESEARCH+'/#/');
  for(const id of ['e:topic:m0c','f-m0c-page','f-m0c-note']){
    const option=page.getByTestId('graph-node-list').locator(`[data-id="${id}"]`);
    await option.focus(); await page.keyboard.press('Enter');
  }
  await expect(windows(page)).toHaveCount(3);
}
async function layout(page:Page){return page.evaluate(()=>JSON.parse(sessionStorage.getItem('loupe.windows.v2')??'[]'));}
test('mouse fronts, drags, resizes all eight grips, docks, restores, reloads and closes',async({page})=>{
  await openThree(page);
  const note=windows(page).filter({has:page.getByTestId('node-title').filter({hasText:'비공개 메모'})});
  const head=note.getByTestId('wm-titlebar'); const box=(await head.boundingBox())!;
  await page.mouse.move(box.x+100,box.y+15); await page.mouse.down(); await page.mouse.move(box.x+170,box.y+55); await page.mouse.up();
  expect((await layout(page)).at(-1).x).toBeGreaterThan(128);
  for(const edge of ['n','ne','e','se','s','sw','w','nw']){
    const grip=note.locator(`[data-resize="${edge}"]`); const b=(await grip.boundingBox())!;
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down();
    await page.mouse.move(b.x+b.width/2+(edge.includes('w')?-10:edge.includes('e')?10:0),b.y+b.height/2+(edge.includes('n')?-10:edge.includes('s')?10:0)); await page.mouse.up();
  }
  await note.getByRole('button',{name:'내리기',exact:true}).click(); await expect(page.getByTestId('window-dock')).toBeVisible();
  await page.getByTestId('window-dock').getByRole('button').click(); await expect(windows(page)).toHaveCount(3);
  await windows(page).first().getByTestId('wm-titlebar').click(); await expect(windows(page).first()).toHaveAttribute('data-front','true');
  const before=await layout(page); await page.reload(); await expect(windows(page)).toHaveCount(3); expect(await layout(page)).toEqual(before);
  for(let i=0;i<3;i++) await windows(page).last().getByRole('button',{name:'닫기',exact:true}).click();
  await expect(windows(page)).toHaveCount(0); await expect(page.getByTestId('window-dock')).toHaveCount(0);
});
test('keyboard cycles both ways, moves, resizes, cancels, minimizes/restores and closes',async({page})=>{
  await openThree(page);
  await page.keyboard.press('Alt+Backquote'); await expect(windows(page).first()).toHaveAttribute('data-front','true');
  await page.keyboard.press('Alt+Shift+Backquote'); await expect(windows(page).last()).toHaveAttribute('data-front','true');
  const note=windows(page).last(); const before=(await layout(page)).at(-1);
  await note.getByRole('button',{name:'창 메뉴'}).click(); await page.getByRole('menuitem',{name:'이동·크기'}).click();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Enter');
  const moved=(await layout(page)).at(-1); expect(moved.x).toBe(before.x+10); expect(moved.height).toBe(before.height+10);
  await note.getByRole('button',{name:'창 메뉴'}).click(); await page.getByRole('menuitem',{name:'이동·크기'}).click();
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Escape'); expect((await layout(page)).at(-1)).toEqual(moved);
  await page.keyboard.press('Alt+m'); await expect(windows(page)).toHaveCount(2);
  await page.getByTestId('window-dock').getByRole('button').focus(); await page.keyboard.press('Enter'); await expect(windows(page)).toHaveCount(3);
  await page.keyboard.press('Escape'); await expect(windows(page)).toHaveCount(3);
  await page.keyboard.press('Alt+0'); await expect(windows(page)).toHaveCount(0);
  const beforeReload=await layout(page); await page.reload(); expect(await layout(page)).toEqual(beforeReload);
  for(let i=0;i<3;i++){
    await page.getByTestId('window-dock').getByRole('button').first().focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Alt+w');
  }
  await expect(windows(page)).toHaveCount(0);
});
test('820px uses 92% cascading and keyboard snap stacks vertically',async({page})=>{
  await page.setViewportSize({width:820,height:1000}); await openThree(page);
  const s=await layout(page); expect(s.map((w:{width:number})=>w.width)).toEqual([754.4,754.4,754.4]);
  expect(s[1].x-s[0].x).toBe(24); expect(s[1].y-s[0].y).toBe(24);
  await windows(page).last().getByRole('button',{name:'창 메뉴'}).click(); await page.getByRole('menuitem',{name:'나란히 뒤쪽'}).click();
  expect((await layout(page)).at(-1)).toMatchObject({x:0,y:500,width:820,height:456});
});
