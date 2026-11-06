import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { useRecentlyRecorded, useTopicGraph } from '../data/hooks.ts';
import { decodeGraph, mergeGraphs, type GraphData } from '../graph/model.ts';
import { GraphView } from '../graph/view.ts';
import { LABEL_FONT } from '../graph/overlay.ts';
import { profileFor, readWebglRenderer } from '../graph/gpuProfile.ts';
import { useGraphLayout } from '../graph/useGraphLayout.ts';
import { AnchorRings } from '../graph/gizmo/AnchorRings.ts';
import { filterGraph, type Selection } from '../graph/gizmo/model.ts';
import type { GraphView3D } from '../graph3d/GraphView3D.ts';
import { useAppearance } from '../settings/appearance.ts';

const ANCHOR_COLOR = '#c4cad3';
const BASE_PADDING = 30, PADDING_MARGIN = 4, LABEL_PAD_SHARE = 0.15;

/** Sigma sizes nodes in layout units, so a node's pixel radius follows the canvas size and can pass the stage padding (30 px) that the
 *  outermost nodes sit on, and the canvas box clips them. Grows the padding until every node's disc is inside the box. Each render that
 *  still overflows adds what it overflowed by; the radius shrinks as the padding grows, so this ends in a few frames. */
function keepNodesInside(view: GraphView): () => void {
  const {sigma,graph}=view;
  const measure=document.createElement('canvas').getContext('2d')!;
  measure.font=LABEL_FONT;
  const refit=()=>{
    const {width,height}=sigma.getDimensions();
    let over=0, labelOver=0;
    graph.forEachNode((id,a)=>{
      const p=sigma.graphToViewport({x:a.x as number,y:a.y as number}), r=sigma.scaleSize(a.size as number);
      over=Math.max(over,r-Math.min(p.x,p.y,width-p.x,height-p.y));
      // The label (r + 3 px gap + text + 2 px backing) sits right of the disc, so the right edge needs room for it too.
      labelOver=Math.max(labelOver,p.x+r+3+measure.measureText(String(a.l??'')).width+2-width);
    });
    const pad=sigma.getSetting('stagePadding');
    // Room for labels is bought only while the padding stays within LABEL_PAD_SHARE of the width: beyond that the selector flips a label left or drops it, which costs less than a shrunken graph.
    if(pad+labelOver+PADDING_MARGIN<=width*LABEL_PAD_SHARE)over=Math.max(over,labelOver);
    if(over>0&&pad<Math.min(width,height)/3)sigma.setSetting('stagePadding',Math.ceil(pad+over+PADDING_MARGIN));
  };
  const reset=()=>{if(sigma.getSetting('stagePadding')!==BASE_PADDING)sigma.setSetting('stagePadding',BASE_PADDING);};
  sigma.on('afterRender',refit);
  const ro=new ResizeObserver(reset);
  ro.observe(sigma.getContainer());
  return ()=>{sigma.off('afterRender',refit);ro.disconnect();};
}

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
  const mode=useAppearance().graph;
  const [view,setView]=useState<GraphView|null>(null);
  const [view3,setView3]=useState<GraphView3D|null>(null);
  const [error,setError]=useState<string|null>(null);
  const callbacks=useRef({active,onActivate,onHover,onOpen}); callbacks.current={active,onActivate,onHover,onOpen};
  useEffect(()=>{
    if(mode!=='2d'||!host.current)return;
    const renderer=readWebglRenderer();
    if(renderer===null){setError('그래프를 그릴 수 없다. 아래 접근성 목록으로 이동할 수 있다.');return;}
    const v=new GraphView(host.current,profileFor(renderer),{onSelect:id=>{
      if(id&&callbacks.current.active===id)callbacks.current.onOpen(id);else callbacks.current.onActivate(id);
    }});
    v.sigma.on('enterNode',({node})=>callbacks.current.onHover(node));
    v.sigma.on('leaveNode',()=>callbacks.current.onHover(null));
    const unfit=keepNodesInside(v);
    setView(v);
    if(navigator.webdriver)(window as unknown as {__loupeGraph?:GraphView}).__loupeGraph=v;
    return ()=>{unfit();v.kill();setView(null);};
  },[mode]);
  // 3D is the default (appearance.graph). Its chunk (three) is fetched only when this branch runs, so the 2D setting never downloads it.
  useEffect(()=>{
    if(mode!=='3d'||!host.current)return;
    const el=host.current;
    if(readWebglRenderer()===null){setError('그래프를 그릴 수 없다. 아래 접근성 목록으로 이동할 수 있다.');return;}
    let v:GraphView3D|null=null, gone=false;
    void import('../graph3d/GraphView3D.ts').then(({GraphView3D:View})=>{
      if(gone)return;
      v=new View(el,{
        onSelect:id=>{if(id&&callbacks.current.active===id)callbacks.current.onOpen(id);else callbacks.current.onActivate(id);},
        onHover:id=>callbacks.current.onHover(id),
      });
      setView3(v);
      if(navigator.webdriver)(window as unknown as {__loupeGraph?:GraphView3D}).__loupeGraph=v;
    });
    return ()=>{gone=true;v?.kill();setView3(null);};
  },[mode]);
  // useGraphLayout calls setData, setPositions and graph.order only: GraphView3D has all three, so it stands in for the sigma view there.
  const layoutView=(mode==='3d'?view3:view) as GraphView|null;
  const {state,revision}=useGraphLayout(layoutView,shown,'topics',0,true);
  useEffect(()=>{if(view&&revision>0){view.select(active);view.setHover(active&&view.graph.hasNode(active)?active:null);}},[view,active,revision]);
  useEffect(()=>{if(view3&&revision>0){view3.select(active);view3.setHover(active&&view3.graph.hasNode(active)?active:null);}},[view3,active,revision]);
  useEffect(()=>{if(view3&&revision>0)view3.setAnchors(anchorKey?anchorKey.split(',').filter(id=>view3.graph.hasNode(id)):[]);},[view3,revision,anchorKey]);
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
  return <div className="topic-graph" data-testid="topic-graph" data-layout={state.phase} data-renderer={mode}>
    <div ref={host} className="topic-canvas" data-testid="graph-canvas" />
    {(error||topics.error)&&<p role="status" className="graph-fallback">{error??'주제를 읽을 수 없다.'}</p>}
    {!error&&!topics.error&&topics.data&&topics.data.data.items.length===0&&<p role="status" className="graph-fallback">토픽이 없습니다</p>}
    <div className="graph-accessibility" role="listbox" aria-label="보이는 노드" data-testid="graph-node-list">
      {ordered.map(n=><button type="button" role="option" aria-selected={active===n.id} data-id={n.id} key={n.id}
        onFocus={()=>onActivate(n.id)} onMouseEnter={()=>onHover(n.id)} onMouseLeave={()=>onHover(null)}
        onClick={()=>active===n.id?onOpen(n.id):onActivate(n.id)}
        onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229){e.preventDefault();onOpen(n.id);}}}>{n.label}</button>)}
    </div>
    <div className="sr-only" aria-label="v1 엔티티 이동">{latest.data?.data.items.map(n=><Link key={n.id} to="/node/$id" params={{id:n.id}} data-testid="home-entity" tabIndex={-1}>{n.label}</Link>)}</div>
  </div>;
}
