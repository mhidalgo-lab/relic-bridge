// SPDX-License-Identifier: Apache-2.0
// A scripted admin API for the P4-04 screen tests: sample rows for every list, single reads by id, and a hook to
// answer anything else (changes, errors). The real admin API behind these screens is tested in the P2-12 suite.
import type { AdminCall, AdminCallResult, UiTool } from '../src/index.ts';
import { T } from './fixtures.ts';

export const TOOLS: readonly UiTool[] = [
  { name: 'run_nrql', title: 'Run NRQL', group: 'query', kind: 'read' },
  { name: 'get_query_result', title: 'Get a query result', group: 'query', kind: 'read' },
  { name: 'whoami', title: 'Who am I', group: 'identity', kind: 'read' },
  { name: 'list_accounts', title: 'List accounts', group: 'identity', kind: 'read' },
  { name: 'create_change_event', title: 'Record a deployment', group: 'changes', kind: 'write' },
];

export interface Sample {
  users: Record<string, unknown>[];
  credentials: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  grants: Record<string, unknown>[];
  tokens: Record<string, unknown>[];
}

export function sample(text = ''): Sample {
  return {
    users: [
      {
        id: 'usr_owner',
        email: 'owner@example.com',
        displayName: `Owner${text}`,
        idp: 'github',
        role: 'owner',
        createdAt: T,
        updatedAt: T,
        disabledAt: null,
      },
      {
        id: 'usr_admin',
        email: 'admin@example.com',
        displayName: null,
        idp: null,
        role: 'admin',
        createdAt: T,
        updatedAt: T,
        disabledAt: null,
      },
      {
        id: 'usr_m',
        email: 'm@example.com',
        displayName: null,
        idp: 'google',
        role: 'member',
        createdAt: T,
        updatedAt: T,
        disabledAt: T,
      },
      {
        id: 'usr_admin2',
        email: 'admin2@example.com',
        displayName: null,
        idp: 'github',
        role: 'admin',
        createdAt: T,
        updatedAt: T,
        disabledAt: null,
      },
    ],
    credentials: [
      {
        id: 'cred_us',
        label: `Work US${text}`,
        region: 'US',
        ownerUserId: null,
        keyHint: 'WXYZ',
        keyStorage: 'encrypted',
        keyVersion: 1,
        validationStatus: 'valid',
        validationErrorCode: null,
        validatedAt: T,
        nrUserId: 7,
        nrUserEmail: `nr${text}@example.com`,
        reachableAccountIds: [1, 2, 3],
        createdAt: T,
        updatedAt: T,
        revokedAt: null,
      },
      {
        id: 'cred_eu',
        label: 'Mine EU',
        region: 'EU',
        ownerUserId: 'usr_admin',
        keyHint: 'ABCD',
        keyStorage: 'encrypted',
        keyVersion: 1,
        validationStatus: 'invalid',
        validationErrorCode: 'RB_AUTH_INVALID_KEY',
        validatedAt: T,
        nrUserId: 8,
        nrUserEmail: null,
        reachableAccountIds: null,
        createdAt: T,
        updatedAt: T,
        revokedAt: null,
      },
    ],
    projects: [
      {
        id: 'prj_us',
        slug: 'work-us',
        name: `Work${text}`,
        defaultAccountId: 1,
        allowedAccountIds: [1, 2],
        enabledTools: null,
        limits: { maxLimit: 100, rawNrql: false, eventTypes: { deny: ['Secret'] } },
        defaultCredentialId: 'cred_us',
        createdAt: T,
        updatedAt: T,
        disabledAt: null,
      },
      {
        id: 'prj_eu',
        slug: 'work-eu',
        name: null,
        defaultAccountId: 3,
        allowedAccountIds: [3],
        enabledTools: ['whoami', 'run_nrql'],
        limits: {},
        defaultCredentialId: 'cred_eu',
        createdAt: T,
        updatedAt: T,
        disabledAt: T,
      },
    ],
    grants: [
      {
        id: 'grt_me',
        projectId: 'prj_us',
        userId: 'usr_admin',
        label: `laptop grant${text}`,
        credentialId: null,
        tools: null,
        accountIds: null,
        limits: {},
        rateLimit: { requests: 60, perSeconds: 60 },
        quota: null,
        createdAt: T,
        updatedAt: T,
        expiresAt: null,
        revokedAt: null,
      },
      {
        id: 'grt_ci',
        projectId: 'prj_eu',
        userId: null,
        label: 'ci',
        credentialId: 'cred_us',
        tools: ['whoami', 'list_accounts'],
        accountIds: [3, 4],
        limits: {},
        rateLimit: null,
        quota: null,
        createdAt: T,
        updatedAt: T,
        expiresAt: T - 1,
        revokedAt: null,
      },
    ],
    tokens: [
      {
        id: 'tok_laptop',
        grantId: 'grt_me',
        prefix: 'rb_live_Ab3d',
        label: `laptop${text}`,
        createdAt: T,
        expiresAt: T + 90 * 86_400_000,
        lastUsedAt: T,
        revokedAt: null,
      },
      {
        id: 'tok_old',
        grantId: 'grt_me',
        prefix: 'rb_live_Zz9y',
        label: 'old phone',
        createdAt: T,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: T,
      },
    ],
  };
}

const KINDS = ['users', 'credentials', 'projects', 'grants', 'tokens'] as const;

/**
 * Answers GET lists (`nextCursor` "NEXT" on table pages of 50, null for pickers of 200) and GET by id from `data`;
 * `other` answers everything else (default: 500).
 */
export function scriptedApi(
  data: Sample,
  other: (call: AdminCall) => AdminCallResult | undefined = () => undefined,
): (call: AdminCall) => AdminCallResult {
  return (call) => {
    const custom = other(call);
    if (custom !== undefined) return custom;
    if (call.method === 'GET') {
      const m = /^\/(users|credentials|projects|grants|tokens)(?:\/([^/]+))?$/.exec(call.path);
      const kind = m?.[1] as (typeof KINDS)[number] | undefined;
      if (kind !== undefined) {
        const rows = data[kind];
        if (m?.[2] !== undefined) {
          const row = rows.find((r) => r['id'] === decodeURIComponent(m[2] as string));
          return row
            ? { status: 200, body: { data: row } }
            : { status: 404, body: { error: { code: 'not_found', message: 'not found' } } };
        }
        return {
          status: 200,
          body: { data: rows, nextCursor: call.query?.['limit'] === '50' && rows.length > 0 ? 'NEXT' : null },
        };
      }
    }
    return { status: 500, body: { error: { code: 'internal_error', message: 'unexpected call' } } };
  };
}
