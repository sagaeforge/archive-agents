#!/bin/sh
# 가짜 claude: 인자를 $FAKE_CLAUDE_LOG에 남기고(있으면) 성공한다. 실제 claude를 부르지 않는다.
[ -n "${FAKE_CLAUDE_LOG:-}" ] && echo "$*" >> "$FAKE_CLAUDE_LOG"
exit 0
