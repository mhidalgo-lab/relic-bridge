// SPDX-License-Identifier: Apache-2.0
// Shared helpers for the P0-09 NerdGraph spike. Zero dependencies (Node 24: fetch + type stripping).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
export const RAW_DIR = join(SPIKE_DIR, 'results', 'raw');
export const SANITIZED_DIR = join(SPIKE_DIR, 'results', 'sanitized');

/** Documented endpoints (docs.newrelic.com "Meet NerdGraph", 2026-10-01). FedRAMP is not documented for NerdGraph. */
export const ENDPOINTS = {
  US: 'https://api.newrelic.com/graphql',
  EU: 'https://api.eu.newrelic.com/graphql',
  JP: 'https://api.jp.newrelic.com/graphql',
} as const;
export type Region = keyof typeof ENDPOINTS;

export interface Profile {
  label: 'A' | 'B';
  key: string;
  region: Region;
  accountId: number;
}

/** Matches New Relic key formats that must never be printed or saved unredacted. */
const KEY_RE = /\b(?:NRAK|NRAA|NRII|NRIK|NRIQ|NRJS|NRBR|NRSP)-[A-Za-z0-9_-]{10,}\b|\b[a-f0-9]{36}NRAL\b/g;

export function redact(text: string): string {
  return text.replace(KEY_RE, (m) => `${m.slice(0, 4)}-REDACTED`);
}

export function loadProfiles(env: NodeJS.ProcessEnv = process.env): Profile[] {
  const out: Profile[] = [];
  for (const label of ['A', 'B'] as const) {
    const key = env[`NR_KEY_${label}`];
    if (!key) continue;
    const region = (env[`NR_REGION_${label}`] ?? 'US').toUpperCase();
    if (!(region in ENDPOINTS))
      throw new Error(`NR_REGION_${label} must be one of ${Object.keys(ENDPOINTS).join(', ')}`);
    const accountId = Number(env[`NR_ACCOUNT_${label}`]);
    if (!Number.isInteger(accountId) || accountId <= 0)
      throw new Error(`NR_ACCOUNT_${label} must be a numeric account id`);
    if (!key.startsWith('NRAK-')) console.warn(`⚠ NR_KEY_${label} does not look like a User key (NRAK-…)`);
    out.push({ label, key, region: region as Region, accountId });
  }
  return out;
}

export interface GqlCall {
  endpoint: string;
  query: string;
  variables: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

export interface GqlResult {
  status: number;
  ok: boolean;
  durationMs: number;
  headers: Record<string, string>;
  body: unknown;
  bodyBytes: number;
  networkError?: string;
}

const KEEP_HEADERS =
  /^(content-type|retry-after|x-request-id|x-newrelic-.*|x-ratelimit-.*|newrelic-.*|server|date|x-.*)$/i;

/** POST a GraphQL document. Values only ever travel in `variables` (THREAT_MODEL T4). */
export async function gql(key: string, call: GqlCall, timeoutMs = 130_000): Promise<GqlResult> {
  const started = performance.now();
  try {
    const res = await fetch(call.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'API-Key': key,
        'User-Agent': 'relic-bridge-spike/0.0 (P0-09)',
        ...call.extraHeaders,
      },
      body: JSON.stringify({ query: call.query, variables: call.variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (KEEP_HEADERS.test(k) && k.toLowerCase() !== 'set-cookie') headers[k] = v;
    });
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep text (e.g. HTML error pages)
    }
    return {
      status: res.status,
      ok: res.ok,
      durationMs: Math.round(performance.now() - started),
      headers,
      body,
      bodyBytes: new TextEncoder().encode(text).length,
    };
  } catch (e) {
    return {
      status: 0,
      ok: false,
      durationMs: Math.round(performance.now() - started),
      headers: {},
      body: null,
      bodyBytes: 0,
      networkError: redact(String(e)),
    };
  }
}

/** Save a probe record to results/raw/<name>.json. The whole record is passed through `redact`. */
export function saveRaw(name: string, record: unknown): string {
  mkdirSync(RAW_DIR, { recursive: true });
  const path = join(RAW_DIR, `${name}.json`);
  writeFileSync(path, redact(JSON.stringify(record, null, 2)));
  return path;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
