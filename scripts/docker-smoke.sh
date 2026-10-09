#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# P2-11 / P2-19: smoke test of a built relic-bridge image. Runs it hardened (read-only root FS, no capabilities,
# non-root) with a throwaway master key and checks, through the image only: `serve` starts, /health answers, a foreign
# Host is refused, `db backup` works, and an operator can create a credential, project, grant and device token with the
# CLI and then list tools over MCP (Streamable HTTP) with that token.
#
# New Relic is replaced by a local HTTPS stand-in (scripts/docker-smoke/fake-nerdgraph.mjs) reachable as
# api.newrelic.com on a private docker network; the image trusts its throwaway certificate through NODE_EXTRA_CA_CERTS.
# Needs docker, jq and openssl. It works against a Docker daemon that shares neither a filesystem nor a network with
# this shell (a CI runner talking to a remote or sibling daemon): files go in with `docker cp`, never a bind mount, and
# HTTP requests come from a curl container on the same private network, never from a published port.
# Usage: scripts/docker-smoke.sh <image>
set -euo pipefail

image="${1:?usage: docker-smoke.sh <image>}"
here="$(cd "$(dirname "$0")" && pwd)"
id="$$"
name="rb-smoke-${id}"
fake="rb-smoke-nr-${id}"
net="rb-smoke-${id}"
seed="rb-smoke-seed-${id}"
# curl client container, pinned by digest (curlimages/curl 8.11.1).
curl_image="${RB_SMOKE_CURL_IMAGE:-curlimages/curl@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69}"
base="http://${name}:8787"
certs="$(mktemp -d)"
cli=(docker exec -i "$name" /nodejs/bin/node /app/dist/index.mjs)

cleanup() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "--- logs of the NerdGraph stand-in ($fake) ---" >&2
    docker logs "$fake" >&2 2>&1 || true
    docker inspect --format '{{.State.Status}} {{.NetworkSettings.Networks}}' "$fake" >&2 2>&1 || true
    openssl x509 -in "$certs/cert.pem" -noout -subject -fingerprint -sha256 >&2 2>&1 || true
    openssl version >&2
    echo "--- diagnostics ---" >&2
    docker exec "$name" /nodejs/bin/node -e "require('dns').lookup('api.newrelic.com',(e,a)=>console.log('dns',e&&e.code,a)); const c=require('tls').connect({host:'api.newrelic.com',port:443,rejectUnauthorized:false},()=>{const x=c.getPeerCertificate();console.log('peer',x.subject,x.issuer,x.fingerprint256);c.end()});c.on('error',e=>console.log('tls err',e.message));console.log(require('fs').readdirSync('/data'), process.env.NODE_EXTRA_CA_CERTS); fetch('https://api.newrelic.com/').then(r=>console.log('status',r.status),e=>console.log('fetch failed',e.cause||e))" >&2 2>&1 || true
    echo "--- logs of the image under test ($name) ---" >&2
    docker logs "$name" >&2 2>&1 || true
  fi
  docker rm -f "$name" "$fake" "$seed" >/dev/null 2>&1 || true
  docker volume rm -f "$name" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$certs"
}
trap cleanup EXIT

key="$(docker run --rm "$image" keys generate 2>/dev/null)"
[[ -n "$key" ]] || { echo "could not generate a master key" >&2; exit 1; }

# A throwaway self-signed certificate for api.newrelic.com, trusted by the image under test as an extra CA.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=api.newrelic.com' \
  -addext 'subjectAltName=DNS:api.newrelic.com' -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout "$certs/key.pem" -out "$certs/cert.pem" >/dev/null 2>&1
chmod 0755 "$certs"; chmod 0644 "$certs"/*.pem

# curl from inside the private network. The server only accepts the Host `localhost`; DCURL_HOST overrides it.
dcurl() { docker run --rm -i --network "$net" "$curl_image" -sS -H "Host: ${DCURL_HOST:-localhost}" "$@"; }

docker network create "$net" >/dev/null
# The stand-in runs on the image's own Node (the distroless entrypoint is node; the script is passed as its argument).
docker create --name "$fake" --network "$net" --network-alias api.newrelic.com --entrypoint /nodejs/bin/node \
  "$image" /tmp/fake.mjs >/dev/null
docker cp "$certs/key.pem" "$fake:/tmp/key.pem"
docker cp "$certs/cert.pem" "$fake:/tmp/cert.pem"
docker cp "$here/docker-smoke/fake-nerdgraph.mjs" "$fake:/tmp/fake.mjs"
docker start "$fake" >/dev/null

# The CA certificate goes into the data volume (the root file system of the image under test is read-only).
docker create --name "$seed" -v "$name:/data" "$image" >/dev/null
docker cp "$certs/cert.pem" "$seed:/data/ca.pem"
docker rm "$seed" >/dev/null

# The key goes through the environment of this one container only (never an argument that would show in `ps` output
# of the host: `-e NAME` without a value forwards it from this process).
export RB_MASTER_KEY="$key"
docker run -d --name "$name" --network "$net" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$name:/data" -e NODE_EXTRA_CA_CERTS=/data/ca.pem \
  -e RB_MASTER_KEY -e RB_ALLOWED_HOSTS=localhost "$image" >/dev/null

up=false
for _ in $(seq 1 30); do
  if body="$(dcurl -f --max-time 2 "${base}/health" 2>/dev/null)"; then up=true; break; fi
  sleep 1
done
if [[ "$up" != true ]]; then
  echo "the container did not answer on /health:" >&2
  docker logs "$name" >&2 || true
  exit 1
fi
[[ "$body" == '{"status":"ok"}' ]] || { echo "unexpected /health body: $body" >&2; exit 1; }

uid="$(docker inspect --format '{{.Config.User}}' "$image")"
[[ "$uid" == "65532:65532" ]] || { echo "image user is '$uid', expected 65532:65532" >&2; exit 1; }
code="$(DCURL_HOST=evil.example dcurl -o /dev/null -w '%{http_code}' --max-time 2 "${base}/health")"
[[ "$code" == "403" ]] || { echo "a foreign Host got $code, expected 403" >&2; exit 1; }

# The maintenance commands find the database through RB_DATA_DIR, as the docs run them (P2-review H2).
"${cli[@]}" db backup /data/smoke-backup.db >/dev/null || { echo "db backup failed inside the image" >&2; exit 1; }

# Operator flow with the CLI inside the container (the credential is validated against the stand-in).
cred="$(printf 'NRAK-SMOKE00000000000000000000000\n' | "${cli[@]}" credential add --label smoke --region US --json | jq -er .data.id)"
"${cli[@]}" project add --slug smoke --default-account 1 --default-credential "$cred" --json >/dev/null
grant="$("${cli[@]}" grant create --project smoke --label smoke --json | jq -er .data.id)"
token="$("${cli[@]}" token create --grant "$grant" --label smoke --ttl-days 1 --no-config 2>/dev/null)"
[[ "$token" == rb_* ]] || { echo "token create did not print a device token" >&2; exit 1; }

# MCP through the image: initialize, then tools/list, with the device token.
mcp() {
  dcurl --max-time 10 -X POST "${base}/p/smoke/mcp" \
    -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-06-18' "$@"
}
# The answer is plain JSON or a one-event SSE stream: take the first `data:` line if there is one.
payload() { if grep -q '^data: ' "$1"; then sed -n 's/^data: //p' "$1" | head -n1; else cat "$1"; fi; }
mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' > "$certs/init.out"
payload "$certs/init.out" | jq -e '.result.serverInfo' >/dev/null || { echo "MCP initialize failed:" >&2; cat "$certs/init.out" >&2; exit 1; }
mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' > "$certs/tools.out"
count="$(payload "$certs/tools.out" | jq -e '.result.tools | length' || true)"
[[ "${count:-0}" -gt 0 ]] || { echo "MCP tools/list returned no tools:" >&2; cat "$certs/tools.out" >&2; exit 1; }
# A request without a token must not get a tool list.
nocode="$(dcurl -o /dev/null -w '%{http_code}' --max-time 5 -X POST "${base}/p/smoke/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}')"
[[ "$nocode" == "401" ]] || { echo "an unauthenticated MCP request got $nocode, expected 401" >&2; exit 1; }

echo "ok: /health answered, foreign Host refused, db backup works, CLI set up a project and token, MCP listed ${count} tools, running as ${uid}, read-only root filesystem"
