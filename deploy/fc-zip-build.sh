#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Build the Function Compute ZIP code package for the ZIP-based custom runtime.
#
# Produces dist/nalog-agent-fc.zip containing:
#   src/ public/ scripts/ deploy/bootstrap package.json package-lock.json node_modules/
#
# node_modules is installed inside the Node 22 Debian image so native deps
# (e.g. tablestore) match FC's custom.debian12 x86-64 runtime.
#
# Usage: ./deploy/fc-zip-build.sh
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

DIST_DIR="dist"
STAGE_DIR="${DIST_DIR}/fc-stage"
ZIP_PATH="${DIST_DIR}/nalog-agent-fc.zip"

echo "▶ Cleaning ${STAGE_DIR}"
rm -rf "${STAGE_DIR}" "${ZIP_PATH}"
mkdir -p "${STAGE_DIR}"

echo "▶ Copying application files"
cp -R src public scripts package.json package-lock.json "${STAGE_DIR}/"
mkdir -p "${STAGE_DIR}/deploy"
cp deploy/bootstrap "${STAGE_DIR}/deploy/bootstrap"
chmod 755 "${STAGE_DIR}/deploy/bootstrap"

# Match FC custom.debian12's bundled Node.js (nodejs20) so native deps line up.
echo "▶ Installing production node_modules for linux/amd64 (Node 20 Debian)"
docker run --rm --platform linux/amd64 \
  -v "$(pwd)/${STAGE_DIR}:/app" -w /app \
  node:20-bookworm-slim \
  sh -c "npm install --omit=dev --no-audit --no-fund"

echo "▶ Zipping to ${ZIP_PATH}"
mkdir -p "${DIST_DIR}"
( cd "${STAGE_DIR}" && zip -ry "../nalog-agent-fc.zip" . -x '*.DS_Store' >/dev/null )

SIZE=$(du -h "${ZIP_PATH}" | cut -f1)
echo "✅ Built ${ZIP_PATH} (${SIZE})"
