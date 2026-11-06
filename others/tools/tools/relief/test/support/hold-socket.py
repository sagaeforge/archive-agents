#!/usr/bin/env python3
"""Plays systemd's part: holds a listening socket across server lives and hands it over as fd 3.

Reads commands from stdin: `start` spawns the server, `stop` sends SIGTERM and waits. The server argv comes after `--`.
Prints `port N`, then `started PID` and `stopped CODE`.
"""
import os, signal, socket, subprocess, sys

argv = sys.argv[sys.argv.index('--') + 1:]
s = socket.socket()
s.bind(('127.0.0.1', 0))
s.listen(16)
os.dup2(s.fileno(), 3)
os.set_inheritable(3, True)
print('port', s.getsockname()[1], flush=True)
child = None
for line in sys.stdin:
    cmd = line.strip()
    if cmd == 'start':
        env = dict(os.environ, LISTEN_FDS='1')
        child = subprocess.Popen(['sh', '-c', 'LISTEN_PID=$$ exec "$@"', 'sh', *argv], env=env, pass_fds=(3,), stdout=subprocess.DEVNULL)
        print('started', child.pid, flush=True)
    elif cmd == 'stop' and child:
        child.send_signal(signal.SIGTERM)
        print('stopped', child.wait(), flush=True)
        child = None
if child:
    child.kill()
