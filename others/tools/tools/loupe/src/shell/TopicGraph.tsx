import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { useRecentlyRecorded, useTopicGraph } from '../data/hooks.ts';
import { decodeGraph, mergeGraphs, type GraphData } from '../graph/model.ts';
import { GraphView } from '../graph/view.ts';
import { profileFor, readWebglRenderer } from '../graph/gpuProfile.ts';
import { useGraphLayout } from '../graph/useGraphLayout.ts';
import { AnchorRings } from '../graph/gizmo/AnchorRings.ts';
import { filterGraph, type Selection } from '../graph/gizmo/model.ts';

const ANCHOR_COLOR = '#c4cad3';

// The reads are the shell's: this component loads as a lazy chunk, and a route change must not wait for it before the KB is asked.
export function TopicGraph({graph:{topics,neighbors},latest,filter,active,onActivate,onHover,onOpen}:{filter:Selection;graph:ReturnType<typeof useTopicGraph>;latest:ReturnType<typeof useRecentlyRecorded>;active:string|null;onActivate:(id:string|null)=>void;onHover:(id:string|null)=>void;onOpen:(id:string)=>void}) {
  // `latest` keeps the v1 links available to the existing journey and budget harness.
  const source=JSON.stringify(neighbors.map(q=>q.data?.data));
  const data=useMemo<GraphData>(()=>{
    const base:GraphData={nodes:(topics.data?.data.items??[]).map(n=>({id:n.id,label:n.label,type:n.type,status:n.status})),edges:[]};
    for(const q of neighbors)if(q.data)Object.assign(base,mergeGraphs(base,decodeGraph(q.data.data)));
    return base;
  },[topics.data,source]);
  // The filter only hides what the neighbor queries returned: it asks the KB for nothing (design v2 2.3).
  const {data:shown,anchors}=useMemo(()=>filterGraph(data,filter),[data,filter]);
  const anchorKey=anchors.join(',');
  const host=useRef<HTMLDivElement>(null);
  const [view,setView]=useState<GraphView|null>(null);
  const [error,setError]=useState<string|null>(null);
  const callbacks=useRef({active,onActivate,onHover,onOpen}); callbacks.current={active,onActivate,onHover,onOpen};
  useEffect(()=>{
    if(!host.current)return;
    const renderer=readWebglRenderer();
    if(renderer===null){setError('그래프를 그릴 수 없다. 아래 접근성 목록으로 이동할 수 있다.');return;}
    const v=new GraphView(host.current,profileFor(renderer),{onSelect:id=>{
      if(id&&callbacks.current.active===id)callbacks.current.onOpen(id);else callbacks.current.onActivate(id);
    }});
    v.sigma.on('enterNode',({node})=>callbacks.current.onHover(node));
    v.sigma.on('leaveNode',()=>callbacks.current.onHover(null));
    setView(v);
    if(navigator.webdriver)(window as unknown as {__loupeGraph?:GraphView}).__loupeGraph=v;
    return ()=>{v.kill();setView(null);};
  },[]);
  const {state,revision}=useGraphLayout(view,shown,'topics',0,true);
  useEffect(()=>{if(view&&revision>0){view.select(active);view.setHover(active&&view.graph.hasNode(active)?active:null);}},[view,active,revision]);
  const [rings,setRings]=useState<AnchorRings|null>(null);
  useEffect(()=>{
    if(!view||!host.current)return;
    const r=new AnchorRings(view,host.current);setRings(r);
    return ()=>{r.kill();setRings(null);};
  },[view]);
  useEffect(()=>{
    if(!view||!rings||revision===0)return;
    const ids=anchorKey?anchorKey.split(','):[];
    for(const id of ids)if(view.graph.hasNode(id))view.graph.setNodeAttribute(id,'color',ANCHOR_COLOR);
    rings.set(ids.filter(id=>view.graph.hasNode(id)));
    view.sigma.refresh({skipIndexation:true});
  },[view,rings,revision,anchorKey]);
  // Topics precede all neighbors regardless of the order in a neighbor response.
  const ordered=[...shown.nodes.filter(n=>n.type==='Topic'),...shown.nodes.filter(n=>n.type!=='Topic')];
  return <div className="topic-graph" data-testid="topic-graph" data-layout={state.phase}>
    <div ref={host} className="topic-canvas" data-testid="graph-canvas" />
    {(error||topics.error)&&<p role="status" className="graph-fallback">{error??'주제를 읽을 수 없다.'}</p>}
    <div className="graph-accessibility" role="listbox" aria-label="보이는 노드" data-testid="graph-node-list">
      {ordered.map(n=><button type="button" role="option" aria-selected={active===n.id} data-id={n.id} key={n.id}
        onFocus={()=>onActivate(n.id)} onMouseEnter={()=>onHover(n.id)} onMouseLeave={()=>onHover(null)}
        onClick={()=>active===n.id?onOpen(n.id):onActivate(n.id)}
        onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229){e.preventDefault();onOpen(n.id);}}}>{n.label}</button>)}
    </div>
    <div className="sr-only" aria-label="v1 엔티티 이동">{latest.data?.data.items.map(n=><Link key={n.id} to="/node/$id" params={{id:n.id}} data-testid="home-entity" tabIndex={-1}>{n.label}</Link>)}</div>
  </div>;
}
