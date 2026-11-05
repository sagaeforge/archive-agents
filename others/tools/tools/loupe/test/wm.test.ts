import { describe, expect, it } from 'vitest';
import { act, decodeLayout, encodeLayout, initialLayout, isComposing, type Layout, type Stage } from '../src/wm/model.ts';
import { createKbMock } from '../dev/kb-mock/app.ts';
import { topicFixtures } from '../dev/kb-mock/topics.ts';
const stage: Stage = { width: 1440, height: 900 };
const run = (s: Layout, action: Parameters<typeof act>[1], size = stage) => act(s, action, size);
const three = () => ['e:topic:m0c', 'f-m0c-page', 'f-m0c-note'].reduce((s, id) => run(s, { type: 'open', id }), initialLayout);
describe('window layout contract', () => {
  it('cascades, fronts without duplicates, moves and resizes within bounds', () => {
    let s = three(); expect(s.map(w => w.x)).toEqual([80,104,128]);
    s = run(s, {type:'open',id:s[0]!.id}); expect(s).toHaveLength(3); expect(s.at(-1)!.id).toBe('e:topic:m0c');
    s = run(s, {type:'rect',id:s[0]!.id,rect:{x:-50,y:-100,width:10,height:5}});
    expect(s[0]).toMatchObject({x:0,y:44,width:360,height:240});
    s = run(s, {type:'rect',id:s[0]!.id,rect:{x:2000,y:2000,width:4000,height:3000}});
    expect(s[0]).toMatchObject({x:0,y:44,width:1440,height:812});
  });
  it('snaps, maximizes, restores and stacks at narrow widths', () => {
    let s=three(); const id=s.at(-1)!.id;
    s=run(s,{type:'snap',id,side:'left'}); expect(s.at(-1)).toMatchObject({x:0,width:720});
    s=run(s,{type:'snap',id,side:'right'}); expect(s.at(-1)).toMatchObject({x:720,width:720});
    s=run(s,{type:'maximize',id}); expect(s.at(-1)).toMatchObject({x:0,y:44,width:1440,height:812});
    s=run(s,{type:'maximize',id}); expect(s.at(-1)).toMatchObject({x:720,width:720});
    s=run(s,{type:'snap',id,side:'right'},{width:820,height:1000});
    expect(s.at(-1)).toMatchObject({x:0,y:500,width:820,height:456});
  });
  it('minimizes, restores, cycles both directions and closes', () => {
    let s=three(); const id=s.at(-1)!.id;
    s=run(s,{type:'minimize',id}); expect(s.find(w=>w.id===id)!.minimized).toBe(true);
    s=run(s,{type:'front',id}); expect(s.at(-1)!.minimized).toBe(false);
    s=run(s,{type:'cycle',direction:1}); expect(s.at(-1)!.id).toBe('e:topic:m0c');
    s=run(s,{type:'cycle',direction:-1}); expect(s.at(-1)!.id).toBe(id);
    s=run(s,{type:'minimizeAll'}); expect(s.every(w=>w.minimized)).toBe(true);
    s=run(s,{type:'close',id}); expect(s).toHaveLength(2);
  });
  it('uses 92% width and 24px cascading at 820px', () => {
    const size={width:820,height:1000}; let s:Layout=[];
    for(const id of ['f-a','f-b','f-c']) s=run(s,{type:'open',id},size);
    expect(s.map(w=>w.width)).toEqual([754.4,754.4,754.4]);
    expect(s[1]!.x-s[0]!.x).toBe(24); expect(s[1]!.y-s[0]!.y).toBe(24);
  });
  it('roundtrips layout without titles or bodies and rejects malformed storage', () => {
    const s=run(three(),{type:'minimize',id:'f-m0c-page'});
    const raw=encodeLayout(s.map(w=>({...w,title:'PRIVATE',body:'SECRET'})));
    expect(raw).not.toMatch(/PRIVATE|SECRET|title|body|restore/); expect(decodeLayout(raw,stage)).toEqual(s);
    expect(decodeLayout('broken',stage)).toEqual([]); expect(decodeLayout('[{"id":"../bad"}]',stage)).toEqual([]);
    expect(decodeLayout('[{"id":"f-a","x":0,"y":44,"width":null,"height":240,"minimized":false}]',stage)).toEqual([]);
  });
  it('ignores composition and legacy keyCode 229', () => {
    expect(isComposing({isComposing:true,keyCode:13})).toBe(true);
    expect(isComposing({isComposing:false,keyCode:229})).toBe(true);
    expect(isComposing({isComposing:false,keyCode:13})).toBe(false);
  });
});
describe('additive topic fixtures',()=>{
  it('serves TopicSpec and topic neighbors without changing existing default lists',async()=>{
    const base=createKbMock(); const app=createKbMock({topics:true});
    expect(await (await app.request('/v1/nodes?limit=2')).json()).toEqual(await (await base.request('/v1/nodes?limit=2')).json());
    const topics=await app.request('/v1/nodes?types=Topic'); expect(topics.status).toBe(200);
    expect((await topics.json()).data.items.map((n:{id:string})=>n.id)).toContain(topicFixtures[0]!.id);
    const spec=await app.request('/v1/nodes/f-m0c-spec?include=body,edges'); expect(spec.status).toBe(200);
    expect((await spec.json()).data.type).toBe('TopicSpec');
    const graph=await app.request('/v1/nodes/e:topic:m0c/neighbors'); expect(graph.status).toBe(200);
    expect((await graph.json()).data.nodes.rows.length).toBe(4);
  });
});
