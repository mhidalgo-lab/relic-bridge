// SPDX-License-Identifier: Apache-2.0
// NerdGraph schema snapshot (P8-32, guard for BUG-02 of the live test run 2026-10-12).
//
//   RB_LIVE_API_KEY=NRAK-… pnpm nerdgraph:schema            fetch and write scripts/fixtures/nerdgraph-schema.json.gz
//   RB_LIVE_API_KEY=NRAK-… RB_LIVE_REGION=EU pnpm nerdgraph:schema
//
// The key (a User key) comes only from the environment and is sent only as the API-Key header to the fixed NerdGraph
// endpoint. It is never printed, never part of an error message and never written to the snapshot. The snapshot holds
// schema metadata (no descriptions) as gzipped introspection JSON; the document check in
// scripts/test/nerdgraph-documents.test.ts validates every static document against it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  buildClientSchema,
  type GraphQLSchema,
  getIntrospectionQuery,
  type IntrospectionQuery,
  parse,
  validate,
} from 'graphql';
import type { Region } from '../packages/core/src/context.ts';
import { endpointFor, REGIONS } from '../packages/core/src/nerdgraph/endpoints.ts';

export const SNAPSHOT_PATH = fileURLToPath(new URL('./fixtures/nerdgraph-schema.json.gz', import.meta.url));

/** Descriptions are dropped: they are most of the size and no validation rule reads them. */
export const INTROSPECTION_QUERY = getIntrospectionQuery({
  descriptions: false,
  specifiedByUrl: false,
  directiveIsRepeatable: false,
  schemaDescription: false,
  inputValueDeprecation: false,
});

export function encodeSnapshot(introspection: IntrospectionQuery): Buffer {
  // gzip with a fixed header (Node writes mtime 0), so an unchanged schema gives an identical file.
  return gzipSync(Buffer.from(JSON.stringify(introspection)), { level: 9 });
}

export function decodeSnapshot(bytes: Uint8Array): GraphQLSchema {
  const parsed = JSON.parse(gunzipSync(bytes).toString('utf8')) as IntrospectionQuery & {
    data?: IntrospectionQuery;
  };
  return buildClientSchema(parsed.data ?? parsed);
}

/** The committed schema, or null while no snapshot has been generated yet. A corrupt snapshot throws. */
export function loadSnapshot(path: string = SNAPSHOT_PATH): GraphQLSchema | null {
  if (!existsSync(path)) return null;
  return decodeSnapshot(readFileSync(path));
}

/** Validation messages for one document (empty when valid). A syntax error is reported the same way. */
export function validateDocument(schema: GraphQLSchema, query: string): string[] {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(query);
  } catch (error) {
    return [`syntax error: ${error instanceof Error ? error.message : String(error)}`];
  }
  return validate(schema, ast).map((e) => e.message);
}

export interface FetchOptions {
  apiKey: string;
  region: Region;
  fetchImpl?: typeof fetch;
}

/** Fetch the introspection result. Errors never include the key or the response body. */
export async function fetchIntrospection({
  apiKey,
  region,
  fetchImpl = fetch,
}: FetchOptions): Promise<IntrospectionQuery> {
  const res = await fetchImpl(endpointFor(region), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });
  if (!res.ok) throw new Error(`NerdGraph introspection failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: IntrospectionQuery; errors?: unknown[] };
  if (!body.data?.__schema) {
    const count = Array.isArray(body.errors) ? body.errors.length : 0;
    throw new Error(`NerdGraph introspection returned no schema (${count} GraphQL error(s)).`);
  }
  return body.data;
}

export async function main(
  env: Readonly<Record<string, string | undefined>>,
  out: (line: string) => void = (l) => console.warn(l),
  fetchImpl: typeof fetch = fetch,
  path: string = SNAPSHOT_PATH,
): Promise<number> {
  const apiKey = env['RB_LIVE_API_KEY'];
  if (!apiKey) {
    out('Set RB_LIVE_API_KEY to a New Relic User key (NRAK-…); optional RB_LIVE_REGION=US|EU|JP.');
    return 2;
  }
  const region = (env['RB_LIVE_REGION'] ?? 'US') as Region;
  if (!REGIONS.includes(region)) {
    out('RB_LIVE_REGION must be US, EU or JP.');
    return 2;
  }
  const introspection = await fetchIntrospection({ apiKey, region, fetchImpl });
  buildClientSchema(introspection); // fail before writing anything if the result is not a usable schema
  const bytes = encodeSnapshot(introspection);
  mkdirSync(dirname(path), { recursive: true }); // first run: scripts/fixtures/ does not exist yet
  writeFileSync(path, bytes);
  out(
    `Wrote ${path} (${(bytes.length / 1024).toFixed(0)} KiB, ${introspection.__schema.types.length} types).`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'nerdgraph:schema failed');
      process.exit(1);
    },
  );
}
