import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useNodeBrief } from '../data/hooks.ts';
import { SETTINGS_ID } from '../settings/id.ts';
import { isTaskWindow } from '../tasks/id.ts';
import type { Action, Rect, WindowState } from './model.ts';
export const recordKind=(type:string|undefined)=>({Page:'문서',Note:'메모',TopicSpec:'주제',Topic:'주제'}[type??'']??'엔티티');
/** `local`: a window that is not a KB record (the memo window): its own name and kind, and no read of the KB for them.
 *  `parked`: the window is minimized. It stays mounted, hidden, so what is typed in it is not lost; it is not a `wm-window` while parked. */
type Props={window:WindowState;front:boolean;z:number;dispatch:(a:Action)=>void;onMove:()=>void;children:ReactNode;dirty?:boolean;onClose:()=>void;local?:{label:string;kind:string};parked?:boolean};
export function WindowFrame({window:w,front,z,dispatch,onMove,children,dirty=false,onClose,local,parked=false}:Props){
  const settings=w.id===SETTINGS_ID, task=isTaskWindow(w.id);
  const n=useNodeBrief(settings||task||local?undefined:w.id).data;
  const [menu,setMenu]=useState(false);
  const gesture=useRef<{x:number;y:number;rect:Rect;edge:string;ready:number}|null>(null);
  const begin=(e:PointerEvent<HTMLElement>,edge:string)=>{
    if(e.button!==0 || (e.target as HTMLElement).closest('button,a,input'))return;
    e.preventDefault();dispatch({type:'front',id:w.id});
    gesture.current={x:e.clientX,y:e.clientY,rect:{x:w.x,y:w.y,width:w.width,height:w.height},edge,ready:performance.now()+(e.pointerType==='touch'&&!edge?350:0)};
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move=(e:PointerEvent<HTMLElement>)=>{
    const g=gesture.current;if(!g||performance.now()<g.ready)return;
    const dx=e.clientX-g.x,dy=e.clientY-g.y; const r={...g.rect};
    if(!g.edge){r.x+=dx;r.y+=dy;}
    if(g.edge.includes('e'))r.width+=dx;
    if(g.edge.includes('s'))r.height+=dy;
    if(g.edge.includes('w')){const d=Math.min(dx,g.rect.width-360);r.x+=d;r.width-=d;}
    if(g.edge.includes('n')){const d=Math.min(dy,g.rect.height-240);r.y+=d;r.height-=d;}
    dispatch({type:'rect',id:w.id,rect:r});
  };
  const end=(e:PointerEvent<HTMLElement>)=>{
    const g=gesture.current;gesture.current=null;
    if(!g||g.edge||performance.now()<g.ready)return;
    if(Math.hypot(e.clientX-g.x,e.clientY-g.y)<3)return;
    if(e.clientY<=44)dispatch({type:'maximize',id:w.id});
    else if(e.clientX<=12)dispatch({type:'snap',id:w.id,side:'left'});
    else if(e.clientX>=innerWidth-12)dispatch({type:'snap',id:w.id,side:'right'});
  };
  const pointer={onPointerMove:move,onPointerUp:end,onPointerCancel:()=>{const g=gesture.current;gesture.current=null;if(g)dispatch({type:'rect',id:w.id,rect:g.rect});}};
  return <section role="region" aria-label={`${settings?'설정':task?'작업 상세':local?local.kind:recordKind(n?.type)} 창`} tabIndex={-1} className="wm-window" data-testid={parked?'wm-parked':'wm-window'} data-id={w.id} data-front={front&&!parked}
    aria-hidden={parked||undefined} style={{left:w.x,top:w.y,width:w.width,height:w.height,zIndex:z,...(parked?{display:'none'}:{})}}
    onPointerDownCapture={()=>{if(!front)dispatch({type:'front',id:w.id});}}
    onFocusCapture={()=>{if(!front)dispatch({type:'front',id:w.id});}}>
    <div className="wm-titlebar" data-testid="wm-titlebar" onPointerDown={e=>begin(e,'')} {...pointer} onDoubleClick={e=>{if(!(e.target as HTMLElement).closest('button'))dispatch({type:'maximize',id:w.id});}}>
      <span dir="auto">{settings?'설정':task?'작업 상세':local?local.label:n?.label??recordKind(n?.type)}{dirty?' · 저장 안 됨':''}</span>
      <button type="button" aria-label="창 메뉴" onClick={()=>setMenu(!menu)}>⋯</button>
      <button type="button" aria-label="내리기" onClick={()=>dispatch({type:'minimize',id:w.id})}>−</button>
      <button type="button" aria-label={w.restore?'복원':'최대화'} onClick={()=>dispatch({type:'maximize',id:w.id})}>□</button>
      <button type="button" aria-label="닫기" onClick={onClose}>×</button>
    </div>
    {menu&&<div role="menu" aria-label="창 메뉴" className="wm-menu" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setMenu(false);}}}>
      <button type="button" role="menuitem" autoFocus onClick={()=>{setMenu(false);onMove();}}>이동·크기</button>
      <button type="button" role="menuitem" onClick={()=>{setMenu(false);dispatch({type:'snap',id:w.id,side:'left'});}}>나란히 앞쪽</button>
      <button type="button" role="menuitem" onClick={()=>{setMenu(false);dispatch({type:'snap',id:w.id,side:'right'});}}>나란히 뒤쪽</button>
      <button type="button" role="menuitem" onClick={()=>{setMenu(false);dispatch({type:'maximize',id:w.id});}}>최대화·복원</button>
    </div>}
    <div className="wm-content">{children}</div>
    {['n','ne','e','se','s','sw','w','nw'].map(edge=><div key={edge} aria-hidden className={`wm-grip grip-${edge}`} data-resize={edge} onPointerDown={e=>begin(e,edge)} {...pointer}/>)}
  </section>;
}
