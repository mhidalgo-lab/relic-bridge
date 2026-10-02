# 0008 — Credentials, projects, grants, tokens

- Status: accepted
- Date: 2026-10-01

## Context
Primary use: one person reaching their own instance from several devices (MacBook, PC, W365, phone) across two NR
accounts. Secondary use: sharing with teammates, which brings in separate NR keys per person and a tool allowlist per client.

## Decision
- **Credential** = NR User key + region (+ validated user email and reachable accounts).
- **Project** = URL slug + allowed accounts + default account + enabled tools (upper limit) + query limits +
  optional default credential.
- **Grant** = (user or service) × project × credential × tool allowlist × account allowlist × rate limit × expiry.
- **Access token / OAuth session** authenticates one device or app against one grant. Several per grant; revoked one by one.
- Effective permissions are the **intersection** of project and grant (see ARCHITECTURE §4). A grant can never widen
  what the project allows.
- **Bring-your-own-key** is the recommended team pattern (own NR RBAC, own 25-concurrency budget).

## Consequences
- Personal setup stays simple: one user, two credentials, two projects, one grant each, one token per device.
- Teams get least privilege without forking config.
