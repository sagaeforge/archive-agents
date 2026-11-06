"""stdio JSON-RPC 탐침. 기동 시간, 동시 처리, 격리 여부를 잰다."""
import json, os, subprocess, sys, threading, time

py, srv = sys.argv[1], sys.argv[2]
extra = sys.argv[3:]


def start():
    t0 = time.perf_counter()
    p = subprocess.Popen([py, "-I", srv, *extra], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, env={"PATH": "/usr/bin:/bin", "HOME": os.environ["HOME"], "FASTMCP_LOG_LEVEL": "ERROR"})
    return p, t0


def send(p, obj):
    p.stdin.write((json.dumps(obj) + "\n").encode())


def recv(p):
    while True:
        line = p.stdout.readline()
        if not line:
            return None
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue


def handshake(p):
    send(p, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "probe", "version": "0"}}})
    r = recv(p)
    send(p, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    return r


lat = []
for _ in range(8):
    p, t0 = start()
    r = handshake(p)
    lat.append(time.perf_counter() - t0)
    p.terminate()
    p.wait()
lat.sort()
print("cold initialize s:", [round(x, 3) for x in lat], "proto", r["result"]["protocolVersion"], "instr", bool(r["result"].get("instructions")))
p, t0 = start()
handshake(p)
send(p, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
r = recv(p)
print("tools/list bytes", len(json.dumps(r, ensure_ascii=False)), "outputSchema", [("outputSchema" in t) for t in r["result"]["tools"]])
send(p, {"jsonrpc": "2.0", "id": 3, "method": "resources/templates/list"})
print("templates", [t.get("uriTemplate") for t in recv(p)["result"].get("resourceTemplates", [])])
send(p, {"jsonrpc": "2.0", "id": 30, "method": "tools/call", "params": {"name": "kb_search", "arguments": {"q": "x"}}})
r = recv(p)
print("result keys", list(r["result"].keys()), "content", r["result"]["content"][0]["type"])


def probe(tool):
    """느린 호출 도중 ping 왕복 시간."""
    send(p, {"jsonrpc": "2.0", "id": 100, "method": "tools/call", "params": {"name": tool, "arguments": {"ms": 400}}})
    time.sleep(0.05)
    t = time.perf_counter()
    send(p, {"jsonrpc": "2.0", "id": 101, "method": "ping"})
    got = {}
    order = []
    while len(got) < 2:
        m = recv(p)
        if "id" in m:
            got[m["id"]] = time.perf_counter() - t
            order.append(m["id"])
    return round(got[101] * 1e3, 1), round(got[100] * 1e3, 1), order


print("sync def tool: ping_ms, tool_ms, order", probe("kb_slow"))
print("async blocking: ping_ms, tool_ms, order", probe("kb_slow_async_blocking"))
t = []
for i in range(200):
    a = time.perf_counter()
    send(p, {"jsonrpc": "2.0", "id": 1000 + i, "method": "tools/call", "params": {"name": "kb_search", "arguments": {"q": "x"}}})
    recv(p)
    t.append((time.perf_counter() - a) * 1e3)
t.sort()
print("call p50/p95 ms", round(t[100], 2), round(t[190], 2))
pid = p.pid
rss = pss = 0
for line in open(f"/proc/{pid}/smaps_rollup"):
    if line.startswith("Pss:"):
        pss = int(line.split()[1])
    if line.startswith("Rss:"):
        rss = int(line.split()[1])
print("RSS MB", rss // 1024, "PSS MB", pss // 1024)
p.terminate()
