---
id: P2-11
title: Docker image (signed, SBOM)
phase: 2
status: todo
priority: medium
depends_on: [P2-06, P2-02]
adr: []
owner: ""
---

# P2-11 — Docker image

## Scope
- Multi-stage build; distroless or slim base; non-root user; read-only root FS compatible; `/data` volume for SQLite.
- Multi-arch (amd64, arm64); healthcheck.
- Publish to GHCR on release; **cosign keyless signing**, SBOM (syft) and provenance attestations.
- `docker-compose.example.yml` with a reverse proxy (Caddy) for TLS.

## Acceptance criteria
- [ ] Trivy scan clean of high/critical; signature verifiable with documented command.

## Security notes
T18.

## Docs to update
- Self-hosting guide (Docker section).

## Out of scope
- Helm chart (consider post-1.0).
