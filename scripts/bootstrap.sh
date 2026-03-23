#!/usr/bin/env bash
set -euo pipefail

if [[ ! -d node_modules ]] || [[ ! -x node_modules/.bin/playwright ]]; then
  npm ci --no-audit --no-fund
fi

npx playwright install chromium
