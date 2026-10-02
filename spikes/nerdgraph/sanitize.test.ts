// SPDX-License-Identifier: Apache-2.0
// Run: node --test spikes/nerdgraph/sanitize.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loremFor, Sanitizer } from './sanitize.ts';

const guid = (s: string): string => btoa(s).replace(/=+$/, '');
const REAL_GUID = guid('3456789|APM|APPLICATION|424242');

const sample = {
  probe: 'entity_search_apm',
  response: {
    headers: { 'x-request-id': 'abc' },
    body: {
      data: {
        actor: {
          user: { id: 11223344, email: 'jane.doe@acme-corp.io', name: 'Jane Doe' },
          accounts: [{ id: 3456789, name: 'Acme Production' }],
          entitySearch: {
            results: {
              entities: [
                {
                  guid: REAL_GUID,
                  name: 'acme-checkout',
                  accountId: 3456789,
                  domain: 'APM',
                  type: 'APPLICATION',
                  tags: [{ key: 'host', values: ['ip-10-0-0-12.internal'] }],
                },
              ],
            },
          },
          nrql: {
            results: [{ facet: 'acme-checkout', count: 5 }],
            embeddedChartUrl: 'https://chart-embed.service.newrelic.com/charts/secret-token-123',
            nrql: "SELECT count(*) FROM Transaction WHERE appName = 'acme-checkout' AND host = '10.0.0.12'",
          },
          log: {
            message:
              'User jane.doe@acme-corp.io failed login from 10.0.0.12 with key NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ1',
          },
        },
      },
      errors: [{ message: 'Account 3456789 is not authorized for region EU' }],
    },
  },
};

test('replaces account ids, GUIDs, names, emails, IPs, keys consistently', () => {
  const s = new Sanitizer();
  const [out] = s.sanitizeAll([sample as never]);
  const text = JSON.stringify(out);
  for (const leak of [
    '3456789',
    'acme',
    'Acme',
    'jane',
    'Jane',
    '10.0.0.12',
    REAL_GUID,
    'NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ1',
    'secret-token',
    '11223344',
  ]) {
    assert.ok(!text.includes(leak), `leaked: ${leak}`);
  }
  const entity = (out as typeof sample).response.body.data.actor.entitySearch.results.entities[0];
  assert.ok(entity);
  assert.equal(entity.accountId, 1_000_001);
  assert.match(entity.name, /^name-\d+$/);
  // GUID decodes to a fake but structurally valid GUID with the mapped account id.
  assert.match(atob(entity.guid), /^1000001\|APM\|APPLICATION\|9000001$/);
  // Same real value → same fake value everywhere (facet + NRQL string + entity name).
  const nrql = (out as typeof sample).response.body.data.actor.nrql;
  assert.equal(nrql.results[0]?.facet, entity.name);
  assert.ok(nrql.nrql.includes(`'${entity.name}'`));
  assert.ok(nrql.embeddedChartUrl.endsWith('/REDACTED'));
});

test('keeps error messages (shape) but replaces ids inside them', () => {
  const [out] = new Sanitizer().sanitizeAll([sample as never]);
  const msg = (out as typeof sample).response.body.errors[0]?.message;
  assert.equal(msg, 'Account 1000001 is not authorized for region EU');
});

test('free text is replaced by lorem of the same length class', () => {
  assert.equal(loremFor('short').length, 16);
  assert.equal(loremFor('x'.repeat(100)).length <= 256, true);
  const [out] = new Sanitizer().sanitizeAll([sample as never]);
  assert.match((out as typeof sample).response.body.data.actor.log.message, /^lorem ipsum/);
});

test('is deterministic', () => {
  const a = JSON.stringify(new Sanitizer().sanitizeAll([sample as never]));
  const b = JSON.stringify(new Sanitizer().sanitizeAll([sample as never]));
  assert.equal(a, b);
});

test('known account ids from env are replaced even where no key hints them', () => {
  const [out] = new Sanitizer([777888999]).sanitizeAll([
    { note: 'account 777888999', n: 777888999 } as never,
  ]);
  assert.deepEqual(out, { note: 'account 1000001', n: 1000001 });
});

test('regression: schema/docs words and small counts are never rewritten', () => {
  const doc = {
    request: {
      query: 'query Q($accountId: Int!) { actor { account(id: $accountId) { nrql { results } } } }',
      variables: { accountId: 1234567 },
    },
    response: {
      body: {
        data: {
          actor: {
            account: {
              nrql: {
                eventDefinitions: [
                  {
                    name: 'Transaction',
                    label: 'count',
                    attributes: [{ name: 'duration', label: 'duration' }],
                  },
                ],
                metadata: { facets: ['appName'] },
                results: [{ appName: 'checkout-svc', count: 2 }],
              },
            },
            entitySearch: { results: { entities: [{ name: 'checkout-svc' }, { name: 'a' }] } },
          },
        },
        errors: [{ message: 'oops', count: 1 }],
      },
    },
    summary: [{ probe: 'nrql_sync_1', errors: 2, note: 'SELECT count(*) FROM Transaction FACET appName' }],
  };
  const [out] = new Sanitizer().sanitizeAll([doc as never]);
  const json = JSON.stringify(out);
  assert.match(json, /SELECT count\(\*\) FROM Transaction FACET appName/);
  assert.match(json, /"probe":"nrql_sync_1","errors":2/);
  assert.match(json, /"name":"Transaction"/);
  assert.doesNotMatch(json, /checkout-svc/);
  assert.doesNotMatch(json, /1234567/);
  assert.match(json, /"count":2/);
});

test('names are replaced as whole tokens only', () => {
  const [out] = new Sanitizer().sanitizeAll([
    { entities: [{ name: 'shop' }], note: "name = 'shop' and workshop and shop-api" } as never,
  ]);
  assert.match(JSON.stringify(out), /name = 'name-1' and workshop and shop-api/);
});

test('entity tag values are replaced (ids → fake ids, text → tag-N), enums kept', () => {
  const [out] = new Sanitizer().sanitizeAll([
    {
      tags: [
        { key: 'team', values: ['Payments Squad'] },
        { key: 'policyId', values: ['6421337'] },
        { key: 'type', values: ['NRQL'] },
      ],
    } as never,
  ]);
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /Payments Squad|6421337/);
  assert.match(json, /"NRQL"/);
});
