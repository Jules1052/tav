#!/bin/sh
# Open Tav at http://localhost:8060  (PORT=… to change). Ctrl-C stops it.
# The site is served by the Tav server, so the Tav page can capture data (tav/server.py).
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8060}"; export PORT
URL="http://localhost:$PORT"
# Already running? Just open it.
if curl -fs -m 3 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
  echo "Tav is already running at $URL"; open "$URL/tav-app.html"; exit 0
fi
# An old plain file server on this port has no Tav API: replace it.
OLD=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
if [ -n "$OLD" ]; then
  if ps -p "$OLD" -o command= | grep -q "http.server $PORT"; then
    echo "Stopping the old file server on port $PORT (pid $OLD)…"; kill "$OLD"; sleep 1
  else
    echo "Port $PORT is used by another program (pid $OLD). Stop it, or run: PORT=8061 ./start.sh"; exit 1
  fi
fi
if [ ! -x .venv/bin/python ]; then
  echo "First run: creating .venv with numpy and pillow…"
  python3 -m venv .venv && .venv/bin/pip -q install --upgrade pip && .venv/bin/pip -q install -r tav/requirements.txt || {
    echo "Could not set up Python packages; serving the site without Tav."; cd site && exec python3 -m http.server "$PORT" --bind 127.0.0.1; }
fi
(sleep 1; open "$URL") &
exec .venv/bin/python tav/server.py
