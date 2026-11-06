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
import { Avatar } from '../settings/Avatar.tsx';
import { SETTINGS_ID } from '../settings/id.ts';
import { isTaskWindow, taskSpecOf } from '../tasks/id.ts';
import { TaskCenter } from '../tasks/TaskCenter.tsx';
import { isMemoWindow, memoWindowId } from '../memo/id.ts';
import { memoStore, useMemoInfos } from '../memo/store.ts';
import { docWindowId, isDocWindow, TRASH_ID } from '../doc/id.ts';
import { retain as retainDb } from '../db/store.ts';
import { windows } from '../wm/opener.ts';
import { Preview } from './Preview.tsx';
import './workspace.css';
const TopicGraph=lazy(()=>import('./TopicGraph.tsx').then(m=>({default:m.TopicGraph})));
const SettingsWindow=lazy(()=>import('../settings/SettingsWindow.tsx'));
const TaskDetail=lazy(()=>import('../tasks/TaskDetail.tsx'));
const MemoWindow=lazy(()=>import('../memo/MemoWindow.tsx'));
const DocWindow=lazy(()=>import('../doc/DocWindow.tsx'));
const TrashWindow=lazy(()=>import('../doc/TrashWindow.tsx'));
// Settings, task details, memos, new documents and the trash are not KB records: they never name the address or the page title.
const isLocal=(id:string|undefined)=>id===SETTINGS_ID||id===TRASH_ID||(!!id&&(isTaskWindow(id)||isMemoWindow(id)||isDocWindow(id)));
const stage=()=>({width:innerWidth,height:innerHeight});
const getId=(path:string)=>{const id=path.startsWith('/w/')?decodeURIComponent(path.slice(3)):null;return isLocal(id??undefined)?null:id;};
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
  const top=front(layout), settingsOnTop=top?.id===SETTINGS_ID, taskOnTop=!!top&&isTaskWindow(top.id), memoOnTop=!!top&&isMemoWindow(top.id), docOnTop=!!top&&isDocWindow(top.id), trashOnTop=top?.id===TRASH_ID;
  const memoInfos=useMemoInfos();
  // The address follows the front record window; the settings window is not one.
  const routed=layout.findLast(w=>!w.minimized&&!isLocal(w.id));
  const brief=useNodeBrief(isLocal(top?.id)?undefined:top?.id).data;
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
    const id=routed?.id??null;
    if(id===routeId)return;
    pendingRoute.current=id;
    void navigate({to:routed?'/w/$id':'/',params:routed?{id:routed.id}:{},search:(prev:Record<string,unknown>)=>prev,replace:true,resetScroll:false} as never);
  },[layout,routed?.id,navigate,routeId]);
  useEffect(()=>{
    document.title=settingsOnTop?'loupe · 설정':taskOnTop?'loupe · 작업':memoOnTop?'loupe · 메모':docOnTop?'loupe · 문서':trashOnTop?'loupe · 휴지통':top?(brief?.origin==='first_party'?`loupe · ${recordKind(brief.type)}`:brief?.label?`${brief.label} · loupe`:'loupe'):'loupe';
  },[top?.id,settingsOnTop,taskOnTop,memoOnTop,docOnTop,trashOnTop,brief]);
  useEffect(()=>{const resize=()=>dispatch({type:'fit'});window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[dispatch]);
  const focusAfter=useRef<string|null>(null);
  // Focus follows the opened window (2.7: keys go to the front window). Left on an accessibility-list option, the list stays expanded over the windows' lower corner.
  const openNode=useCallback((id:string,replace=false)=>{setPaletteOpen(false);setActive(null);setHover(null);focusAfter.current=id;dispatch({type:'open',id,replace});},[dispatch]);
  useEffect(()=>{
    const id=focusAfter.current;if(!id)return;
    const el=document.querySelector<HTMLElement>(`[data-testid="wm-window"][data-id="${CSS.escape(id)}"]`);
    if(el){focusAfter.current=null;el.focus({preventScroll:true});}
  },[layout]);
  // A memo, a document or a record being edited with text that is not in the KB asks first (2.7); the window's own buttons close it without asking again.
  const close=useCallback((id:string)=>{if(!memoStore.requestClose(id))return;dispatch({type:'close',id});},[dispatch]);
  const forceClose=useCallback((id:string)=>dispatch({type:'close',id}),[dispatch]);
  const openMemo=useCallback(()=>openNode(memoWindowId(crypto.randomUUID())),[openNode]);
  const openDoc=useCallback(()=>openNode(docWindowId(crypto.randomUUID())),[openNode]);
  const openTrash=useCallback(()=>openNode(TRASH_ID),[openNode]);
  // Windows that are not the shell's own ask it through this (links of a document, "보관", the settings).
  useEffect(()=>{windows.open=openNode;windows.close=forceClose;return()=>{windows.open=()=>undefined;windows.close=()=>undefined;};},[openNode,forceClose]);
  // A closed memo window releases its draft.
  useEffect(()=>{for(const id of memoStore.get().keys())if(!layout.some(w=>w.id===id))memoStore.drop(id);},[layout]);
  // So do the database views of a closed document window: their filter and their save machines.
  useEffect(()=>{retainDb(new Set(layout.map(w=>w.id)));},[layout]);
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
      if(e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.shiftKey&&e.key===','){e.preventDefault();openNode(SETTINGS_ID);return;}
      if(e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.shiftKey&&e.key.toLowerCase()==='m'){e.preventDefault();openMemo();return;}
      if(e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.shiftKey&&e.key.toLowerCase()==='d'){e.preventDefault();openDoc();return;}
      if(e.altKey&&!e.ctrlKey&&!e.metaKey){
        const k=e.key.toLowerCase();
        if(k==='0'){e.preventDefault();dispatch({type:'minimizeAll'});}
        else if(k==='m'&&f){e.preventDefault();dispatch({type:'minimize',id:f.id});}
        else if(k==='w'&&f){e.preventDefault();close(f.id);}
        else if(k==='n'){e.preventDefault();openMemo();}
        else if(e.code==='Backquote'){e.preventDefault();dispatch({type:'cycle',direction:e.shiftKey?-1:1});}
      }
      if(e.key==='Escape'){setPaletteOpen(false);setActive(null);setHover(null);}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[dispatch,moving,close,openNode,openMemo,openDoc]);
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
    <Avatar onOpenSettings={()=>openNode(SETTINGS_ID)}/>
    <TaskCenter onOpen={id=>openNode(id)}/>
    <div className="workspace-tools"><span className="brand" data-testid="brand">loupe</span>
      <button type="button" className="palette-trigger" data-testid="palette-button" onClick={()=>setPaletteOpen(true)}>찾기 <kbd>Ctrl K</kbd></button>
      <button type="button" data-testid="memo-new" title="메모 만들기 (Alt+N)" onClick={openMemo}>＋ 만들기</button>
      <button type="button" data-testid="doc-new" title="문서 만들기 (Ctrl+D)" onClick={openDoc}>＋ 문서</button>
      <button type="button" data-testid="trash-open" title="휴지통" onClick={openTrash}>휴지통</button>
    </div>
    <Palette openNode={openNode} preview={setActive}/>
    <div className="workspace-status"><OfflineBand/>{past&&<TimeBand/>}</div>
    {(hover??active)&&<Preview id={(hover??active)!}/>}
    {/* A minimized window stays mounted, hidden: what is typed in it is not lost (2.7). Only `wm-window` ones count as open. */}
    {[...layout].sort((a,b)=>domOrder(a.id)-domOrder(b.id)).map(w=>{
      const memo=isMemoWindow(w.id), doc=isDocWindow(w.id), trash=w.id===TRASH_ID, mi=memoInfos.get(w.id);
      return <WindowFrame key={w.id} window={w} parked={w.minimized} front={top?.id===w.id} z={10+layout.indexOf(w)} dispatch={dispatch} onClose={()=>close(w.id)} dirty={!!mi?.dirty}
        local={memo?{label:mi?.label??'메모',kind:'메모'}:doc?{label:mi?.label??'문서',kind:'문서'}:trash?{label:'휴지통',kind:'휴지통'}:undefined} onMove={()=>{
        setMoving({id:w.id,before:{x:w.x,y:w.y,width:w.width,height:w.height}});
        document.querySelector<HTMLElement>(`[data-testid="wm-window"][data-id="${CSS.escape(w.id)}"]`)?.focus();
      }}>{w.id===SETTINGS_ID?<Suspense fallback={<p role="status">설정을 읽는 중</p>}><SettingsWindow/></Suspense>:isTaskWindow(w.id)?<Suspense fallback={<p role="status">작업을 읽는 중</p>}><TaskDetail spec={taskSpecOf(w.id)}/></Suspense>:memo?<Suspense fallback={<p role="status">메모를 읽는 중</p>}><MemoWindow id={w.id} onClose={()=>forceClose(w.id)} onOpenSettings={()=>openNode(SETTINGS_ID)}/></Suspense>:doc?<Suspense fallback={<p role="status">문서를 읽는 중</p>}><DocWindow id={w.id} onClose={()=>forceClose(w.id)} onOpenSettings={()=>openNode(SETTINGS_ID)}/></Suspense>:trash?<Suspense fallback={<p role="status">휴지통을 읽는 중</p>}><TrashWindow/></Suspense>:<WindowReadView id={w.id}/>}</WindowFrame>;
    })}
    {layout.some(w=>w.minimized)&&<nav className="window-dock" data-testid="window-dock" aria-label="내린 창">{layout.filter(w=>w.minimized).map(w=><DockChip key={w.id} id={w.id} restore={()=>dispatch({type:'front',id:w.id})} dirty={!!memoInfos.get(w.id)?.dirty} name={memoInfos.get(w.id)?.label}/>)}</nav>}
    <p className="sr-only" aria-live="polite">{top?`${settingsOnTop?'설정':taskOnTop?'작업 상세':memoOnTop?'메모':docOnTop?'문서':trashOnTop?'휴지통':recordKind(brief?.type)} 창, ${layout.length}개 중 1번째`: '열린 창 없음'}</p>
    {moving&&<p role="status" className="move-hint">화살표 이동 · Shift+화살표 크기 · Enter 확정 · Esc 취소</p>}
  </main>;
}
function DockChip({id,restore,dirty,name}:{id:string;restore:()=>void;dirty:boolean;name?:string|undefined}){const n=useNodeBrief(isLocal(id)?undefined:id).data;return <button type="button" onClick={restore}>{id===SETTINGS_ID?'설정':id===TRASH_ID?'휴지통':isTaskWindow(id)?'작업 상세':isMemoWindow(id)?name??'메모':isDocWindow(id)?name??'문서':n?.label??'창 복원'}{dirty?' · 저장 안 됨':''}</button>;}
