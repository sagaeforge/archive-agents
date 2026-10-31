#!/bin/bash
exec python3 -c "import time,sys; time.sleep(int(sys.argv[1]))" "$1"
