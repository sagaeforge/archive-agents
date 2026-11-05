// Opt-in M0c data; existing v1 fixtures and responses remain byte-for-byte unchanged.
import type { NodeDetail } from '../../src/client/model/index.ts';
const common={origin:'first_party',sensitivity:'internal',status:'active',version:1,recorded_at:'2026-01-01T00:00:00Z',valid:{from:null,to:null},domain:[],props:{},claims:[],edges:{in:[],out:[],truncated:false},backlinks:[]} satisfies Partial<NodeDetail>;
export const topicFixtures:NodeDetail[]=[
  {...common,id:'e:topic:m0c',type:'Topic',label:'M0c 작업 공간',props:{state:'active'}},
  {...common,id:'f-m0c-spec',type:'TopicSpec',label:'M0c 주제 범위',body:'작업 공간과 창 관리자를 조사한다.',props:{slug:'m0c',aliases:['작업 공간'],export_llm:false,export_query:false}},
  {...common,id:'f-m0c-page',type:'Page',label:'M0c 비공개 문서 제목',body:'# 작업 공간\n문서를 창에서 읽는다.'},
  {...common,id:'f-m0c-note',type:'Note',label:'M0c 비공개 메모 제목',body:'창 배치를 기억한다.\n제목과 본문은 저장하지 않는다.'},
];
export const topicEdges=[
  {id:'r-m0c-defines',src:'f-m0c-spec',dst:'e:topic:m0c',rtype:'DEFINES',status:'active'},
  {id:'r-m0c-page',src:'f-m0c-page',dst:'e:topic:m0c',rtype:'IN_TOPIC',status:'active'},
  {id:'r-m0c-note',src:'f-m0c-note',dst:'e:topic:m0c',rtype:'IN_TOPIC',status:'active'},
];
