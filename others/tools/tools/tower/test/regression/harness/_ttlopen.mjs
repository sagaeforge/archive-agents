import { P as TT_P } from './env.mjs';
import { open, outcome } from './lib.mjs';
const url=`http://127.0.0.1:${TT_P.undefined}/mcp`, bearer='s1-spike-throwaway-key';
const s=await open(url,'legacy',bearer);
console.log('session',s.session?.slice(0,12), outcome(await s.call('tools/list')));
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({session:s.session, v:s.negotiated}));
