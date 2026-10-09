// SPDX-License-Identifier: Apache-2.0
// The Workers-KV surface `@cloudflare/workers-oauth-provider` 1.2.x uses (`get` text/json, `put` with expiry and
// metadata, `delete`, `list` by prefix with a cursor), over the storage `kv` table (ADR-0011): SQLite on Node, D1 on
// Workers. Every provider key lives under `oauth:` so the table's other users (sign-in state, sessions, setup links)
// can never collide with it, and the hourly expired-row purge (P4-09) reclaims abandoned grants and tokens too.
//
// Key metadata is dropped: the provider uses it only to skip reading grant records while it looks for grants to
// replace, and reads the record instead when a key carries none (correct, one extra read per grant of that user).
import type { KvRepository } from '@relic-bridge/storage';

/** Prefix of every provider key in the `kv` table. */
export const OAUTH_KV_PREFIX = 'oauth:';

type GetType = 'text' | 'json';

interface ListKey {
  readonly name: string;
  readonly expiration?: number;
}

/** What the provider sees as `env.OAUTH_KV`. */
export interface OAuthKvNamespace {
  get(key: string, options?: GetType | { readonly type?: GetType }): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { readonly expiration?: number; readonly expirationTtl?: number; readonly metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { readonly prefix?: string; readonly limit?: number; readonly cursor?: string }): Promise<{
    readonly keys: readonly ListKey[];
    readonly list_complete: boolean;
    readonly cursor?: string;
  }>;
}

/** The provider's KV namespace over `kv` (only the methods it calls; values are strings, as on Workers KV). */
export function oauthKvNamespace(
  kv: Pick<KvRepository, 'get' | 'put' | 'delete' | 'list'>,
): OAuthKvNamespace {
  const full = (key: string): string => {
    if (typeof key !== 'string' || key === '') throw new TypeError('kv key must be a non-empty string');
    return `${OAUTH_KV_PREFIX}${key}`;
  };
  return Object.freeze({
    async get(key: string, options?: GetType | { readonly type?: GetType }): Promise<unknown> {
      const type = typeof options === 'string' ? options : (options?.type ?? 'text');
      const value = await kv.get(full(key));
      if (value === null) return null;
      if (type === 'json') return JSON.parse(value) as unknown;
      if (type === 'text') return value;
      throw new TypeError(`unsupported kv get type: ${String(type)}`);
    },
    async put(
      key: string,
      value: string,
      options: {
        readonly expiration?: number;
        readonly expirationTtl?: number;
        readonly metadata?: unknown;
      } = {},
    ): Promise<void> {
      if (typeof value !== 'string') throw new TypeError('kv values must be strings');
      await kv.put(full(key), value, {
        ...(options.expiration === undefined ? {} : { expiration: options.expiration }),
        ...(options.expirationTtl === undefined ? {} : { expirationTtl: options.expirationTtl }),
      });
    },
    async delete(key: string): Promise<void> {
      await kv.delete(full(key));
    },
    async list(
      options: { readonly prefix?: string; readonly limit?: number; readonly cursor?: string } = {},
    ) {
      const page = await kv.list({
        prefix: `${OAUTH_KV_PREFIX}${options.prefix ?? ''}`,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      });
      return {
        keys: page.keys.map((k) => ({
          name: k.name.slice(OAUTH_KV_PREFIX.length),
          ...(k.expiration === undefined ? {} : { expiration: k.expiration }),
        })),
        list_complete: page.complete,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      };
    },
  });
}
