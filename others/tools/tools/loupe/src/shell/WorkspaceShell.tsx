import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useNodeBrief, useRecentlyRecorded, useTopicGraph } from '../data/hooks.ts';
import { Palette } from '../palette/Palette.tsx';
import { setPaletteOpen } from '../palette/store.ts';
import { OfflineBand } from '../app/Status.tsx';
import { TimeBand } from '../app/TimeControls.tsx';
import { useIsPastView } from '../time/useTimeBasis.ts';
import { WindowReadView } from '../wm/WindowReadView.tsx';
import { WindowFrame, recordKind } from '../wm/WindowFrame.tsx';
import { act, decodeLayout, encodeLayout, front, isComposing, LAYOUT_KEY, type Action, type Layout, type Rect } from '../wm/model.ts';
import { Gizmo } from '../graph/gizmo/Gizmo.tsx';
import { useGizmo } from '../graph/gizmo/useGizmo.ts';
import { Preview } from './Preview.tsx';
import './workspace.css';
const TopicGraph=lazy(()=>import('./TopicGraph.tsx').then(m=>({default:m.TopicGraph})));
const stage=()=>({width:innerWidth,height:innerHeight});
const getId=(path:string)=>path.startsWith('/w/')?decodeURIComponent(path.slice(3)):null;
function initial(id:string|null):Layout {
  let saved:Layout=[];
  const reload=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined;
  if(reload?.type==='reload')try{saved=decodeLayout(sessionStorage.getItem(LAYOUT_KEY),stage());}catch{/* storage denied */}
  // Only a reload resumes the session. Following a copied URL always opens one record.
  if(saved.length)return saved;
  return id?act([],{type:'open',id},stage()):[];
}
export function WorkspaceShell(){
  const path=useLocation({select:l=>l.pathname}); const navigate=useNavigate();
  const [layout,setLayout]=useState<Layout>(()=>initial(getId(path)));
  const dispatch=useCallback((a:Action)=>setLayout(s=>act(s,a,stage())),[]);
  const state=useRef(layout);state.current=layout;
  const [active,setActive]=useState<string|null>(null),[hover,setHover]=useState<string|null>(null);
  const hoverTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const onHover=useCallback((id:string|null)=>{if(hoverTimer.current)clearTimeout(hoverTimer.current);hoverTimer.current=setTimeout(()=>setHover(id),id?400:150);},[]);
  useEffect(()=>()=>{if(hoverTimer.current)clearTimeout(hoverTimer.current);},[]);
  const [moving,setMoving]=useState<{id:string;before:Rect}|null>(null);
  const top=front(layout); const brief=useNodeBrief(top?.id).data;
  const graph=useTopicGraph(), latest=useRecentlyRecorded(24), gizmo=useGizmo();
  const routeId=getId(path);
  const lastRoute=useRef(routeId);
  const pendingRoute=useRef<string|null|undefined>(undefined);
  useEffect(()=>{
    if(routeId!==lastRoute.current){
      lastRoute.current=routeId;
      if(routeId!==pendingRoute.current){
        pendingRoute.current=undefined;
        setLayout(routeId?act([],{type:'open',id:routeId},stage()):[]);
        return;
      }
      pendingRoute.current=undefined;
    }
    try{sessionStorage.setItem(LAYOUT_KEY,encodeLayout(layout));}catch{/* storage denied */}
    const id=top?.id??null;
    if(id===routeId)return;
    pendingRoute.current=id;
    void navigate({to:top?'/w/$id':'/',params:top?{id:top.id}:{},search:(prev:Record<string,unknown>)=>prev,replace:true,resetScroll:false} as never);
  },[layout,top?.id,navigate,routeId]);
  useEffect(()=>{
    document.title=top?(brief?.origin==='first_party'?`loupe · ${recordKind(brief.type)}`:brief?.label?`${brief.label} · loupe`:'loupe'):'loupe';
  },[top?.id,brief]);
  useEffect(()=>{const resize=()=>dispatch({type:'fit'});window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[dispatch]);
  const focusAfter=useRef<string|null>(null);
  // Focus follows the opened window (2.7: keys go to the front window). Left on an accessibility-list option, the list stays expanded over the windows' lower corner.
  const openNode=useCallback((id:string,replace=false)=>{setPaletteOpen(false);setActive(null);setHover(null);focusAfter.current=id;dispatch({type:'open',id,replace});},[dispatch]);
  useEffect(()=>{
    const id=focusAfter.current;if(!id)return;
    const el=document.querySelector<HTMLElement>(`[data-testid="wm-window"][data-id="${CSS.escape(id)}"]`);
    if(el){focusAfter.current=null;el.focus({preventScroll:true});}
  },[layout]);
  const close=useCallback((id:string)=>dispatch({type:'close',id}),[dispatch]);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(isComposing(e))return;
      const f=front(state.current);
      if(moving){
        if(e.key==='Escape'){e.preventDefault();dispatch({type:'rect',id:moving.id,rect:moving.before});setMoving(null);return;}
        if(e.key==='Enter'){e.preventDefault();setMoving(null);return;}
        if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
          e.preventDefault();const w=state.current.find(w=>w.id===moving.id);if(!w)return;
          const dx=e.key==='ArrowLeft'?-10:e.key==='ArrowRight'?10:0,dy=e.key==='ArrowUp'?-10:e.key==='ArrowDown'?10:0;
          dispatch({type:'rect',id:w.id,rect:e.shiftKey?{...w,width:w.width+dx,height:w.height+dy}:{...w,x:w.x+dx,y:w.y+dy}});return;
        }
      }
      if(e.altKey&&!e.ctrlKey&&!e.metaKey){
        const k=e.key.toLowerCase();
        if(k==='0'){e.preventDefault();dispatch({type:'minimizeAll'});}
        else if(k==='m'&&f){e.preventDefault();dispatch({type:'minimize',id:f.id});}
        else if(k==='w'&&f){e.preventDefault();close(f.id);}
        else if(e.code==='Backquote'){e.preventDefault();dispatch({type:'cycle',direction:e.shiftKey?-1:1});}
      }
      if(e.key==='Escape'){setPaletteOpen(false);setActive(null);setHover(null);}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[dispatch,moving,close]);
  const past=useIsPastView();
  // The layout array is the z order (back to front). The DOM order stays the order of first sight: re-parenting a window on every
  // fronting would drop focus and the pointer capture of the drag that has just started.
  const seen=useRef(new Map<string,number>());
  for(const w of layout)if(!seen.current.has(w.id))seen.current.set(w.id,seen.current.size);
  const domOrder=(id:string)=>seen.current.get(id)??0;
  return <main className="workspace" data-testid={routeId?'v2-shell':'home'} data-past={past||undefined}
    onClickCapture={e=>{
      const a=(e.target as HTMLElement).closest('a');if(!a||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
      const hash=new URL(a.href,location.href).hash;
      const match=/^#\/node\/([^?]+)/.exec(hash);if(match){e.preventDefault();e.stopPropagation();openNode(decodeURIComponent(match[1]!));}
    }}>
    <Suspense fallback={<p role="status">그래프를 읽는 중</p>}><TopicGraph graph={graph} latest={latest} filter={gizmo.selection} active={active} onActivate={setActive} onHover={onHover} onOpen={openNode}/></Suspense>
    <Gizmo {...gizmo}/>
    <div className="workspace-tools"><span className="brand" data-testid="brand">loupe</span>
      <button type="button" className="palette-trigger" data-testid="palette-button" onClick={()=>setPaletteOpen(true)}>찾기 <kbd>Ctrl K</kbd></button>
      <button type="button" disabled title="메모 쓰기 단계에서 연결">＋ 만들기</button>
    </div>
    <Palette openNode={openNode} preview={setActive}/>
    <div className="workspace-status"><OfflineBand/>{past&&<TimeBand/>}</div>
    {(hover??active)&&<Preview id={(hover??active)!}/>}
    {[...layout].filter(w=>!w.minimized).sort((a,b)=>domOrder(a.id)-domOrder(b.id)).map(w=><WindowFrame key={w.id} window={w} front={top?.id===w.id} z={10+layout.indexOf(w)} dispatch={dispatch} onClose={()=>close(w.id)} onMove={()=>{
      setMoving({id:w.id,before:{x:w.x,y:w.y,width:w.width,height:w.height}});
      document.querySelector<HTMLElement>(`[data-testid="wm-window"][data-id="${CSS.escape(w.id)}"]`)?.focus();
    }}><WindowReadView id={w.id}/></WindowFrame>)}
    {layout.some(w=>w.minimized)&&<nav className="window-dock" data-testid="window-dock" aria-label="내린 창">{layout.filter(w=>w.minimized).map(w=><DockChip key={w.id} id={w.id} restore={()=>dispatch({type:'front',id:w.id})}/>)}</nav>}
    <p className="sr-only" aria-live="polite">{top?`${recordKind(brief?.type)} 창, ${layout.length}개 중 1번째`: '열린 창 없음'}</p>
    {moving&&<p role="status" className="move-hint">화살표 이동 · Shift+화살표 크기 · Enter 확정 · Esc 취소</p>}
  </main>;
}
function DockChip({id,restore}:{id:string;restore:()=>void}){const n=useNodeBrief(id).data;return <button type="button" onClick={restore}>{n?.label??'창 복원'}</button>;}
