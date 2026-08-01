# Built from the repository root, not from ./clickhouse, so the nightly user-table
# backup script can be baked in alongside the schema. Mounting it from the host
# would make the deployment depend on a checkout being present on the node.
#
# See clickhouse/Dockerfile.dockerignore for what this context sends.
FROM clickhouse/clickhouse-server:26.3.9.8

# Applied by the server's own entrypoint when it initializes an empty volume.
# Existing databases are upgraded by schemaBootstrap in the api image instead.
COPY clickhouse/schema/ /docker-entrypoint-initdb.d/

# Reused by the `user-backup` service, which runs this image so the client version
# always matches the server.
COPY ops/backup-user-tables.sh /backup-user-tables.sh
