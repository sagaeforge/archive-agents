// Fire exactly one modern request and report. usage: modern1.mjs <url> <bearer|-> <method> [nameOrUri]
const [url, bearer, method, name] = process.argv.slice(2);
const meta = {'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'one',version:'0'},'io.modelcontextprotocol/clientCapabilities':{}};
const params = {_meta: meta};
if (method==='tools/call') { params.name=name; params.arguments={}; }
if (method==='resources/read') params.uri=name;
const h={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':method};
if(name) h['mcp-name']=name;
if(bearer!=='-') h.authorization=`Bearer ${bearer}`;
const t0=performance.now();
const res=await fetch(url,{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
const text=await res.text();
console.log(res.status,(performance.now()-t0).toFixed(1)+'ms',text.replace(/\s+/g,' ').slice(0,160));
