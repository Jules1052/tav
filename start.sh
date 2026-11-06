#!/bin/sh
# Open The Hamilton Project at http://localhost:8060  (PORT=… to change). Ctrl-C stops it.
cd "$(dirname "$0")/site" || exit 1
PORT="${PORT:-8060}"
(sleep 1; open "http://localhost:$PORT") &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
