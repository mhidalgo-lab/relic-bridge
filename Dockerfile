# relic-bridge server image (P2-11). Multi-stage; the runtime stage is distroless (no shell, no package manager) and
# runs as a non-root user. Base images are pinned by digest; Renovate updates them.

ARG NODE_BUILD_IMAGE=node:24-trixie-slim@sha256:fe9b16c1666f3b5c89aa27efb5a1233e29767d135bbd3c7afb167b58387c9e7f
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:675c532423b908f9e56f9d60a4e62309b63cd2a3175acb90a46b96f7ee68e121

# Runs on the builder's own architecture: the production dependencies are pure JavaScript, so a multi-arch build
# needs no emulation (the runtime stage only copies files).
FROM --platform=$BUILDPLATFORM ${NODE_BUILD_IMAGE} AS build
WORKDIR /src
# pnpm from the `packageManager` field of package.json (corepack ships with Node 24).
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/cli/package.json apps/cli/
COPY packages/admin-ui/package.json packages/admin-ui/
COPY packages/auth/package.json packages/auth/
COPY packages/core/package.json packages/core/
COPY packages/http-app/package.json packages/http-app/
COPY packages/storage/package.json packages/storage/
COPY packages/storage-sqlite/package.json packages/storage-sqlite/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter relic-bridge...
COPY apps/cli apps/cli
COPY packages packages
# Release build: test hooks compiled out. Workspace packages are bundled into dist/index.mjs.
RUN RB_TEST_HOOKS=0 pnpm --filter relic-bridge build \
 && pnpm --filter relic-bridge --prod deploy --legacy /out \
 && rm -rf /out/src /out/test \
 && mkdir /data-dir

FROM ${NODE_RUNTIME_IMAGE}
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="relic-bridge" \
      org.opencontainers.image.description="Unofficial MCP server for New Relic via NerdGraph" \
      org.opencontainers.image.source="https://github.com/mhidalgo-lab/relic-bridge" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"
WORKDIR /app
COPY --from=build --chown=0:0 /out/package.json ./package.json
COPY --from=build --chown=0:0 /out/node_modules ./node_modules
COPY --from=build --chown=0:0 /out/dist ./dist
COPY --from=build --chown=0:0 /out/NOTICE /out/LICENSE ./
# /data holds the SQLite database (the only writable path; mount a volume, the root FS can be read-only).
# Created owned by the image user (uid 65532) so a fresh named volume is writable.
COPY --from=build --chown=65532:65532 --chmod=0700 /data-dir /data
ENV NODE_ENV=production \
    RB_DATA_DIR=/data \
    RB_HOST=0.0.0.0 \
    RB_PORT=8787
VOLUME ["/data"]
EXPOSE 8787
USER 65532:65532
# Healthy = the server answers on loopback. A 403 (forbidden_host: the loopback Host is not in RB_ALLOWED_HOSTS) still
# proves the process and listener are up, so it counts; anything else, or no answer, is unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.RB_PORT||8787)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200||r.status===403?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/index.mjs"]
CMD ["serve"]
