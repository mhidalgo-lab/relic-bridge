// SPDX-License-Identifier: Apache-2.0
// Plain record builders for the access tests.
import { createBuiltinTools } from '@relic-bridge/core';
import type { CredentialRecord, GrantRecord, ProjectRecord, UserRecord } from '@relic-bridge/storage';
import type { ComputeAccessInput } from '../src/access/resolve.ts';

export const CATALOG: readonly string[] = createBuiltinTools().map((t) => t.name);
export const NOW = 1_800_000_000_000;

export const user = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: 'usr_a',
  email: 'a@example.com',
  displayName: null,
  idp: null,
  idpSubject: null,
  role: 'member',
  createdAt: 0,
  updatedAt: 0,
  disabledAt: null,
  ...over,
});

export const credential = (over: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id: 'cred_a',
  ownerUserId: 'usr_a',
  label: 'a',
  region: 'US',
  key: { kind: 'encrypted', ciphertext: new Uint8Array(32), iv: new Uint8Array(12), keyVersion: 1 },
  keyHint: 'abcd',
  validationStatus: 'valid',
  validationErrorCode: null,
  validatedAt: 0,
  nrUserId: 1,
  nrUserEmail: 'a@example.com',
  reachableAccountIds: [1, 2, 3, 4],
  createdAt: 0,
  updatedAt: 0,
  revokedAt: null,
  ...over,
});

export const project = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: 'prj_a',
  slug: 'prod',
  name: null,
  defaultAccountId: 1,
  allowedAccountIds: [1, 2, 3],
  enabledTools: null,
  limits: {},
  defaultCredentialId: 'cred_a',
  createdAt: 0,
  updatedAt: 0,
  disabledAt: null,
  ...over,
});

export const grant = (over: Partial<GrantRecord> = {}): GrantRecord => ({
  id: 'grt_a',
  projectId: 'prj_a',
  userId: 'usr_a',
  label: null,
  credentialId: null,
  tools: null,
  accountIds: null,
  limits: {},
  rateLimit: null,
  quota: null,
  createdAt: 0,
  updatedAt: 0,
  expiresAt: null,
  revokedAt: null,
  ...over,
});

export const input = (over: Partial<ComputeAccessInput> = {}): ComputeAccessInput => ({
  principal: { grantId: 'grt_a' },
  project: project(),
  grant: grant(),
  user: user(),
  credential: credential(),
  catalog: CATALOG,
  now: NOW,
  ...over,
});
