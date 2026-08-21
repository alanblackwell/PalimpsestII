#!/bin/bash
# Serves the committed docs/ build locally (same bytes as GitHub Pages) and
# opens it in the default browser. Safe to run repeatedly — reuses an
# already-running server on PORT instead of starting a second one.
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8743
URL="http://localhost:${PORT}/PalimpsestII/"

if ! /usr/sbin/lsof -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  cd "${REPO_DIR}"
  nohup /usr/bin/python3 -m http.server "${PORT}" \
    > /tmp/palimpsest-local-server.log 2>&1 &
  disown
  # give the server a moment to bind before opening the browser
  for i in 1 2 3 4 5 6 7 8 9 10; do
    /usr/sbin/lsof -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1 && break
    sleep 0.3
  done
fi

open "${URL}"
