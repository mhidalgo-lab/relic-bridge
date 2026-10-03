// SPDX-License-Identifier: Apache-2.0
import type { Region } from '../context.ts';

/** NerdGraph endpoints per region (RESEARCH §6, P0-09). No FedRAMP NerdGraph endpoint is documented. */
export const NERDGRAPH_ENDPOINTS: Readonly<Record<Region, string>> = Object.freeze({
  US: 'https://api.newrelic.com/graphql',
  EU: 'https://api.eu.newrelic.com/graphql',
  JP: 'https://api.jp.newrelic.com/graphql',
});

export const REGIONS: readonly Region[] = Object.freeze(['US', 'EU', 'JP'] as const);

export function endpointFor(region: Region): string {
  return NERDGRAPH_ENDPOINTS[region];
}
