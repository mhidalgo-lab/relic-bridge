// SPDX-License-Identifier: Apache-2.0
// Public crypto API (ADR-0007). Internals (`seal`, `open`, `deriveVersionKeys`, `parseMasterKey`) stay unexported
// so no caller can pick its own IV or handle raw master key bytes.
export { timingSafeEqual } from './bytes.ts';
export { loadKeyringFromEnv, MASTER_KEY_ENV, PREVIOUS_MASTER_KEY_ENV } from './env.ts';
export { CryptoError, type CryptoErrorCode, isCryptoError } from './errors.ts';
export { generateMasterKey, Keyring, MASTER_KEY_BYTES, MAX_KEY_VERSION } from './keyring.ts';
export {
  describeUnreadableKeys,
  keyCheckSettingKey,
  MAX_ROTATION_BATCH,
  type RotationBatchReport,
  type RotationFailureCode,
  type RotationReport,
  rotateCredentialKeys,
  rotateCredentialKeysBatch,
  type VerifyKeyChecksResult,
  verifyKeyChecks,
} from './rotate.ts';
