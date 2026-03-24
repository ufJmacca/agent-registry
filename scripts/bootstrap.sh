#!/usr/bin/env bash
set -euo pipefail

install_playwright=false

if [[ "${1-}" == "--with-playwright" ]]; then
  install_playwright=true
  shift
fi

if [[ $# -ne 0 ]]; then
  echo "usage: $0 [--with-playwright]" >&2
  exit 1
fi

if [[ ! -d node_modules ]] || [[ ! -x node_modules/.bin/playwright ]]; then
  npm ci --no-audit --no-fund
fi

if [[ "$install_playwright" == "true" ]]; then
  npx playwright install chromium
fi
