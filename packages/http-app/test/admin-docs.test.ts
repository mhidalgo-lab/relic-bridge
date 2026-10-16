// SPDX-License-Identifier: Apache-2.0
// Generates docs/reference/admin-api.md from the admin API's OpenAPI document (P2-09). The test fails when the file
// is stale; regenerate with `pnpm docs:admin-api`.
import { generateMasterKey, Keyring } from '@relic-bridge/auth';
import { Secret, silentLogger, systemClock } from '@relic-bridge/core';
import { createMemoryStorage } from '@relic-bridge/storage';
import { describe, expect, it } from 'vitest';
import { createAdminTokenVerifier } from '../src/admin/token.ts';
import { ADMIN_API_BASE, adminOpenApiDocument, createAdminApi } from '../src/index.ts';
import { CATALOG, randomAdminToken } from './fixtures.ts';

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI JSON is walked dynamically
type Json = Record<string, any>;

/** Answers every endpoint can give; listed once in the conventions instead of under each endpoint. */
const COMMON = new Set(['400', '401', '429', '503']);

function resolve(doc: Json, node: Json | undefined): Json {
  if (node && typeof node['$ref'] === 'string') {
    const name = (node['$ref'] as string).split('/').at(-1) as string;
    return (doc['components']?.['schemas']?.[name] ?? {}) as Json;
  }
  return node ?? {};
}

function refName(node: Json | undefined): string | null {
  return node && typeof node['$ref'] === 'string'
    ? ((node['$ref'] as string).split('/').at(-1) as string)
    : null;
}

function typeLabel(doc: Json, node: Json | undefined): string {
  if (!node) return 'any';
  const ref = refName(node);
  if (ref) return ref;
  if (Array.isArray(node['enum'])) return node['enum'].map((v: unknown) => JSON.stringify(v)).join(' \\| ');
  if ('const' in node) return JSON.stringify(node['const']);
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(node[key])) return node[key].map((n: Json) => typeLabel(doc, n)).join(' \\| ');
  }
  const t = node['type'];
  if (t === 'array') return `${typeLabel(doc, node['items'])}[]`;
  if (Array.isArray(t)) {
    const base = t.filter((x: string) => x !== 'null');
    const inner =
      base.length === 1 && base[0] === 'array' ? `${typeLabel(doc, node['items'])}[]` : base.join(' \\| ');
    return t.includes('null') ? `${inner} \\| null` : inner;
  }
  if (typeof t === 'string') return t;
  return 'object';
}

const cell = (text: unknown): string =>
  String(text ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim();

function fieldTable(doc: Json, schema: Json): string {
  const s = resolve(doc, schema);
  const props = (s['properties'] ?? {}) as Record<string, Json>;
  const required = new Set<string>((s['required'] as string[] | undefined) ?? []);
  const names = Object.keys(props);
  if (names.length === 0) return '_No fields._\n';
  const rows = names.map((n) => {
    const p = props[n] as Json;
    const desc = cell(p['description'] ?? resolve(doc, p)['description']);
    return `| \`${n}\` | \`${typeLabel(doc, p)}\` | ${required.has(n) ? 'yes' : 'no'} | ${desc} |`;
  });
  return ['| Field | Type | Required | Description |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
}

export function renderAdminApiMarkdown(doc: Json): string {
  const out: string[] = [
    '<!-- GENERATED from the admin API OpenAPI document by packages/http-app/test/admin-docs.test.ts — do not edit. -->',
    '<!-- Regenerate: pnpm docs:admin-api -->',
    '',
    '# Admin API reference',
    '',
    cell(doc['info']?.['description']),
    '',
    `Base path: \`${ADMIN_API_BASE}\`. OpenAPI 3.1 document: \`GET ${ADMIN_API_BASE}/openapi.json\` (admin token required).`,
    'Guide: [self-hosting](../guide/self-hosting.md#admin-api).',
    '',
    '## Conventions',
    '',
    '- **Authentication**: `Authorization: Bearer <RB_ADMIN_TOKEN>` on every request. Cookies and query-string',
    '  credentials are never accepted; every failure is the same `401` and counts toward the per-IP failure throttle',
    '  (past it, further failures get `429 rate_limited`; the valid token is still served).',
    '- **Bodies**: `application/json` only (`415` otherwise; body-less actions such as `…/revoke` need no `Content-Type`), at most 64 KiB, or 1 MiB for `POST /config/import` (`413`). Unknown fields are refused (`400`).',
    '- **Errors**: `{ "error": { "code", "message", "field"?, "detail"? } }`. Messages name fields and ids only: a 404 or an unknown-field message echoes the id or field name, redacted and truncated (64 and 100 characters), never a submitted value.',
    '- **Lists**: `?limit=` (1-200, default 50) and `?cursor=`; responses are `{ "data": [...], "nextCursor" }`.',
    '- **Times**: epoch milliseconds.',
    '- Every endpoint can also answer `400`, `401`, `429` and `503` (storage unavailable or locked, with `Retry-After`); the tables below list the other answers.',
    '- **Secrets**: New Relic keys are accepted in request bodies only and never returned (credentials come back as',
    '  masked metadata); token hashes are never returned; a new token appears once, in the `POST /tokens` response.',
    '- **Audit**: every change writes an `admin` audit row (actor `admin_token`), including failed attempts.',
    '',
    '## Error codes',
    '',
    '| Code | HTTP | Meaning |',
    '| --- | --- | --- |',
    '| `invalid_request` | 400 | Unknown field, wrong type, a rule broken (`field` names it) |',
    '| `unauthorized` | 401 | Missing or wrong admin token |',
    '| `not_found` | 404 | No such resource (or no such endpoint) |',
    '| `conflict` | 409 | Duplicate slug or email, a credential still in use, a concurrent change |',
    '| `read_only` | 409 | The storage is read-only |',
    '| `payload_too_large` | 413 | Body over the limit |',
    '| `unsupported_media_type` | 415 | Body is not JSON |',
    "| `not_permitted` | 422 | A rule refused it (e.g. a grant using another user's personal key) |",
    '| `key_rejected` | 422 | New Relic refused the key, or it is not a User key (`detail`: `RB_AUTH_*`) |',
    '| `rate_limited` | 429 | Too many requests or failed attempts from this address (`Retry-After`) |',
    '| `upstream_unavailable` | 502 | New Relic could not be asked; nothing was changed (`detail`: `RB_*`) |',
    '| `unavailable` | 503 | Storage or encryption unavailable |',
    '| `internal_error` | 500 | Unexpected; see the server log by `X-Request-Id` |',
    '',
  ];
  const byTag = new Map<string, string[]>();
  for (const [path, ops] of Object.entries(doc['paths'] as Record<string, Json>)) {
    for (const [method, op] of Object.entries(ops as Record<string, Json>)) {
      const tag = (op['tags']?.[0] as string | undefined) ?? 'other';
      const lines: string[] = [`### ${method.toUpperCase()} ${path}`, '', cell(op['summary']), ''];
      if (op['description']) lines.push(cell(op['description']), '');
      const params = (op['parameters'] ?? []) as Json[];
      if (params.length > 0) {
        lines.push('| Parameter | In | Type | Required | Description |', '| --- | --- | --- | --- | --- |');
        for (const p of params) {
          lines.push(
            `| \`${p['name']}\` | ${p['in']} | \`${typeLabel(doc, p['schema'])}\` | ${p['required'] ? 'yes' : 'no'} | ${cell(p['description'] ?? p['schema']?.['description'])} |`,
          );
        }
        lines.push('');
      }
      const body = op['requestBody']?.['content']?.['application/json']?.['schema'] as Json | undefined;
      if (body) {
        const name = refName(body);
        lines.push(`Request body${name ? ` (\`${name}\`)` : ''}:`, '', fieldTable(doc, body));
      }
      lines.push('| Status | Body | Description |', '| --- | --- | --- |');
      for (const [status, res] of Object.entries((op['responses'] ?? {}) as Record<string, Json>)) {
        if (COMMON.has(status)) continue;
        const schema = res['content']?.['application/json']?.['schema'] as Json | undefined;
        lines.push(
          `| ${status} | ${schema ? `\`${typeLabel(doc, schema)}\`` : '—'} | ${cell(res['description'])} |`,
        );
      }
      lines.push('');
      byTag.set(tag, [...(byTag.get(tag) ?? []), ...lines]);
    }
  }
  for (const [tag, lines] of byTag) out.push(`## ${tag[0]?.toUpperCase()}${tag.slice(1)}`, '', ...lines);
  out.push('## Schemas', '');
  const schemas = (doc['components']?.['schemas'] ?? {}) as Record<string, Json>;
  for (const name of Object.keys(schemas).sort()) {
    const s = schemas[name] as Json;
    out.push(`### ${name}`, '');
    if (s['description']) out.push(cell(s['description']), '');
    out.push(fieldTable(doc, s));
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

async function document(): Promise<Json> {
  const storage = createMemoryStorage();
  const api = createAdminApi({
    storage,
    keyring: await Keyring.create({ current: generateMasterKey(1) }),
    verifier: createAdminTokenVerifier(new Secret(randomAdminToken())),
    validateKey: async () => {
      throw new Error('not used');
    },
    catalog: CATALOG,
    clock: systemClock,
    logger: silentLogger,
    maxBodyBytes: 65536,
    runInBackground: () => undefined,
  });
  return adminOpenApiDocument(api) as Json;
}

describe('docs/reference/admin-api.md', () => {
  it('is generated from the OpenAPI document (run `pnpm docs:admin-api` when this fails)', async () => {
    const markdown = renderAdminApiMarkdown(await document());
    expect(markdown).toContain('### POST /credentials');
    await expect(markdown).toMatchFileSnapshot('../../../docs/reference/admin-api.md');
  });
});
