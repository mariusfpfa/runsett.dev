#!/bin/sh
# Open the local studio from Finder, or start it if it is not already running.
set -eu
cd "$(dirname "$0")"
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
studio_url="http://localhost:${RUNSETT_STUDIO_PORT:-4310}"
if curl -fsS --max-time 2 "$studio_url/" 2>/dev/null | grep -Fq '<title>Runsett Studio</title>'; then
  exec open "$studio_url"
fi
if [ -d /Applications/Docker.app ] && ! docker info >/dev/null 2>&1; then
  open -g -a Docker
fi
RUNSETT_OPEN_BROWSER=1
export RUNSETT_OPEN_BROWSER
exec sh scripts/dev.sh
