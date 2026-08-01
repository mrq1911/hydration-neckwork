#!/usr/bin/env bash
# Builds and pushes the six images the Swarm stack expects.
#
# Swarm cannot build, so every image has to exist in a registry the node can
# pull from before `hydration-neckwork.stack.yml` will converge.
#
# The images carry no deployment-specific values. The UIs read their sibling's
# public URL from /config.js at container start, so hostnames are set in the
# stack file and these images are reusable across deployments.
set -euo pipefail

REGISTRY="${REGISTRY:-galacticcouncil}"
PREFIX="${PREFIX:-hydration-neckwork}"
TAG="${TAG:-latest}"

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

log "building $(image preis-ui)"
docker build -t "$(image preis-ui)" ./preis-ui

log "building $(image explorer-ui)"
docker build -t "$(image explorer-ui)" ./explorer-ui

for component in clickhouse indexer api supervisor preis-ui explorer-ui; do
  log "pushing $(image "$component")"
  docker push "$(image "$component")"
done

log "done"
