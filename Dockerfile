# Development image: Node 26 LTS plus git (the app will keep note history with git).
# compose.yaml bind-mounts the source at /app, so nothing is copied in here.
FROM node:26-slim AS dev

# The npm cache folder is writable by any user, because containers run with the host user's uid.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /cache/npm \
 && chmod 1777 /cache/npm

ENV HOME=/tmp \
    npm_config_cache=/cache/npm \
    npm_config_update_notifier=false \
    npm_config_fund=false

WORKDIR /app
