// SPDX-License-Identifier: Apache-2.0
// Boot check (ADR-0007): remote modes (`serve`, Workers) refuse to start without a valid master key.
import { CryptoError } from './errors.ts';
import { Keyring } from './keyring.ts';

export const MASTER_KEY_ENV = 'RB_MASTER_KEY';
export const PREVIOUS_MASTER_KEY_ENV = 'RB_MASTER_KEY_PREVIOUS';

/**
 * Build the keyring from `RB_MASTER_KEY` (required) and `RB_MASTER_KEY_PREVIOUS` (optional, during rotation).
 * Works with the Node process environment and the Worker `env` binding alike. Throws `CryptoError`
 * (`master_key_missing` / `master_key_invalid`); messages never include the values.
 */
export async function loadKeyringFromEnv(env: Readonly<Record<string, unknown>>): Promise<Keyring> {
  const read = (name: string): string | undefined => {
    const v = env[name];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') {
      throw new CryptoError('master_key_invalid', `${name} must be a string`);
    }
    return v.trim() === '' ? undefined : v;
  };
  const current = read(MASTER_KEY_ENV);
  const previous = read(PREVIOUS_MASTER_KEY_ENV);
  if (current === undefined) {
    throw new CryptoError(
      'master_key_missing',
      `${MASTER_KEY_ENV} is not set: remote modes need a master key to encrypt stored New Relic keys`,
      'Generate one with `relic-bridge keys generate`, store it in your secret manager, and back it up: losing it means re-entering every New Relic key.',
    );
  }
  return Keyring.create({ current, ...(previous === undefined ? {} : { previous }) });
}
