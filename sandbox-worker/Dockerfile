# Reference isolated executor image.
# NEVER mount the host project root or host home directory into this container.
# Run with: --user sandbox --network=none --cpus=1 --memory=512m
#   --pids-limit=64 --read-only --tmpfs /tmp:exec,size=256m
FROM node:22-alpine

# Dedicated non-root user with a FIXED uid/gid so compose tmpfs mounts can be
# chowned to it (tmpfs mounts default to root ownership, which would break
# the ephemeral workspace with EACCES).
RUN adduser -D -u 10001 -s /bin/sh sandbox \
  && mkdir -p /srv/worker /srv/workspaces \
  && chown -R 10001:10001 /srv/worker /srv/workspaces

WORKDIR /srv/worker
COPY server.js package.json ./
RUN chmod 555 server.js

ENV SANDBOX_PORT=8788 \
    SANDBOX_WORKSPACE_ROOT=/srv/workspaces \
    NODE_ENV=production

USER sandbox
EXPOSE 8788
CMD ["node", "server.js"]
