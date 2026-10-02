// SPDX-License-Identifier: Apache-2.0
// Minimal KVNamespace implementation over node:sqlite — exactly the surface workers-oauth-provider 1.2.x
// uses: get (text/json), put (expiration | expirationTtl, metadata), delete, list (prefix, limit, cursor).
import { DatabaseSync } from 'node:sqlite';

interface Row {
  key: string;
  value: string;
  expiration: number | null;
  metadata: string | null;
}

type GetType = 'text' | 'json';

export class SqliteKv {
  readonly #db: DatabaseSync;

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, expiration INTEGER, metadata TEXT
    ) STRICT`);
  }

  #now(): number {
    return Math.floor(Date.now() / 1000);
  }

  async get(key: string, options?: GetType | { type?: GetType }): Promise<unknown> {
    const type = typeof options === 'string' ? options : (options?.type ?? 'text');
    const row = this.#db.prepare('SELECT * FROM kv WHERE key = ?').get(key) as Row | undefined;
    if (!row) return null;
    if (row.expiration !== null && row.expiration <= this.#now()) {
      this.#db.prepare('DELETE FROM kv WHERE key = ?').run(key);
      return null;
    }
    return type === 'json' ? JSON.parse(row.value) : row.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
  ): Promise<void> {
    // Cloudflare KV: minimum TTL 60 s; expiration is absolute epoch seconds.
    const expiration =
      options?.expiration ??
      (options?.expirationTtl !== undefined ? this.#now() + Math.max(60, options.expirationTtl) : null);
    const metadata = options?.metadata === undefined ? null : JSON.stringify(options.metadata);
    this.#db
      .prepare(
        'INSERT INTO kv (key, value, expiration, metadata) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expiration = excluded.expiration, metadata = excluded.metadata',
      )
      .run(key, value, expiration, metadata);
  }

  async delete(key: string): Promise<void> {
    this.#db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; expiration?: number; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? '';
    const limit = Math.min(options?.limit ?? 1000, 1000);
    const after = options?.cursor ? atob(options.cursor) : '';
    // Range scan on the primary key: prefix <= key < prefix + U+FFFF, strictly after the cursor key.
    const rows = this.#db
      .prepare(
        'SELECT key, expiration, metadata FROM kv WHERE key >= ? AND key < ? AND key > ? ' +
          'AND (expiration IS NULL OR expiration > ?) ORDER BY key LIMIT ?',
      )
      .all(prefix, `${prefix}￿`, after, this.#now(), limit + 1) as Omit<Row, 'value'>[];
    const page = rows.slice(0, limit);
    const complete = rows.length <= limit;
    const last = page[page.length - 1];
    return {
      keys: page.map((r) => ({
        name: r.key,
        ...(r.expiration !== null ? { expiration: r.expiration } : {}),
        ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) } : {}),
      })),
      list_complete: complete,
      ...(complete || !last ? {} : { cursor: btoa(last.key) }),
    };
  }
}
