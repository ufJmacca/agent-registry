#!/usr/bin/env bash
set -euo pipefail

if [[ ! -d node_modules ]]; then
  npm ci --no-audit --no-fund
fi

if [[ -x node_modules/.bin/playwright ]]; then
  npx playwright install chromium
fi
