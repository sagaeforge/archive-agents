import sys; sys.path.insert(0,"<SCRATCHPAD>/audit/blocking")
import fg
for u,kw in (("https://code.claude.com/docs/llms.txt",{}),("https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md",{"max_bytes":65536}),("https://github.com/anthropics/claude-code/releases.atom",{}),("https://docs.anthropic.com/en/docs/claude-code/overview",{})):
    try:
        r=fg.safe_fetch(u,**kw); print(r["status"],r["bytes"],r["ctype"],[c[1] for c in r["chain"]],u)
    except Exception as e: print(type(e).__name__,str(e)[:100],u)
