#!/usr/bin/env bash
# Runs the cockpit visual snapshots. Use inside the pinned Playwright image so
# fonts match the baselines:
#
#   docker run --rm -v "$PWD":/work -w /work --ipc=host \
#     mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 \
#     bash visual/run.sh --update-snapshots
#
# Extra arguments pass through to `playwright test`.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf visual/.site
mkdir -p visual/.site
cp -R site/. visual/.site/
cp -R schemas visual/.site/schemas
cp -R visual/fixture/data visual/.site/data

(cd visual && npm ci --ignore-scripts --no-audit --no-fund)
cd visual
exec npx --no-install playwright test "$@"
