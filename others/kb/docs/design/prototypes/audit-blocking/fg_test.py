import ipaddress, socket, sys, threading, time, json
sys.path.insert(0, sys.argv[1])
import fg
cases=[("file:///etc/passwd","scheme"),("http://example.com/","scheme"),("ftp://example.com/","scheme"),("https://user:<EMAIL>/","userinfo"),("https://127.0.0.1/","addr"),("https://localhost/","addr"),("https://[::1]/","addr"),("https://[::ffff:127.0.0.1]/","addr"),("https://2130706433/","addr"),("https://0x7f.0.0.1/","addr"),("https://169.254.169.254/latest/meta-data/","addr"),("https://10.x.x.x/","addr"),("https://192.0.2.1/","addr"),("https://172.x.x.x/","addr"),("https://example.com:8443/","port")]
ok=0
for u,w in cases:
    try: fg.safe_fetch(u,timeout=3); print("NOT BLOCKED",u)
    except fg.Blocked as e: ok+=str(e).startswith(w)
    except Exception as e: print("OTHER",u,type(e).__name__,e)
print("15건 차단:",ok,"/",len(cases))
print("--- is_global 경계(연결은 하지 않는다)")
for a in ["::7f00:1","::ffff:7f00:1","64:ff9b::7f00:1","64:ff9b::a00:1","2002:7f00:1::1","2002:a00:1::1","2001:0:4136:e378:8000:63bf:3fff:fdd2","fec0::1","100.64.0.1","192.0.0.1","198.18.0.1","240.0.0.1","224.0.0.1","0.0.0.0","192.88.99.1","2001:db8::1","ff02::1"]:
    ip=ipaddress.ip_address(a); m=getattr(ip,"ipv4_mapped",None); print(f"{a:40} {'global' if (m or ip).is_global else 'blocked'}")
print("--- 느린 응답 총 시간: 소켓당 시간 제한만 있는가")
srv=socket.socket(); srv.bind(("127.0.0.1",0)); srv.listen(1); port=srv.getsockname()[1]
def serve():
    c,_=srv.accept(); c.recv(4096); c.send(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
    try:
        for i in range(10): c.send(b"x"); time.sleep(0.5)
        c.send(b"y"*90)
    except OSError: pass
    c.close()
threading.Thread(target=serve,daemon=True).start()
# TLS만 뺀다. 본문을 읽는 루프와 소켓 시간 제한은 프로토타입 그대로다
fg.check_host=lambda h,p:(socket.AF_INET,("127.0.0.1",port))
import http.client
def plain_connect(self):
    fam,sa=self.pinned; s=socket.socket(fam,socket.SOCK_STREAM); s.settimeout(self.timeout); s.connect(sa); self.sock=s
fg.PinnedHTTPS.connect=plain_connect
t=time.perf_counter(); r=fg.safe_fetch("https://slow.test/",timeout=1); print("timeout=1초인데 소요",round(time.perf_counter()-t,2),"초",r["status"],r["bytes"])
