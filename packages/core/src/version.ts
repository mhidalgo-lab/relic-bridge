// SPDX-License-Identifier: Apache-2.0

/** Package version, kept in sync with package.json by the release pipeline (P1-15). */
export const VERSION = '0.9.1';

export const REPOSITORY_URL = 'https://github.com/mhidalgo-lab/relic-bridge';

/** Sent to NerdGraph so New Relic can identify the client. Contains no user data. */
export const USER_AGENT: string = `relic-bridge/${VERSION} (+${REPOSITORY_URL})`;
