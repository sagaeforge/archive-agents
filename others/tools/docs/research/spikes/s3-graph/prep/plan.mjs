import fs from 'node:fs';
const cells=[];
for(const s of ['1k','5k','full']){cells.push(`v=A&size=${s}&K=200&tech=fill`,`v=A0&size=${s}`,`v=B&size=${s}`)}
const F='size=full';
cells.push(`v=Adef&${F}`,`v=A&${F}&K=200&tech=canvas`,`v=A&${F}&K=200&tech=dom`,`v=A&${F}&K=200&tech=fillbg`,`v=A&${F}&K=200&tech=sprite`,`v=A&${F}&K=100&tech=fill`,`v=A&${F}&K=400&tech=fill`,`v=A&${F}&K=200&tech=fill&dash=1`,`v=A0&${F}&dash=1`,`v=B0&${F}`,`v=A&${F}&K=200&tech=fill&hm=partial`,`v=A&${F}&K=200&tech=fill&hm=all`,`v=B&${F}&hm=partial`,`v=B&${F}&hm=all`,`v=A&${F}&ds=community&K=200&tech=fill`,`v=A0&${F}&ds=community`,`v=B&${F}&ds=community`,`v=A&${F}&ds=community&K=200&tech=fill&dash=1`);
let seed=12345;const R=()=>(seed=(seed*16807)%2147483647)/2147483647;
const plan=[];for(let r=0;r<3;r++){const c=cells.slice();for(let i=c.length-1;i>0;i--){const j=Math.floor(R()*(i+1));[c[i],c[j]]=[c[j],c[i]]}plan.push(`mode=bench&v=N&rep=${r}`,...c.map(x=>`mode=bench&${x}&rep=${r}`))}
fs.writeFileSync(process.argv[2],JSON.stringify(plan));console.log(plan.length);
