// Opt-in M0d data: a second topic whose neighbors cover all five filter axes (topic, document, knowledge, memo, secret object name).
// The M0c topic and its responses in topics.ts stay as they were.
import type { NodeDetail } from '../../src/client/model/index.ts';
const common={origin:'first_party',sensitivity:'internal',status:'active',version:1,recorded_at:'2026-01-01T00:00:00Z',valid:{from:null,to:null},domain:[],props:{},claims:[],edges:{in:[],out:[],truncated:false},backlinks:[]} satisfies Partial<NodeDetail>;
export const gizmoFixtures:NodeDetail[]=[
  {...common,id:'e:topic:m0d',type:'Topic',label:'M0d 필터 점검',props:{state:'active'}},
  {...common,id:'f-m0d-spec',type:'TopicSpec',label:'M0d 주제 범위',body:'그래프 필터를 조사한다.',props:{slug:'m0d',aliases:['필터 점검'],export_llm:false,export_query:false}},
  {...common,id:'f-m0d-page',type:'Page',label:'M0d 문서 제목',body:'# 필터\n축 다섯.'},
  {...common,id:'f-m0d-note',type:'Note',label:'M0d 메모 제목',body:'필터를 기억한다.'},
  {...common,origin:'external',id:'e:tool:m0d-sigma',type:'Tool',label:'M0d 시그마',props:{}},
  // A secret object is a name only. KMS is not a KB source yet, so this stands in for the lock node a document's security block will name.
  {...common,id:'s-m0d-token',type:'Secret',label:'M0d 토큰 이름',sensitivity:'secret'},
];
export const gizmoEdges=[
  {id:'r-m0d-defines',src:'f-m0d-spec',dst:'e:topic:m0d',rtype:'DEFINES',status:'active'},
  {id:'r-m0d-page',src:'f-m0d-page',dst:'e:topic:m0d',rtype:'IN_TOPIC',status:'active'},
  {id:'r-m0d-note',src:'f-m0d-note',dst:'e:topic:m0d',rtype:'IN_TOPIC',status:'active'},
  {id:'r-m0d-entity',src:'e:tool:m0d-sigma',dst:'e:topic:m0d',rtype:'IN_TOPIC',status:'active'},
  {id:'r-m0d-page-entity',src:'f-m0d-page',dst:'e:tool:m0d-sigma',rtype:'MENTIONS',status:'active'},
  {id:'r-m0d-page-secret',src:'f-m0d-page',dst:'s-m0d-token',rtype:'USES_SECRET',status:'active'},
];
