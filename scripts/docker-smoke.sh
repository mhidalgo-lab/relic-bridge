#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# P2-11: smoke test of a built relic-bridge image: runs it hardened (read-only root FS, no capabilities, non-root) with
# a throwaway master key and checks that `serve` starts and /health answers. Usage: scripts/docker-smoke.sh <image>
set -euo pipefail

image="${1:?usage: docker-smoke.sh <image>}"
name="rb-smoke-$$"
port="${RB_SMOKE_PORT:-18787}"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

key="$(docker run --rm "$image" keys generate 2>/dev/null)"
[[ -n "$key" ]] || { echo "could not generate a master key" >&2; exit 1; }

# The key goes through the environment of this one container only (never an argument that would show in `ps` output
# of the host: `-e NAME` without a value forwards it from this process).
export RB_MASTER_KEY="$key"
docker run -d --name "$name" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$name:/data" -e RB_MASTER_KEY -e RB_ALLOWED_HOSTS=localhost -p "127.0.0.1:${port}:8787" "$image" >/dev/null

for _ in $(seq 1 30); do
  if body="$(curl -fsS --max-time 2 "http://localhost:${port}/health" 2>/dev/null)"; then
    [[ "$body" == '{"status":"ok"}' ]] || { echo "unexpected /health body: $body" >&2; exit 1; }
    uid="$(docker inspect --format '{{.Config.User}}' "$image")"
    [[ "$uid" == "65532:65532" ]] || { echo "image user is '$uid', expected 65532:65532" >&2; exit 1; }
    echo "ok: /health answered, running as ${uid}, read-only root filesystem"
    exit 0
  fi
  sleep 1
done
echo "the container did not answer on /health:" >&2
docker logs "$name" >&2 || true
exit 1
