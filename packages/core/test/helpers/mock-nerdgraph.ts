// SPDX-License-Identifier: Apache-2.0
import type { FetchLike } from '../../src/index.ts';
import { fixtureResponse, json, type RecordedCall } from './nerdgraph.ts';

export const MOCK_ACCOUNT = 1000001;
export const MOCK_GUID: string = btoa(`${MOCK_ACCOUNT}|APM|APPLICATION|42`).replace(/=+$/, '');

const nrqlBody = (results: unknown[], field: 'nrql' | 'nrqlQueryProgress' = 'nrql') =>
  json({
    data: {
      actor: {
        account: {
          [field]: {
            results,
            metadata: { eventTypes: ['Transaction'], facets: null, messages: null, timeWindow: null },
            totalResult: null,
            otherResult: null,
            queryProgress: {
              queryId: null,
              completed: true,
              retryAfter: null,
              resultExpiration: null,
            },
          },
        },
      },
    },
  });

const entity = {
  guid: MOCK_GUID,
  name: 'checkout',
  accountId: MOCK_ACCOUNT,
  domain: 'APM',
  type: 'APPLICATION',
  entityType: 'APM_APPLICATION_ENTITY',
  alertSeverity: 'NOT_ALERTING',
  reporting: true,
};

/**
 * Replies for each NerdGraph operation the built-in tools send, keyed by the `Rb…` operation name in the document.
 * Shapes follow the sanitized P0-09 captures (`fixtures/nerdgraph/`); `RbNrql` is further routed by NRQL text.
 * Unknown operations fail loudly so a new tool cannot silently skip its contract test.
 */
export function mockNerdGraph(): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as RecordedCall['body'];
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body,
      signal: init.signal ?? undefined,
    });
    const q = body.query;
    const has = (op: string) => new RegExp(`query ${op}\\b`).test(q);
    if (has('RbIdentity') || has('RbAccounts')) {
      return json({
        data: {
          actor: {
            user: { id: 7, email: 'jane.doe@example.com', name: 'Jane' },
            accounts: [{ id: MOCK_ACCOUNT, name: 'Demo account' }],
          },
        },
      });
    }
    if (has('RbNrqlProgress')) return nrqlBody([{ count: 7 }], 'nrqlQueryProgress');
    if (has('RbNrql') || has('RbNrqlCrossAccount')) {
      const nrql = String(body.variables['nrql'] ?? '');
      if (nrql.startsWith('SHOW EVENT TYPES')) return nrqlBody([{ eventType: 'Transaction' }]);
      if (nrql.includes('keyset()')) return nrqlBody([{ key: 'duration', type: 'numeric' }]);
      if (nrql.includes('rate(count')) {
        return nrqlBody([{ beginTimeSeconds: 0, endTimeSeconds: 60, Throughput: 1 }]);
      }
      return fixtureResponse('nrql_sync_1');
    }
    if (has('RbAlertPolicies')) {
      return json({
        data: {
          actor: {
            account: {
              alerts: {
                policiesSearch: {
                  nextCursor: null,
                  totalCount: 1,
                  policies: [
                    {
                      id: '8000026',
                      name: 'checkout policy',
                      accountId: MOCK_ACCOUNT,
                      incidentPreference: 'PER_CONDITION',
                      entityGuid: btoa(`${MOCK_ACCOUNT}|AIOPS|POLICY|8000026`).replace(/=+$/, ''),
                    },
                  ],
                },
              },
            },
          },
        },
      });
    }
    if (has('RbAlertConditions')) {
      return json({
        data: {
          actor: {
            account: {
              alerts: {
                nrqlConditionsSearch: {
                  nextCursor: null,
                  totalCount: 1,
                  nrqlConditions: [
                    {
                      id: '9000001',
                      name: 'High error rate',
                      policyId: '8000026',
                      entityGuid: btoa(`${MOCK_ACCOUNT}|AIOPS|CONDITION|9000001`).replace(/=+$/, ''),
                      enabled: true,
                      type: 'STATIC',
                      nrql: { query: 'FROM TransactionError SELECT count(*)', dataAccountId: MOCK_ACCOUNT },
                      terms: [
                        {
                          priority: 'CRITICAL',
                          operator: 'ABOVE',
                          threshold: 5,
                          thresholdDuration: 300,
                          thresholdOccurrences: 'ALL',
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      });
    }
    if (has('RbErrorGroups')) {
      return json({
        data: {
          actor: {
            errorsInbox: {
              errorGroups: {
                nextCursor: null,
                totalCount: 1,
                results: [
                  {
                    id: 'eg-1',
                    name: 'TypeError',
                    message: "Cannot read properties of undefined (reading 'id')",
                    state: 'UNRESOLVED',
                    issueType: 'ERROR',
                    source: 'transaction',
                    isCustom: false,
                    entityGuid: btoa(`${MOCK_ACCOUNT}|APM|APPLICATION|42`).replace(/=+$/, ''),
                    firstSeenAt: 1790338648000,
                    lastSeenAt: 1790338700000,
                    regressedAt: null,
                    eventsQuery: "SELECT * FROM TransactionError WHERE error.group.guid = 'eg-1'",
                    url: 'https://one.newrelic.com/errors-inbox/eg-1',
                    occurrences: {
                      totalCount: 12,
                      expectedCount: 0,
                      firstSeenAt: 1790338648000,
                      lastSeenAt: 1790338700000,
                    },
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (has('RbAiIssues')) {
      return json({
        data: {
          actor: {
            account: {
              aiIssues: {
                issues: {
                  nextCursor: null,
                  issues: [
                    {
                      issueId: 'issue-1',
                      title: ['High error rate'],
                      description: ['checkout errors above 5'],
                      state: 'ACTIVATED',
                      priority: 'CRITICAL',
                      createdAt: 1790338648000,
                      activatedAt: 1790338650000,
                      closedAt: null,
                      updatedAt: 1790338700000,
                      acknowledgedAt: null,
                      accountIds: [MOCK_ACCOUNT],
                      entityGuids: [btoa(`${MOCK_ACCOUNT}|APM|APPLICATION|42`).replace(/=+$/, '')],
                      entityNames: ['checkout'],
                      entityTypes: ['APPLICATION'],
                      policyIds: [8000026],
                      policyName: ['checkout policy'],
                      conditionName: ['High error rate'],
                      sources: ['newrelic'],
                      mutingState: 'NOT_MUTED',
                      isCorrelated: false,
                      isIdle: false,
                      totalIncidents: 1,
                      deepLinkUrl: ['https://one.newrelic.com/alerts-ai/issues/issue-1'],
                    },
                  ],
                },
              },
            },
          },
        },
      });
    }
    if (has('RbAiIncidents')) {
      return json({
        data: {
          actor: {
            account: {
              aiIssues: {
                incidents: {
                  nextCursor: null,
                  incidents: [
                    {
                      incidentId: 'inc-1',
                      title: 'High error rate',
                      description: ['checkout errors above 5'],
                      state: 'CREATED',
                      priority: 'CRITICAL',
                      createdAt: 1790338648000,
                      closedAt: null,
                      updatedAt: 1790338700000,
                      timestamp: 1790338648000,
                      accountIds: String(MOCK_ACCOUNT),
                      entityGuids: btoa(`${MOCK_ACCOUNT}|APM|APPLICATION|42`).replace(/=+$/, ''),
                      entityNames: 'checkout',
                      entityTypes: 'APPLICATION',
                    },
                  ],
                },
              },
            },
          },
        },
      });
    }
    if (has('RbEntitySearch')) {
      return json({
        data: { actor: { entitySearch: { count: 1, results: { nextCursor: null, entities: [entity] } } } },
      });
    }
    if (has('RbEntityTypes')) {
      return json({
        data: {
          actor: {
            entitySearch: {
              count: 1,
              types: [{ domain: 'APM', type: 'APPLICATION', entityType: 'APM_APPLICATION_ENTITY', count: 1 }],
            },
          },
        },
      });
    }
    if (has('RbRelatedEntities')) {
      return json({
        data: {
          actor: {
            entity: {
              guid: MOCK_GUID,
              accountId: MOCK_ACCOUNT,
              name: 'checkout',
              relatedEntities: { nextCursor: null, results: [] },
            },
          },
        },
      });
    }
    if (has('RbGoldenMetrics')) {
      return json({
        data: {
          actor: {
            entity: {
              ...entity,
              goldenMetrics: {
                metrics: [
                  {
                    title: 'Throughput',
                    query: "FROM Metric SELECT rate(count(a), 1 minute) WHERE entity.guid = 'X'",
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (has('RbEntity')) {
      return json({
        data: {
          actor: {
            entity: {
              ...entity,
              tags: [{ key: 'team', values: ['payments'] }],
              goldenMetrics: { metrics: [{ title: 'Throughput' }] },
            },
          },
        },
      });
    }
    throw new Error(`mockNerdGraph: no reply for operation in: ${q.slice(0, 80)}`);
  };
  return { fetch, calls };
}
