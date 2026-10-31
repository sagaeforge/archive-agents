#!/bin/bash
# usage: orca-shot.sh <page> <out.png>
orca-ide screenshot --format ${3:-jpeg} --page "$1" --json </dev/null > /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s3-graph/out/shot.json 2>&1
node -e '
const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1]));const r=j.result||{};
const data=r.data||r.base64||r.screenshot||(r.image&&r.image.data);
if(!data){console.log(JSON.stringify(j).slice(0,400));process.exit(1)}
fs.writeFileSync(process.argv[2],Buffer.from(data,"base64"));console.log("saved",process.argv[2],fs.statSync(process.argv[2]).size)' /tmp/claude-1000/-home-sagae-sagae-tools/02a1e6e4-8e47-4124-a5b3-6286b9153cd2/scratchpad/spikes/s3-graph/out/shot.json "$2"
