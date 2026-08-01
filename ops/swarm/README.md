# Swarm deployment

Hydration Neckwork is designed around Docker Compose. `hydration-neckwork.stack.yml`
runs it as a Swarm stack instead.

The stack assumes a **single-node swarm** and carries no placement constraints,
because on one node they only add noise. The assumption is real all the same:
ClickHouse keeps its data in a node-local volume, and `ingestion-supervisor`
manages historical workers through its own node's Docker engine. Neither survives
being rescheduled — ClickHouse would come up against an empty volume and the
supervisor would drive the wrong engine.

So if a second node ever joins this swarm, add constraints back before scaling or
redeploying anything:

```yaml
deploy:
  placement:
    constraints:
      - node.hostname == <the node holding the data>
```

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
├─ driver: bridge ──────────────────▶ stack-managed attachable overlay
├─ ports: 127.0.0.1:… ──────────────▶ traefik labels under deploy.labels
└─ (no deploy: blocks) ─────────────▶ resources, restart_policy
```

Source changes were needed as well, all of which keep working under plain Compose:

- `scripts/ingestion-supervisor.sh` queries ClickHouse over HTTP instead of
  `docker compose exec clickhouse`. Under Swarm the database is not a service in
  the supervisor's Compose project, so the old call could never resolve it.
- `ops/supervisor.Dockerfile` installs `curl` for that query path, and bakes in
  `workers.compose.yml` rather than the repository's `docker-compose.yml`.
- `api/Dockerfile` and `clickhouse/Dockerfile` build from the repository root and
  bake in the ClickHouse schema and the backup script. Each has its own
  `Dockerfile.dockerignore`, because the root `.dockerignore` excludes `api`.

Together those remove every host bind mount except the Docker socket, which is
what makes the stack deployable and manageable with no shell access to the node:
nothing has to be placed on it, and nothing drifts out of sync with the images.

## Who runs what

Three roles, which may or may not be the same machine:

```
build machine (Docker Hub push rights for galacticcouncil)
  └─▶ ops/swarm/build-and-push.sh          → 6 images in the registry

anywhere with cluster access
  └─▶ docker stack deploy … / Swarmpit     → stack `neckwork`
```

Nothing has to be done on the node itself. The stack creates its own network and
volumes, and every file the services need is inside an image, so the deploy can be
driven entirely from the Swarmpit UI.

## Prerequisites

Only two, and only the first involves the cluster at all.

1. **Images.** From a machine with Docker Hub push rights for `galacticcouncil`:

   ```bash
   ./ops/swarm/build-and-push.sh
   ```

   Override `REGISTRY` or `TAG` as needed. The images carry no
   deployment-specific values: the UIs read their sibling's URL from `/config.js`
   at container start, so the same image works for any hostname.

2. **Set the ClickHouse password.** Replace every
   `change-me-before-first-deploy` in the stack file before the first deploy — 14
   occurrences, and they all have to match. The ClickHouse entrypoint only applies
   `CLICKHOUSE_PASSWORD` when it initializes an empty volume, so changing it
   afterwards means updating the `default` user by hand. ClickHouse publishes no
   ports; it is reachable only on the stack's overlay network.

The network and both volumes are stack-managed, so deploying creates them. The
volumes are namespaced with the stack (`neckwork_clickhouse_data`), and `docker
stack rm` never removes volumes, so the indexed database survives a teardown.

Deploy the stack as **`neckwork`**. The overlay network becomes `neckwork_net`,
which is the name baked into `workers.compose.yml`; under a different stack name
the supervisor's workers cannot resolve ClickHouse.

## Deploy

From the CLI, against a checkout:

```bash
docker stack deploy -c ops/swarm/hydration-neckwork.stack.yml neckwork
```

### Through Swarmpit

1. **Stacks → New stack.** Name it `neckwork`. The name becomes the Swarm
   namespace, so services appear as `neckwork_api`, `neckwork_clickhouse`, and so
   on. Traefik router names are set explicitly in the labels and do not depend on
   it.
2. **Paste the whole stack file** into the editor. Nothing is templated: every
   value is inlined because Swarmpit deploys the YAML it is given and does not
   read a `.env` beside it. `${VAR}` left in the file would reach Swarm as an
   empty string, not as a default.
3. **Replace the ClickHouse password** in all 14 places before the first deploy,
   either in the editor or in the file. Deploying with the placeholder means
   redoing the ClickHouse volume later — the entrypoint only applies
   `CLICKHOUSE_PASSWORD` when initializing an empty one.
4. **Deploy.** The stack creates its own network and volumes. The only thing that
   must already exist is the `gateway` network, which Traefik owns, and the six
   images in the registry.
5. **Expect a noisy first few minutes** — see Convergence below. `schema-bootstrap`
   ending at 0/1 is success, not failure.

Later edits go through **Stacks → neckwork → Edit**, which redeploys changed
services only. Editing a single variable is also possible per service under
Services → *service* → Environment, but that drifts from the stack file; prefer
editing the stack so the file stays the source of truth.

Swarmpit's own compose view normalizes what it shows: expect `deploy.labels` to be
rendered as a flat label list and short syntax expanded to long. That is display
and storage formatting, not a change in meaning.

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

## Routing through Traefik

Three services are published; everything else, ClickHouse included, stays on the
internal overlay with no host ports.

| Service | Host | Container port |
| --- | --- | --- |
| Explorer | `neckwork-explorer.shellfish.hydration.cloud` | 80 |
| Preis | `neckwork-preis.shellfish.hydration.cloud` | 80 |
| API | `neckwork-api.shellfish.hydration.cloud` | 3000 |

The cluster's Traefik is v2.7 with `--providers.docker.swarmMode=true` and
`--providers.docker.network=gateway`, entrypoints `web` (:80) and `websecure`
(:443), a global `web → websecure` redirect, and the `myresolver` ACME resolver.
The stack's labels are written against exactly that, so no Traefik-side change is
needed to add these three routers.

Four things about this wiring are easy to get wrong:

- **Labels live under `deploy.labels`, not top-level `labels`.** In Swarm mode
  Traefik reads *service* labels; top-level `labels` become *container* labels and
  are silently ignored. The symptom is a healthy service that Traefik never routes
  to — a 404 from the edge, with nothing in the service's own logs.
- **`traefik.docker.network=gateway` is required here.** `api`, `preis-ui`, and
  `explorer-ui` each sit on two networks (`neckwork` and `gateway`). Without the
  label Traefik may pick the internal address and fail to reach the task.
- **`loadbalancer.server.port` is the container port**, not a published one. These
  services deliberately publish nothing; the routing mesh is not involved.
- **Certificates issue on first request.** `myresolver` uses the HTTP challenge on
  the `web` entrypoint plus a TLS challenge, and the wildcard
  `*.shellfish.hydration.cloud` already resolves to the node, so ACME should
  succeed unattended. The very first hit to each host can be slow while the
  certificate is obtained.

### Verifying the edge

```bash
# routers registered? (dashboard is published on host port 8081)
curl -s http://<node>:8081/api/http/routers | grep -o 'neckwork-[a-z]*'

# end to end, including certificate
curl -sI https://neckwork-api.shellfish.hydration.cloud/health
curl -sI https://neckwork-explorer.shellfish.hydration.cloud/
```

A 404 from Traefik with the service reporting healthy means the labels did not
register: check they are under `deploy.labels` and that the service is attached to
`gateway`. A 502 means they registered but Traefik cannot reach the task, which
points at the network label or a service still crash-looping on the schema.

Serving these under `neckwork.net` instead is a DNS change plus editing the
hostnames in this stack file — three router rules and the two cross-link env vars.
The certresolver and entrypoints stay as they are.

The UIs cross-link using `PREIS_URL` on `explorer-ui` and `EXPLORER_URL` on
`preis-ui`. Both are read at container start and written into `/config.js`, so a
hostname change is a stack update and a restart, not an image rebuild:

```
stack env ──▶ docker-entrypoint.d/40-runtime-config.sh
                └─▶ /config.js  (window.__NECKWORK_CONFIG__)
                      └─▶ app, falling back to the build-time
                          value and then to localhost
```

`/config.js` is served `no-store`, so a redeployed container never keeps handing
out the previous deployment's URL.

## Operational notes

- Back up `neckwork_clickhouse_data` before any schema or checkpoint
  maintenance. The `user_*` tables are the only state not reproducible from raw
  chain data, and `user-backup` exports them nightly.
- Rolling a new image is `docker service update --image … --force` per service,
  or a stack redeploy. ClickHouse restarts are not free; it replays its log on
  start.
- Resource limits in the stack file are first estimates for a 64-core / 512 GB
  node shared with other stacks. ClickHouse gets 16 CPUs and 64 GB; tune once
  real ingestion load is visible.
