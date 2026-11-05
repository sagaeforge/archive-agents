import { lazy, Suspense, useState } from 'react';
import { WindowTitleScope } from '../app/useScreenTitle.ts';
import { EntityScreen } from '../entity/NodeScreen.tsx';
import { ClaimScreen } from '../entity/ClaimScreen.tsx';
import { useNodeBrief } from '../data/hooks.ts';
import { classifyId } from '../ids.ts';
// The editor is its own chunk: it is fetched when a window switches to editing, never with the first screen (design v2 4.2 item 5).
const EditorWindow = lazy(() => import('../editor/EditorWindow.tsx'));
/** Reuse the v1 read screen, including safe Markdown, evidence and paginated body reads. First-party records can switch the window to the editor. */
export function WindowReadView({id}:{id:string}) {
  const claim=classifyId(id)==='claim';
  const [editing,setEditing]=useState(false);
  const editable=useNodeBrief(claim?undefined:id).data?.origin==='first_party';
  return <WindowTitleScope value={true}>
    {editable&&<div className="window-mode"><button type="button" aria-pressed={editing} data-testid="window-edit-toggle" onClick={()=>setEditing(!editing)}>{editing?'읽기':'편집'}</button></div>}
    {editable&&editing?<Suspense fallback={<p role="status">편집기를 읽는 중</p>}><EditorWindow id={id}/></Suspense>
      :claim?<ClaimScreen id={id}/>:<EntityScreen id={id} windowed/>}
  </WindowTitleScope>;
}
