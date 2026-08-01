#!/usr/bin/env bash
# Builds and pushes the six images the Swarm stack expects.
#
# Swarm cannot build, so every image has to exist in a registry the node can
# pull from before `hydration-neckwork.stack.yml` will converge.
#
# The two UI images bake their sibling's public URL into the bundle at build
# time, so a hostname change means rebuilding here rather than editing the stack.
set -euo pipefail

REGISTRY="${REGISTRY:-galacticcouncil}"
PREFIX="${PREFIX:-hydration-neckwork}"
TAG="${TAG:-latest}"

EXPLORER_URL="${VITE_EXPLORER_URL:-https://neckwork-explorer.shellfish.hydration.cloud}"
PREIS_URL="${VITE_PREIS_URL:-https://neckwork-preis.shellfish.hydration.cloud}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '\n==> %s\n' "$*"
}

image() {
  printf '%s/%s-%s:%s' "$REGISTRY" "$PREFIX" "$1" "$TAG"
}

log "building $(image clickhouse)"
docker build -t "$(image clickhouse)" ./clickhouse

log "building $(image indexer)"
docker build -t "$(image indexer)" .

log "building $(image api)"
docker build -t "$(image api)" ./api

log "building $(image supervisor)"
docker build -t "$(image supervisor)" -f ops/supervisor.Dockerfile .

log "building $(image preis-ui) with VITE_EXPLORER_URL=$EXPLORER_URL"
docker build -t "$(image preis-ui)" \
  --build-arg "VITE_EXPLORER_URL=$EXPLORER_URL" \
  ./preis-ui

log "building $(image explorer-ui) with VITE_PREIS_URL=$PREIS_URL"
docker build -t "$(image explorer-ui)" \
  --build-arg "VITE_PREIS_URL=$PREIS_URL" \
  ./explorer-ui

for component in clickhouse indexer api supervisor preis-ui explorer-ui; do
  log "pushing $(image "$component")"
  docker push "$(image "$component")"
done

log "done"
