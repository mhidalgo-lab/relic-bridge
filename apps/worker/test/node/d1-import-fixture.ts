// SPDX-License-Identifier: Apache-2.0
// Shared between the Node global setup (`d1-import-setup.ts`) and the workerd test (`../d1-import.test.ts`). Types and
// constants only, so it loads in both runtimes.

/** Shaped like a User key so redaction is exercised; obviously fake. */
export const D1_IMPORT_NR_KEY = 'NRAK-D1IMPORTTESTKEY0123456789ABC';

export interface D1ImportFixture {
  /** The file `relic-bridge db export --format d1` wrote. */
  readonly sql: string;
  /** The self-hosted server's master key (test-only, random per run). */
  readonly masterKey: string;
  /** A device token issued on the server. */
  readonly token: string;
  /** A token revoked on the server: must stay revoked on the Worker. */
  readonly revokedToken: string;
  readonly credentialId: string;
}
