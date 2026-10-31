import net from 'node:net';
const t=performance.now(); const s=net.connect({host:'127.0.0.1',port:18206, timeout:0});
const done=(w)=>{console.log(JSON.stringify({w, ms:Math.round(performance.now()-t)}));process.exit(0)};
s.on('connect',()=>done('connect')); s.on('error',e=>done(e.code));
