#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# P8-08: run a pnpm script in a Debian 12 Node container. workerd (Workers runtime tests, CPU benchmark) needs glibc
# 2.35+, which the runner image's userland may not have. The repository is copied in with `docker cp` (no
# bind mounts, so it also works when the runner and the Docker daemon do not share a filesystem) and nothing from the
# runner environment is passed through. Usage: scripts/ci-container.sh <pnpm-script> [<pnpm-script>...]
set -euo pipefail

image="${RB_CI_IMAGE:-node:24-bookworm}"
steps=""
for script in "$@"; do steps+=" && pnpm ${script}"; done
cid="$(docker create -w /work "$image" bash -ec "corepack enable && pnpm install --frozen-lockfile${steps}")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker cp "$PWD/." "${cid}:/work"
docker start -a "$cid"
