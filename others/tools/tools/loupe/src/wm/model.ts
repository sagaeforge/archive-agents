import { parseKbId } from '../ids.ts';
export type Stage = { width:number; height:number };
export type Rect = { x:number; y:number; width:number; height:number };
export type WindowState = Rect & { id:string; minimized:boolean; restore?:Rect };
/** Array order is back to front; no titles, bodies or query text are persisted. */
export type Layout = WindowState[];
export const initialLayout:Layout=[];
export const LAYOUT_KEY='loupe.windows.v2';
export type Action = {type:'open';id:string;replace?:boolean} | {type:'front'|'close'|'minimize'|'maximize';id:string} | {type:'minimizeAll'} | {type:'cycle';direction:1|-1} | {type:'rect';id:string;rect:Rect} | {type:'snap';id:string;side:'left'|'right'} | {type:'fit'};
export const isComposing=(e:{isComposing?:boolean;keyCode?:number})=>!!e.isComposing||e.keyCode===229;
export function bound(r:Rect,s:Stage):Rect {
  const width=Math.min(Math.max(360,r.width),s.width), height=Math.min(Math.max(240,r.height),Math.max(240,s.height-88));
  return {width,height,x:Math.max(0,Math.min(r.x,s.width-width)),y:Math.max(44,Math.min(r.y,s.height-44-height))};
}
export const front=(s:Layout)=>s.findLast(w=>!w.minimized);
export function act(s:Layout,a:Action,stage:Stage):Layout {
  if(a.type==='fit') return s.map(w=>({...w,...bound(w,stage)}));
  if(a.type==='minimizeAll') return s.map(w=>({...w,minimized:true}));
  if(a.type==='cycle') {
    const visible=s.filter(w=>!w.minimized); if(visible.length<2)return s;
    const w=a.direction===1?visible[0]!:visible.at(-2)!;
    return act(s,{type:'front',id:w.id},stage);
  }
  const w=s.find(w=>w.id===a.id);
  if(a.type==='open') {
    if(!parseKbId(a.id).ok)return s;
    if(w)return act(s,{type:'front',id:a.id},stage);
    const prev=front(s), narrow=stage.width>=600&&stage.width<1024;
    const rect=bound({x:prev?prev.x+24:narrow?stage.width*.04:80,y:prev?prev.y+24:68,width:narrow?stage.width*.92:640,height:Math.min(520,stage.height-140)},stage);
    const base=a.replace&&front(s)?s.filter(w=>w.id!==front(s)!.id):s;
    return [...base,{id:a.id,...rect,minimized:false}];
  }
  if(!w)return s;
  if(a.type==='close')return s.filter(w=>w.id!==a.id);
  if(a.type==='front')return [...s.filter(w=>w.id!==a.id),{...w,minimized:false}];
  return s.map(v=>{
    if(v.id!==a.id)return v;
    if(a.type==='minimize')return {...v,minimized:true};
    if(a.type==='rect')return {id:v.id,minimized:v.minimized,...bound(a.rect,stage)};
    if(a.type==='maximize')return v.restore?{id:v.id,minimized:v.minimized,...bound(v.restore,stage)}:{...v,restore:{x:v.x,y:v.y,width:v.width,height:v.height},x:0,y:44,width:stage.width,height:stage.height-88};
    if(a.type==='snap'){
      const narrow=stage.width<1024;
      return {id:v.id,minimized:v.minimized,...bound(narrow?{x:0,y:a.side==='left'?44:stage.height/2,width:stage.width,height:(stage.height-88)/2}:{x:a.side==='left'?0:stage.width/2,y:44,width:stage.width/2,height:stage.height-88},stage)};
    }
    return v;
  });
}
export const encodeLayout=(s:Layout)=>JSON.stringify(s.map(({id,x,y,width,height,minimized})=>({id,x,y,width,height,minimized})));
export function decodeLayout(raw:string|null,stage:Stage):Layout {
  try{
    const rows:unknown=JSON.parse(raw??'[]'); if(!Array.isArray(rows))return [];
    const ids=new Set<string>(); const out:Layout=[];
    for(const r of rows){
      if(!r||typeof r.id!=='string'||!parseKbId(r.id).ok||ids.has(r.id)||typeof r.minimized!=='boolean'||!['x','y','width','height'].every(k=>typeof r[k]==='number'&&Number.isFinite(r[k])))continue;
      ids.add(r.id); out.push({id:r.id,...bound(r,stage),minimized:r.minimized});
    }
    return out;
  }catch{return [];}
}
