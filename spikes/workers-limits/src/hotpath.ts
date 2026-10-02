// SPDX-License-Identifier: Apache-2.0
// P0-06 spike: the CPU-relevant pieces of a relic-bridge tool call, web-standard APIs only,
// shared by the Worker (src/worker.ts) and the Node cross-check (src/node-bench.ts).

export const SIZES: Record<string, number> = {
  '10k': 10 * 1024,
  '100k': 100 * 1024,
  '1m': 1024 * 1024,
  '5m': 5 * 1024 * 1024,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Step 1: hash a bearer token (high-entropy, so a single SHA-256 is enough — ADR-0007). */
export async function hashToken(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(token)));
}

/** Step 2a: import the master key. Done once per isolate and cached. */
export async function importMasterKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64ToBytes(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(
  key: CryptoKey,
  plaintext: string,
  aad: string,
): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plaintext),
  );
  return { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
}

/** Step 2b: decrypt a stored NR key (AAD = credential id || key version). */
export async function decryptSecret(
  key: CryptoKey,
  ivB64: string,
  ctB64: string,
  aad: string,
): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(ivB64), additionalData: enc.encode(aad) },
    key,
    b64ToBytes(ctB64),
  );
  return dec.decode(pt);
}

/** Synthetic NerdGraph NRQL response of roughly `targetBytes` (Transaction-like rows). */
export function makeNrqlPayload(targetBytes: number): string {
  const head = '{"data":{"actor":{"account":{"nrql":{"metadata":{"eventTypes":["Transaction"]},"results":[';
  const tail = ']}}}}}';
  const parts: string[] = [];
  let size = head.length + tail.length;
  let i = 0;
  while (size < targetBytes) {
    const row = JSON.stringify({
      timestamp: 1790000000000 + i * 1000,
      appName: `checkout-service-${i % 7}`,
      name: `WebTransaction/Controller/orders/${i % 53}/show`,
      duration: ((i * 7919) % 5000) / 1000,
      error: i % 17 === 0,
      host: `ip-10-0-${i % 255}-${(i * 13) % 255}`,
      'request.uri': `/api/v2/orders/${100000 + i}?expand=items,customer&trace=${(i * 2654435761) % 4294967296}`,
      'response.status': i % 17 === 0 ? '500' : '200',
      traceId: `${(i * 2654435761).toString(16).padStart(16, '0')}${i.toString(16).padStart(16, '0')}`,
    });
    parts.push(row);
    size += row.length + 1;
    i++;
  }
  return head + parts.join(',') + tail;
}

export interface Shaped {
  text: string;
  totalRows: number;
  shownRows: number;
  truncated: boolean;
}

/** Step 4: parse + shape to a compact markdown table (row cap, cell cap). */
export function parseAndShape(body: string, maxRows = 200, maxCell = 80): Shaped {
  const json = JSON.parse(body) as {
    data?: { actor?: { account?: { nrql?: { results?: Record<string, unknown>[] } } } };
  };
  return shapeRows(json.data?.actor?.account?.nrql?.results ?? [], maxRows, maxCell);
}

export function shapeRows(rows: Record<string, unknown>[], maxRows = 200, maxCell = 80): Shaped {
  const shown = rows.slice(0, maxRows);
  const cols: string[] = [];
  for (const r of shown.slice(0, 20)) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const cell = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    const t = s.length > maxCell ? `${s.slice(0, maxCell - 1)}…` : s;
    return t.replaceAll('|', '\\|').replaceAll('\n', ' ');
  };
  const lines = [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`];
  for (const r of shown) lines.push(`| ${cols.map((c) => cell(r[c])).join(' | ')} |`);
  const truncated = rows.length > shown.length;
  if (truncated)
    lines.push(`\n_Showing ${shown.length} of ${rows.length} rows. Narrow the query (WHERE, LIMIT)._`);
  return { text: lines.join('\n'), totalRows: rows.length, shownRows: shown.length, truncated };
}

/** Read a response body with a byte cap enforced while streaming (before JSON.parse). */
export async function readCapped(res: Response, maxBytes: number): Promise<{ body: string; bytes: number }> {
  const reader = res.body?.getReader();
  if (!reader) return { body: '', bytes: 0 };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`RB_LIMIT_RESPONSE_TOO_LARGE: response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { body: dec.decode(all), bytes };
}

/** Subrequest counter for one invocation (ADR-0010 budget). */
export class Budget {
  used = 0;
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  spend(n = 1): void {
    if (this.used + n > this.limit) throw new Error('RB_BUDGET_EXHAUSTED');
    this.used += n;
  }
}
