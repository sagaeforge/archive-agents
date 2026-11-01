"""빌드 계획 기계 검사: 소유 경로 겹침, 의존 순환, 파동 순서, 표와 절의 일치, 2.3 소유 일치, 소스 분류."""
import re, sys, pathlib, itertools
root = pathlib.Path('/home/<user>/sagae-knowloge-base')
s = (root/'docs/build-plan.md').read_text(encoding='utf-8')
adr = (root/'docs/adr/0001-architecture.md').read_text(encoding='utf-8')
errs = []

# 절 파싱
secs = {}
for m in re.finditer(r'^### (WP-\d\d) ([^\n]+)\n(.*?)(?=^### WP-\d\d |^## \d)', s, re.S | re.M):
    wp, title, body = m.groups()
    dep = re.search(r'\*\*의존\.\*\* ([^\n]*)', body).group(1)
    own = re.search(r'\*\*소유 경로\.\*\* ([^\n]*)', body).group(1)
    paths = re.findall(r'`([^`]+)`', own)
    deps = [] if dep.strip() == '없음' else [d.strip() for d in dep.split(',')]
    accept = body.split('**인수 조건.**')[1] if '**인수 조건.**' in body else ''
    secs[wp] = dict(title=title, deps=deps, paths=paths, accept=accept, body=body)
print('packages', len(secs))

# 표 파싱
tab = {}
for m in re.finditer(r'^\| (WP-\d\d) \| ([^|]+) \| ([^|]+) \|$', s, re.M):
    wp, title, dep = m.groups()
    deps = [] if dep.strip() == '없음' else [d.strip() for d in dep.split(',')]
    tab[wp] = (title.strip(), deps)
if set(tab) != set(secs):
    errs.append(('table/section mismatch', set(tab) ^ set(secs)))
for wp, (t, d) in tab.items():
    if wp in secs and sorted(d) != sorted(secs[wp]['deps']):
        errs.append(('dep mismatch', wp, d, secs[wp]['deps']))
    if wp in secs and t != secs[wp]['title']:
        errs.append(('title mismatch', wp, t, secs[wp]['title']))

# 파동
waves = {}
for m in re.finditer(r'^\| (\d+) \| ((?:WP-\d\d[^|]*?)) \|$', s, re.M):
    n = int(m.group(1))
    for wp in re.findall(r'WP-\d\d', m.group(2)):
        if wp in waves: errs.append(('wave dup', wp))
        waves[wp] = n
if set(waves) != set(secs):
    errs.append(('wave missing', set(secs) ^ set(waves)))
print('waves', max(waves.values()) + 1)
for wp, v in secs.items():
    for d in v['deps']:
        if d not in secs: errs.append(('unknown dep', wp, d))
        elif waves[d] >= waves[wp]: errs.append(('wave order', wp, waves[wp], d, waves[d]))

# 순환
state = {}
def dfs(n, path):
    if state.get(n) == 1: errs.append(('cycle', path + [n])); return
    if state.get(n) == 2: return
    state[n] = 1
    for d in secs[n]['deps']: dfs(d, path + [n])
    state[n] = 2
for wp in secs: dfs(wp, [])

# 소유 경로 겹침(접두 포함)
allp = [(wp, p.rstrip('/'), p.endswith('/')) for wp, v in secs.items() for p in v['paths']]
for (a, pa, da), (b, pb, db) in itertools.combinations(allp, 2):
    if a == b: continue
    if pa == pb or (da and pb.startswith(pa + '/')) or (db and pa.startswith(pb + '/')):
        errs.append(('owner overlap', a, pa, b, pb))
print('owned paths', len(allp))

# 2.3 모듈 소유 대조
owners = {}
for m in re.finditer(r'^\| `(kb\.[a-z_.]+)` \| .*? \| (WP-\d\d) \|$', s, re.M):
    owners[m.group(1)] = m.group(2)
def owns(wp, path):
    for p in secs[wp]['paths']:
        if p.endswith('/') and path.startswith(p): return True
        if p == path: return True
    return False
for mod, wp in owners.items():
    path = 'src/' + mod.replace('.', '/')
    if not (owns(wp, path + '.py') or owns(wp, path + '/') or owns(wp, path + '/__init__.py') or owns(wp, path + '/client.py')):
        errs.append(('module owner', mod, wp))
print('modules', len(owners))

# tick 단계 표의 모듈 소유
for m in re.finditer(r'^\| [\d.]+ [a-z_0-9]+ \| `(src/[^`]+)`[^|]* \| (WP-\d\d) \|$', s, re.M):
    if not owns(m.group(2), m.group(1)):
        errs.append(('stage owner', m.group(1), m.group(2)))

# CLI 스키마 소유
for m in re.finditer(r'(WP-\d\d), `(schemas/cli/[^`]+)`', s):
    if not owns(m.group(1), m.group(2)):
        errs.append(('cli schema owner', m.groups()))

# 인수 조건의 맨 kb (WP-21 제외)
for wp, v in secs.items():
    if wp == 'WP-21': continue
    for line in v['accept'].splitlines():
        if re.match(r'- `(\[[^\]]*\] )?kb ', line):
            errs.append(('bare kb', wp, line[:70]))

# 소스 분류
inv = set()
for f in ('sources-inventory.md', 'sources-inventory-g.md'):
    t = (root/'docs/research'/f).read_text(encoding='utf-8')
    inv |= set(re.findall(r'^\| ([PXDCOUL]\d\d) \|', t, re.M))
print('inventory ids', len(inv))
sec = adr[adr.index('**초기 활성.**'):adr.index('### 10.5 L2 추출')]
act, ina = sec.split('**초기 비활성.**')
def expand(txt):
    out = set()
    for a, b in re.findall(r'([PXDCOUL]\d\d)~([PXDCOUL]\d\d)', txt):
        for i in range(int(a[1:]), int(b[1:]) + 1):
            out.add(f'{a[0]}{i:02d}')
    out |= set(re.findall(r'\b[PXDCOUL]\d\d\b', txt))
    return out
# 표의 첫 칸(활성은 둘째 칸)만 ID로 친다
acts = set()
for row in re.findall(r'^\| ([^|]+) \| ([^|]+) \|', act, re.M):
    acts |= expand(row[1])
inas = set()
for row in re.findall(r'^\| ([^|]+) \|', ina, re.M):
    inas |= expand(row)
print('active-table', len(acts), 'inactive-table', len(inas))
print('neither', sorted(inv - acts - inas))
print('both', sorted(acts & inas))
print('unknown', sorted((acts | inas) - inv))

for e in errs:
    print('ERR', e)
print('errors', len(errs))
