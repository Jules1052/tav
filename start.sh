#!/bin/sh
# Open The Hamilton Project at http://localhost:8060  (PORT=… to change). Ctrl-C stops it.
# The site is served by the Tav server, so the Tav page can capture data (tav/server.py).
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8060}"; export PORT
if [ ! -x .venv/bin/python ]; then
  echo "First run: creating .venv with numpy and pillow…"
  python3 -m venv .venv && .venv/bin/pip -q install --upgrade pip && .venv/bin/pip -q install -r tav/requirements.txt || {
    echo "Could not set up Python packages; serving the site without Tav."; cd site && exec python3 -m http.server "$PORT" --bind 127.0.0.1; }
fi
(sleep 1; open "http://localhost:$PORT") &
exec .venv/bin/python tav/server.py
