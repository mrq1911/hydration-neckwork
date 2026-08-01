# Built from the repository root, not from ./api, because the ClickHouse schema
# lives outside the api workspace and has to be baked in: `schemaBootstrap`
# applies it to an existing database, and mounting it from the host would make
# every deployment depend on a checkout being present on the node.
#
# The root .dockerignore excludes `api`, so this build relies on
# api/Dockerfile.dockerignore instead.
FROM node:22-slim

WORKDIR /app

COPY --chown=node:node api/package.json api/package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node api/src/ ./src/
COPY --chown=node:node api/tsconfig.json ./

# Read via SCHEMA_DIR=/schema, which keeps the image self-sufficient for upgrades.
COPY --chown=node:node clickhouse/schema/ /schema/

EXPOSE 3000

USER node
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
