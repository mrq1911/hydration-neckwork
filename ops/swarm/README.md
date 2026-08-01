# Swarm deployment

Hydration Neckwork is designed around Docker Compose. `hydration-neckwork.stack.yml`
runs it as a Swarm stack instead, pinned to a single node, which is the only
arrangement that preserves the two assumptions the pipeline makes: ClickHouse
keeps its data in a node-local volume, and `ingestion-supervisor` manages
historical workers through that node's own Docker engine.

Nothing here makes the stack node-portable. Pinning is the design, not a
limitation to be relaxed later — a task rescheduled onto another node would find
an empty database and a foreign Docker socket.

## What Swarm changes

Swarm ignores or rejects most of what `docker-compose.yml` relies on, so the
stack file is a rewrite rather than a copy:

```
docker-compose.yml                    hydration-neckwork.stack.yml
│
├─ build: (18 services) ─────────────▶ prebuilt images from a registry
├─ container_name: ─────────────────▶ dropped; Swarm names tasks itself
├─ profiles: [worker] ──────────────▶ moved to workers.compose.yml
├─ depends_on: condition: … ────────▶ dropped; restart policies converge instead
├─ driver: bridge ──────────────────▶ external attachable overlay
├─ ports: 127.0.0.1:… ──────────────▶ traefik labels under deploy.labels
└─ (no deploy: blocks) ─────────────▶ placement, resources, restart_policy
```

Two source changes were needed as well, both of which keep working under plain
Compose:

- `scripts/ingestion-supervisor.sh` queries ClickHouse over HTTP instead of
  `docker compose exec clickhouse`. Under Swarm the database is not a service in
  the supervisor's Compose project, so the old call could never resolve it.
- `ops/supervisor.Dockerfile` installs `curl` for that query path.

## Prerequisites

The stack references external volumes, an external network, and registry images.
It will not converge until all of them exist.

1. **Images.** From a machine with Docker Hub push rights for `galacticcouncil`:

   ```bash
   ./ops/swarm/build-and-push.sh
   ```

   Override `REGISTRY`, `TAG`, `VITE_EXPLORER_URL`, or `VITE_PREIS_URL` as needed.
   The UI images bake their sibling's public URL in at build time, so changing a
   hostname means rebuilding, not editing the stack file.

2. **Network.** Attachable, so the supervisor's plain-container workers can join
   the same overlay as the Swarm services:

   ```bash
   docker network create --driver overlay --attachable hydration-neckwork-net
   ```

3. **Volumes.** Declared external so a `docker stack rm` cannot take the indexed
   database with it:

   ```bash
   docker volume create hydration-neckwork-clickhouse-data
   docker volume create hydration-neckwork-user-backups
   ```

4. **Repository checkout on the node** at `/opt/hydration-neckwork`. Three bind
   mounts read from it: the ClickHouse schema for `schema-bootstrap`, the backup
   script for `user-backup`, and `workers.compose.yml` for the supervisor. The
   schema is not baked into the API image, so this is not optional.

   ```bash
   git clone https://github.com/1xGiraffe/hydration-neckwork /opt/hydration-neckwork
   ```

   Keep it at the same commit as the pushed images; the schema files travel with
   the checkout, not the image.

5. **Set the ClickHouse password.** Replace every
   `change-me-before-first-deploy` in the stack file before the first deploy.
   The ClickHouse entrypoint only applies `CLICKHOUSE_PASSWORD` when it
   initializes an empty volume, so changing it afterwards means updating the
   `default` user by hand. ClickHouse publishes no ports; it is reachable only on
   the overlay network.

## Deploy

```bash
docker stack deploy -c ops/swarm/hydration-neckwork.stack.yml neckwork
```

Or paste the file into Swarmpit as a new stack named `neckwork`.

## Convergence

Swarm has no `depends_on`, so ordering is emergent rather than enforced:

```
clickhouse ──▶ healthy
   │
   ├─▶ schema-bootstrap ──▶ applies schema, exits 0, stays at 0/1
   │
   └─▶ every other service crash-loops until the schema exists,
       then settles
```

`schema-bootstrap` sitting at 0/1 replicas is the success state, not a failure.
Expect restarts from schema consumers during the first minutes of a fresh
deploy; they stop once the schema lands.

`ingestion-supervisor` then starts historical workers as plain containers named
`hydration-neckwork-raw-backfill-*` and `hydration-neckwork-main-backfill-*`.
They appear under `docker ps` on the node but not in Swarmpit's service list,
because they are not Swarm tasks. Do not start or stop them by hand.

## Routing

Traefik picks the UIs and API up from `deploy.labels` on the `gateway` network:

| Service | Host |
| --- | --- |
| Explorer | `neckwork-explorer.shellfish.hydration.cloud` |
| Preis | `neckwork-preis.shellfish.hydration.cloud` |
| API | `neckwork-api.shellfish.hydration.cloud` |

Serving these under `neckwork.net` instead is a DNS change plus a UI rebuild, since
the certresolver and entrypoints here match what the cluster's Traefik already
runs.

## Operational notes

- Back up `hydration-neckwork-clickhouse-data` before any schema or checkpoint
  maintenance. The `user_*` tables are the only state not reproducible from raw
  chain data, and `user-backup` exports them nightly.
- Rolling a new image is `docker service update --image … --force` per service,
  or a stack redeploy. ClickHouse restarts are not free; it replays its log on
  start.
- Resource limits in the stack file are first estimates for a 64-core / 512 GB
  node shared with other stacks. ClickHouse gets 16 CPUs and 64 GB; tune once
  real ingestion load is visible.
