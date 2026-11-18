#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ] && command -v brew >/dev/null 2>&1; then
  node_prefix=$(brew --prefix node@24)
  if [ -x "$node_prefix/bin/node" ]; then PATH="$node_prefix/bin:$PATH"; export PATH; fi
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]; then
  echo 'Runsett Studio requires Node.js 24.' >&2
  exit 1
fi
if ! node -e "for (const pkg of ['react-dom/client', 'codemirror', '@codemirror/lang-javascript', '@codemirror/theme-one-dark', 'typescript']) require.resolve(pkg, { paths: ['./packages/studio'] })" >/dev/null 2>&1; then npm ci; fi
npm run build
exec node packages/studio/dist/server.js
