// SPDX-License-Identifier: Apache-2.0
// Access model (ADR-0008): the pure effective-permission resolver, its storage-backed wrapper and the domain services.
export {
  type AuthenticateAccessInput,
  type AuthenticatedAccess,
  authenticateAccess,
} from './authenticate.ts';
export {
  type CreateGrantInput,
  type CreateGrantResult,
  type CreateProjectInput,
  checkQuota,
  createGrant,
  createProject,
  MAX_ACCOUNTS,
  MAX_NAME_CHARS,
  MAX_TOOLS,
  setGrantQuota,
  type UpdateProjectInput,
  type UpdateProjectResult,
  updateProject,
} from './config.ts';
export {
  type CreateCredentialInput,
  type CredentialServiceDeps,
  createCredential,
  isKeyRejection,
  type KeyValidator,
  MAX_CREDENTIAL_LABEL,
  nerdGraphKeyValidator,
  type RevalidationOutcome,
  type RevalidationResult,
  type RotateCredentialKeyResult,
  revalidateCredential,
  revalidateCredentials,
  rotateCredentialKey,
} from './credentials.ts';
export { AccessError, type AccessErrorCode, isAccessError } from './errors.ts';
export {
  type EffectivePermission,
  listEffectivePermissions,
  type OpenCredentialOptions,
  openCredential,
  type ResolveAccessInput,
  type ResolvedAccess,
  resolveAccess,
} from './load.ts';
export {
  type AccessDecision,
  type ComputeAccessInput,
  computeAccess,
  credentialIdFor,
  credentialPermitted,
  DENY_REASONS,
  type DenyReason,
  type EffectiveAccess,
  limitsFrom,
  type Principal,
  tightenLimits,
} from './resolve.ts';
