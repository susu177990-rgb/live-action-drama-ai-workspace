#!/bin/zsh
cd "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ ! -d node_modules ]]; then
  npm ci || exit 1
fi
if [[ ! -f dist-server/server/index.js || ! -f dist/index.html ]]; then
  npm run build || exit 1
fi
node scripts/install-desktop.cjs || exit 1
npm run desktop
