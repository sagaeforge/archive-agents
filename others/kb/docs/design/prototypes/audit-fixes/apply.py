"""spec 파일의 (old, new[, count]) 목록을 순서대로 적용한다. 하나라도 어긋나면 파일을 쓰지 않는다."""
import sys, runpy, pathlib
spec = runpy.run_path(sys.argv[1])
F = pathlib.Path(spec['FILE'])
s = F.read_text(encoding='utf-8')
errs = []
for i, item in enumerate(spec['R']):
    old, new = item[0], item[1]
    n = item[2] if len(item) > 2 else 1
    c = s.count(old)
    if c != n:
        errs.append((i, c, old[:90]))
        continue
    s = s.replace(old, new)
if errs:
    for e in errs:
        print('ERR', e)
    sys.exit(1)
F.write_text(s, encoding='utf-8')
print('ok', F.name, len(spec['R']), 'edits', len(s), 'chars')
