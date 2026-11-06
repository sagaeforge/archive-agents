import json,sys
t0=None
for l in open(sys.argv[1]):
    o=json.loads(l); t0=t0 or o['t']; ts=(o['t']-t0)/1000
    if o['ev']=='req': print(f"{ts:7.2f} pid={o['pid']} REQ {o['m']} {o.get('rpc')}")
    elif o['ev']=='res': print(f"{ts:7.2f} pid={o['pid']} RES {o.get('status')} {o.get('ct')}")
    elif o['ev'] in('boot','shutdown','tool','closed','listen-stream-open','listen-stream-closed','mcp-error'): print(f"{ts:7.2f} pid={o['pid']} {o['ev']} {o.get('reason','')} {o.get('msg','')[:100]} {o.get('name','')}")
