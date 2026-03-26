#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "usage: $0" >&2
  exit 1
fi

if [[ ! -d node_modules ]] || [[ ! -x node_modules/.bin/playwright ]]; then
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
fi
