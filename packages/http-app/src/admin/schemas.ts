// SPDX-License-Identifier: Apache-2.0
// Admin API request/response schemas (P2-09). Requests are strict (unknown fields are refused, so a misspelt field
// never silently does nothing); responses document what is returned and never include key material or token hashes.
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------------

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ description: 'Stable error code (`invalid_request`, `not_found`, …).' }),
      message: z.string().openapi({ description: 'Human-readable; never echoes submitted values.' }),
      field: z.string().optional().openapi({ description: 'The input field at fault, when there is one.' }),
      detail: z
        .string()
        .optional()
        .openapi({ description: 'Extra stable code, e.g. the `RB_*` code New Relic answered with.' }),
    }),
  })
  .openapi('Error');

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Path `{id}`: any id-shaped value; a well-formed id of the wrong kind is simply not found. */
export const IdParam = z.strictObject({
  id: z
    .string()
    .regex(ID_RE)
    .openapi({ param: { name: 'id', in: 'path' }, example: 'prj_0123456789abcdef0123456789abcdef' }),
});

const idRef = (description: string) => z.string().regex(ID_RE).openapi({ description });

const limitQuery = z.coerce
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .openapi({ description: 'Page size, 1-200 (default 50).', type: 'integer' });
const cursorQuery = z
  .string()
  .max(200)
  .optional()
  .openapi({ description: '`nextCursor` from the previous page.' });

export const PageQuery = z.strictObject({ limit: limitQuery, cursor: cursorQuery });

const timestamp = (description: string) =>
  z
    .number()
    .int()
    .openapi({ description: `${description} (epoch ms)` });
const nullableTimestamp = (description: string) =>
  z
    .number()
    .int()
    .nullable()
    .openapi({ description: `${description} (epoch ms, null = none)` });

const warnings = z.array(z.string()).openapi({
  description: 'Non-fatal notes about the change (e.g. parts of a grant the project does not allow).',
});

const accountId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const accountIds = z.array(accountId).min(1).max(1000);
const toolNames = z.array(z.string().min(1).max(64)).min(1).max(200);
/**
 * Control characters (C0, DEL, C1), line/paragraph separators and bidi overrides/isolates. Names are printed by the
 * CLI and the admin panel, so they must not move the cursor, colour a terminal or reorder the text around them.
 */
function hasUnsafeChar(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !hasUnsafeChar(v), 'must not contain control or bidi characters')
    .refine((v) => v.trim() !== '', 'must not be blank');
const label = text(100);
const region = z.enum(['US', 'EU', 'JP']);

const LimitsSchema = z
  .strictObject({
    maxLimit: z.number().int().positive().optional(),
    maxWindowDays: z.number().int().positive().optional(),
    rawNrql: z.boolean().optional(),
    maxResponseBytes: z.number().int().positive().optional(),
    eventTypes: z
      .strictObject({
        allow: z.array(z.string().min(1).max(255)).max(200).optional(),
        deny: z.array(z.string().min(1).max(255)).max(200).optional(),
      })
      .optional(),
  })
  .openapi('Limits', { description: 'Query limits; absent fields fall back to the defaults.' });

const RateLimitSchema = z
  .strictObject({
    requests: z.number().int().min(1).max(1_000_000),
    perSeconds: z.number().int().min(1).max(86_400),
  })
  .openapi('RateLimit');

const page = <T extends z.ZodType>(item: T, name: string) =>
  z
    .object({
      data: z.array(item),
      nextCursor: z
        .string()
        .nullable()
        .openapi({ description: 'Pass as `cursor` for the next page; null at the end.' }),
    })
    .openapi(name);

const one = <T extends z.ZodType>(item: T, name: string) =>
  z.object({ data: item, warnings: warnings.optional() }).openapi(name);

// ---------------------------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------------------------

export const UserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    idp: z.string().nullable(),
    role: z.enum(['owner', 'admin', 'member']),
    createdAt: timestamp('Created'),
    updatedAt: timestamp('Last change'),
    disabledAt: nullableTimestamp('Disabled since'),
  })
  .openapi('User');

export const CreateUserBody = z
  .strictObject({
    email: z.email().max(320),
    displayName: text(100).nullable().optional(),
    role: z.enum(['owner', 'admin', 'member']).optional().openapi({ description: 'Default `member`.' }),
  })
  .openapi('CreateUser');

export const UpdateUserBody = z
  .strictObject({
    displayName: text(100).nullable().optional(),
    role: z.enum(['owner', 'admin', 'member']).optional(),
    disabled: z.boolean().optional().openapi({
      description: 'true disables the user: every grant of theirs and every key they own stops.',
    }),
  })
  .openapi('UpdateUser');

export const UserPage = page(UserSchema, 'UserPage');
export const UserOne = one(UserSchema, 'UserResponse');

// ---------------------------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------------------------

export const CredentialSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    region: region,
    ownerUserId: z.string().nullable(),
    keyHint: z
      .string()
      .nullable()
      .openapi({ description: 'Last 4 characters of the key, for recognition only.' }),
    keyStorage: z
      .enum(['encrypted', 'env', 'inline'])
      .openapi({ description: 'Where the key lives. The key itself is never returned.' }),
    keyVersion: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Master key version it is encrypted under.' }),
    validationStatus: z.enum(['unvalidated', 'valid', 'invalid']),
    validationErrorCode: z.string().nullable(),
    validatedAt: nullableTimestamp('Last validation'),
    nrUserId: z.number().int().nullable(),
    nrUserEmail: z.string().nullable(),
    reachableAccountIds: z.array(z.number().int()).nullable(),
    createdAt: timestamp('Created'),
    updatedAt: timestamp('Last change'),
    revokedAt: nullableTimestamp('Revoked'),
  })
  .openapi('Credential', {
    description: 'Masked credential metadata. Key plaintext and ciphertext are never returned.',
  });

const apiKey = z.string().min(1).max(200).openapi({
  description: 'New Relic User API key (`NRAK-…`). Accepted in the request body only; never returned.',
});

export const CreateCredentialBody = z
  .strictObject({
    label,
    region,
    apiKey,
    ownerUserId: idRef('User who owns this key (their personal key); omit for a shared key.')
      .nullable()
      .optional(),
  })
  .openapi('CreateCredential');

export const UpdateCredentialBody = z.strictObject({ label }).openapi('UpdateCredential');
export const RotateCredentialBody = z.strictObject({ apiKey }).openapi('RotateCredential');

export const CredentialQuery = PageQuery.extend({
  ownerUserId: idRef('Only keys this user owns.').optional(),
});

export const RevalidationSchema = z
  .object({
    id: z.string(),
    outcome: z.enum(['valid', 'invalid', 'error', 'skipped']),
    code: z.string().nullable(),
    accountsAdded: z.array(z.number().int()),
    accountsRemoved: z.array(z.number().int()),
  })
  .openapi('Revalidation');

export const CredentialPage = page(CredentialSchema, 'CredentialPage');
export const CredentialOne = one(CredentialSchema, 'CredentialResponse');
export const RevalidationOne = z
  .object({ data: RevalidationSchema, credential: CredentialSchema })
  .openapi('RevalidationResponse');

// ---------------------------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------------------------

export const ProjectSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string().nullable(),
    defaultAccountId: z.number().int(),
    allowedAccountIds: z.array(z.number().int()),
    enabledTools: z.array(z.string()).nullable().openapi({ description: 'null = every built-in tool.' }),
    limits: LimitsSchema,
    defaultCredentialId: z.string().nullable(),
    createdAt: timestamp('Created'),
    updatedAt: timestamp('Last change'),
    disabledAt: nullableTimestamp('Disabled since'),
  })
  .openapi('Project');

const slug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
  .openapi({ description: 'URL slug: `/p/{slug}/mcp`.' });

export const CreateProjectBody = z
  .strictObject({
    slug,
    name: text(100).nullable().optional(),
    defaultAccountId: accountId,
    allowedAccountIds: accountIds,
    enabledTools: toolNames
      .nullable()
      .optional()
      .openapi({ description: 'Upper limit of tools; null = all.' }),
    limits: LimitsSchema.optional(),
    defaultCredentialId: idRef('Credential used by grants that name none.').nullable().optional(),
  })
  .openapi('CreateProject');

export const UpdateProjectBody = z
  .strictObject({
    slug: slug.optional(),
    name: text(100).nullable().optional(),
    defaultAccountId: accountId.optional(),
    allowedAccountIds: accountIds.optional(),
    enabledTools: toolNames.nullable().optional(),
    limits: LimitsSchema.optional().openapi({ description: 'Replaces the limits as a whole.' }),
    defaultCredentialId: idRef('Credential used by grants that name none.').nullable().optional(),
    disabled: z.boolean().optional().openapi({ description: 'true refuses every request to the project.' }),
  })
  .openapi('UpdateProject');

export const ProjectQuery = PageQuery.extend({ slug: slug.optional() });
export const ProjectPage = page(ProjectSchema, 'ProjectPage');
export const ProjectOne = one(ProjectSchema, 'ProjectResponse');

// ---------------------------------------------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------------------------------------------

export const GrantSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    userId: z.string().nullable().openapi({ description: 'null for a service grant.' }),
    label: z.string().nullable(),
    credentialId: z.string().nullable().openapi({ description: "null = the project's default credential." }),
    tools: z.array(z.string()).nullable(),
    accountIds: z.array(z.number().int()).nullable(),
    limits: LimitsSchema,
    rateLimit: RateLimitSchema.nullable(),
    createdAt: timestamp('Created'),
    updatedAt: timestamp('Last change'),
    expiresAt: nullableTimestamp('Expires'),
    revokedAt: nullableTimestamp('Revoked'),
  })
  .openapi('Grant');

export const CreateGrantBody = z
  .strictObject({
    projectId: idRef('Project the grant is for.'),
    userId: idRef('User the grant is for; omit for a service grant (then `label` is required).')
      .nullable()
      .optional(),
    label: label.nullable().optional(),
    credentialId: idRef("Key to use; null = the project's default.").nullable().optional(),
    tools: toolNames
      .nullable()
      .optional()
      .openapi({ description: 'Tool allowlist; null = all the project enables.' }),
    accountIds: accountIds.nullable().optional(),
    limits: LimitsSchema.optional(),
    rateLimit: RateLimitSchema.nullable().optional(),
    expiresAt: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .openapi({ description: 'Epoch ms, in the future.' }),
  })
  .openapi('CreateGrant');

export const GrantQuery = PageQuery.extend({
  projectId: idRef('Only this project.').optional(),
  userId: idRef('Only this user.').optional(),
});
export const GrantPage = page(GrantSchema, 'GrantPage');
export const GrantOne = one(GrantSchema, 'GrantResponse');

// ---------------------------------------------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------------------------------------------

export const TokenSchema = z
  .object({
    id: z.string(),
    grantId: z.string(),
    prefix: z.string().openapi({ description: 'First characters (`rb_live_Ab3d`), for recognition only.' }),
    label: z.string(),
    createdAt: timestamp('Created'),
    expiresAt: nullableTimestamp('Expires'),
    lastUsedAt: nullableTimestamp('Last used (updated at most every 5 min)'),
    revokedAt: nullableTimestamp('Revoked'),
  })
  .openapi('AccessToken', { description: 'Token metadata. The token hash is never returned.' });

/** Ten years, in seconds. */
const MAX_TTL_SECONDS = 10 * 365 * 86_400;

export const CreateTokenBody = z
  .strictObject({
    grantId: idRef('Grant the token authenticates.'),
    label: label.openapi({ description: 'Device name (`laptop`, `work-pc`).' }),
    ttlSeconds: z
      .union([z.number().int().min(60).max(MAX_TTL_SECONDS), z.literal('never')])
      .optional()
      .openapi({ description: "Lifetime in seconds (default 90 days), or `'never'` (warned)." }),
  })
  .openapi('CreateToken');

export const TokenQuery = PageQuery.extend({ grantId: idRef('Only this grant.').optional() });
export const TokenPage = page(TokenSchema, 'AccessTokenPage');
export const TokenOne = one(TokenSchema, 'AccessTokenResponse');
export const TokenCreated = z
  .object({
    data: TokenSchema,
    token: z
      .string()
      .openapi({ description: 'The token. Shown once: it is not stored and cannot be recovered.' }),
    warnings,
  })
  .openapi('AccessTokenCreated');

// ---------------------------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------------------------

export const AuditSchema = z
  .object({
    id: z.number().int(),
    ts: timestamp('When'),
    kind: z.enum(['tool_call', 'admin', 'auth']),
    action: z.string(),
    status: z.enum(['ok', 'error', 'denied']),
    requestId: z.string().nullable(),
    userId: z.string().nullable(),
    grantId: z.string().nullable(),
    tokenId: z.string().nullable(),
    clientId: z.string().nullable(),
    keyId: z
      .string()
      .nullable()
      .openapi({ description: 'Pass-through key fingerprint id (`pt_…`); never the key.' }),
    projectId: z.string().nullable(),
    accountIds: z.array(z.number().int()).nullable(),
    nrql: z.string().nullable().openapi({ description: 'Masked, hashed or full NRQL (RB_AUDIT_NRQL).' }),
    durationMs: z.number().int().nullable(),
    inspectedCount: z.number().int().nullable(),
    errorCode: z.string().nullable(),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    details: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi('AuditEntry');

const timeQuery = (description: string) =>
  z
    .string()
    .max(40)
    .optional()
    .openapi({ description: `${description}: epoch ms or an ISO 8601 date-time.` });

export const AuditQuerySchema = z.strictObject({
  kind: z.enum(['tool_call', 'admin', 'auth']).optional(),
  action: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
    .optional()
    .openapi({ description: 'Exact action: a tool name or `token.create`, `auth.denied`, ….' }),
  status: z.enum(['ok', 'error', 'denied']).optional(),
  projectId: idRef('Only this project.').optional(),
  userId: idRef('Only this user.').optional(),
  grantId: idRef('Only this grant.').optional(),
  tokenId: idRef('Only this access token.').optional(),
  keyId: z
    .string()
    .regex(/^(pt_[0-9a-f]{12}|any)$/)
    .optional()
    .openapi({
      description: 'Pass-through rows: one key fingerprint id (`pt_…`), or `any` for all pass-through rows.',
    }),
  since: timeQuery('Inclusive lower bound'),
  until: timeQuery('Exclusive upper bound'),
  limit: limitQuery,
  cursor: cursorQuery,
});
export const AuditPage = page(AuditSchema, 'AuditPage');

// ---------------------------------------------------------------------------------------------------------------
// Master key (P3-11)
// ---------------------------------------------------------------------------------------------------------------

/** Rows re-encrypted per call by default: about 30 storage calls, well inside a Worker invocation's limits. */
export const DEFAULT_ROTATION_BATCH = 25;
export const MAX_ROTATION_BATCH_SIZE = 100;

export const RotateKeysBody = z
  .strictObject({
    batchSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_ROTATION_BATCH_SIZE)
      .optional()
      .openapi({
        description:
          'Rows to re-encrypt in this call, 1-100 (default 25). A Worker on the Free plan lowers the ceiling to 40 ' +
          '(one call stays under 50 D1 queries); a larger value is reduced, not refused, and `nextCursor` resumes.',
      }),
    after: idRef('`nextCursor` of the previous call; omit to start from the first row.')
      .nullable()
      .optional(),
  })
  .openapi('RotateKeys');

export const KeyRotationSchema = z
  .object({
    currentVersion: z.number().int().openapi({ description: 'The version rows are re-encrypted under.' }),
    total: z.number().int().openapi({ description: 'Credentials with an encrypted key (whole table).' }),
    reencrypted: z.array(z.string()).openapi({ description: 'Credential ids re-encrypted by this call.' }),
    alreadyCurrent: z
      .number()
      .int()
      .openapi({ description: 'Rows of the range this call scanned that were already current.' }),
    failed: z.array(z.object({ id: z.string(), code: z.string() })).openapi({
      description:
        'Rows left unchanged: `conflict` (changed meanwhile; run again), `key_version_unknown` (its key is not ' +
        'loaded: set RB_MASTER_KEY_PREVIOUS), `decrypt_failed` (damaged or tampered row).',
    }),
    nextCursor: z
      .string()
      .nullable()
      .openapi({ description: 'Send as `after` to continue; `null` once every row was visited.' }),
    pending: z
      .number()
      .int()
      .openapi({ description: 'Rows (whole table) not on the current version after this call.' }),
    versionsInUse: z.array(z.number().int()).openapi({
      description:
        'Key versions stored after this call. `[currentVersion]` (or `[]`): the previous key can go.',
    }),
  })
  .openapi('KeyRotation');

export const KeyRotationOne = z.object({ data: KeyRotationSchema }).openapi('KeyRotationResponse');
