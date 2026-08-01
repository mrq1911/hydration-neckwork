FROM docker:27-cli

RUN apk add --no-cache bash coreutils gawk grep curl

WORKDIR /etc/hydration-neckwork

# The worker definitions the supervisor instantiates with `docker compose run`.
# These carry `image:` and no `build:`, because the supervisor cannot build inside
# its own container. Baked in so no checkout has to exist on the node.
COPY ops/swarm/workers.compose.yml /etc/hydration-neckwork/docker-compose.yml
COPY scripts/ingestion-supervisor.sh /usr/local/bin/ingestion-supervisor.sh

ENTRYPOINT ["bash"]
CMD ["/usr/local/bin/ingestion-supervisor.sh"]
