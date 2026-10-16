// SPDX-License-Identifier: Apache-2.0
// A scripted `/me/*` admin API for the P4-15 screen tests: the signed-in member's own keys, grants and tokens, plus a
// second member's rows that the API never lists. Like the real API, an id that is not the caller's answers `404`.
import type { AdminCall, AdminCallResult } from '../src/index.ts';
import { T } from './fixtures.ts';

type Row = Record<string, unknown>;

const notFound: AdminCallResult = {
  status: 404,
  body: { error: { code: 'not_found', message: 'not found' } },
};

export const MY_KEY: Row = {
  id: 'cred_mine',
  label: 'My work key',
  region: 'US',
  ownerUserId: 'usr_member',
  keyHint: 'WXYZ',
  keyStorage: 'encrypted',
  validationStatus: 'valid',
  validationErrorCode: null,
  validatedAt: T,
  nrUserEmail: 'me@example.com',
  reachableAccountIds: [1, 2],
  createdAt: T,
  revokedAt: null,
};
export const MY_BAD_KEY: Row = {
  ...MY_KEY,
  id: 'cred_bad',
  label: 'Old key',
  keyHint: 'BAD1',
  validationStatus: 'invalid',
  validationErrorCode: 'RB_AUTH_INVALID_KEY',
};
export const MY_GRANT: Row = {
  id: 'grt_mine',
  projectId: 'prj_us',
  userId: 'usr_member',
  label: 'laptop grant',
  credentialId: null,
  tools: null,
  accountIds: null,
  limits: {},
  rateLimit: null,
  quota: null,
  createdAt: T,
  updatedAt: T,
  expiresAt: null,
  revokedAt: null,
  project: { slug: 'work-us', name: 'Work', disabled: false },
};
export const MY_REVOKED_GRANT: Row = { ...MY_GRANT, id: 'grt_old', label: 'old grant', revokedAt: T };
export const MY_TOKEN: Row = {
  id: 'tok_mine',
  grantId: 'grt_mine',
  prefix: 'rb_live_Ab3d',
  label: 'laptop',
  createdAt: T,
  expiresAt: T + 90 * 86_400_000,
  lastUsedAt: null,
  revokedAt: null,
};
/** Other people's ids: never listed, and every call naming them is a 404. */
export const THEIRS: { readonly key: string; readonly grant: string; readonly token: string } = {
  key: 'cred_theirs',
  grant: 'grt_theirs',
  token: 'tok_theirs',
};

export const NEW_TOKEN: string = ['rb', 'live', 'MEMBERoneTimeTokenValue0123456789abcdef'].join('_');

export interface MeScript {
  keys: Record<string, unknown>[];
  grants: Record<string, unknown>[];
  tokens: Record<string, unknown>[];
  /** Browser sessions (P8-96); the first is the current one. */
  sessions: Record<string, unknown>[];
  /** Answers for anything that changes something; undefined = the default for that call. */
  other?: (call: AdminCall) => AdminCallResult | undefined;
}

export const MY_SESSION: Record<string, unknown> = {
  id: '0123456789abcdef',
  createdAt: T,
  lastSeenAt: T,
  expiresAt: T + 12 * 3_600_000,
  idleExpiresAt: T + 1_800_000,
  client: 'Firefox on <b>Linux</b>',
  provider: 'github',
  current: true,
};
export const MY_OTHER_SESSION: Record<string, unknown> = {
  ...MY_SESSION,
  id: 'fedcba9876543210',
  client: null,
  current: false,
};

export function meScript(): MeScript {
  return {
    keys: [MY_KEY, MY_BAD_KEY],
    grants: [MY_GRANT, MY_REVOKED_GRANT],
    tokens: [MY_TOKEN],
    sessions: [MY_SESSION, MY_OTHER_SESSION],
  };
}

const ID = /^\/me\/(credentials|grants|tokens)\/([^/]+)(?:\/(\w+))?$/;

export function meApi(script: MeScript): (call: AdminCall) => AdminCallResult {
  return (call) => {
    const custom = script.other?.(call);
    if (custom !== undefined) return custom;
    if (call.method === 'GET') {
      const rows =
        call.path === '/me/credentials'
          ? script.keys
          : call.path === '/me/grants'
            ? script.grants
            : call.path === '/me/tokens'
              ? script.tokens
              : call.path === '/me/sessions'
                ? script.sessions
                : undefined;
      if (rows !== undefined) return { status: 200, body: { data: rows, nextCursor: null } };
    }
    const sess = /^\/me\/sessions\/([^/]+)\/revoke$/.exec(call.path);
    if (sess !== null && call.method === 'POST') {
      const row = script.sessions.find((r) => r['id'] === sess[1]);
      return row === undefined
        ? notFound
        : { status: 200, body: { data: { id: sess[1], current: row['current'] } } };
    }
    const m = ID.exec(call.path);
    if (m !== null) {
      const kind = m[1] as 'credentials' | 'grants' | 'tokens';
      const pool = { credentials: script.keys, grants: script.grants, tokens: script.tokens }[kind];
      const row = pool.find((r) => r['id'] === decodeURIComponent(m[2] as string));
      if (row === undefined) return notFound;
      const wanted = (call.body as { credentialId?: string | null } | undefined)?.credentialId;
      if (kind === 'grants' && typeof wanted === 'string' && !script.keys.some((k) => k['id'] === wanted))
        return notFound;
      if (call.method === 'DELETE') return { status: 204, body: null };
      if (m[3] === 'revalidate') return { status: 200, body: { data: { outcome: 'valid' } } };
      return { status: 200, body: { data: { ...row, ...(call.body as object) } } };
    }
    if (call.method === 'POST' && call.path === '/me/credentials')
      return {
        status: 201,
        body: { data: { ...MY_KEY, id: 'cred_new', label: (call.body as { label: string }).label } },
      };
    if (call.method === 'POST' && call.path === '/me/tokens') {
      const grantId = (call.body as { grantId: string }).grantId;
      if (!script.grants.some((g) => g['id'] === grantId)) return notFound;
      return {
        status: 201,
        body: {
          data: { ...MY_TOKEN, id: 'tok_new', label: (call.body as { label: string }).label },
          token: NEW_TOKEN,
          warnings: [],
        },
      };
    }
    return { status: 500, body: { error: { code: 'internal_error', message: 'unexpected call' } } };
  };
}
