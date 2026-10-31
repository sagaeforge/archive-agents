#!/bin/bash
cd "$(dirname "$0")"
REC="v=A&ds=s5&K=200&tech=fillbg&nolabel=1&dash=1&hm=partial&ec=solid"
./run-cell.sh "mode=gltest&tag=pre" 60
for rep in 0 1; do for s in 20k 50k sub10k; do
  UA=0; [ $rep = 0 ] && UA=1
  echo "$(date +%T) load=$(cut -d' ' -f1 /proc/loadavg) gpu=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader)"
  ./run-cell.sh "mode=bench&$REC&size=$s&rep=$rep&ua=$UA" 300
done; done
./run-cell.sh "mode=gltest&tag=post" 60
echo ALLDONE
