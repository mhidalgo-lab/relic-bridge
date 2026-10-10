// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  createBudget,
  createSemaphoreLimiter,
  DocumentError,
  defineDocument,
  LimiterPool,
  NerdGraphClient,
  Secret,
  silentLogger,
} from '../src/index.ts';
import { FAKE_KEY } from './helpers/context.ts';
import { json } from './helpers/nerdgraph.ts';

describe('defineDocument (T4)', () => {
  it('accepts a named operation with variables', () => {
    const doc = defineDocument('query RbOk($guid: EntityGuid!) { actor { entity(guid: $guid) { name } } }');
    expect(doc.name).toBe('RbOk');
    expect(Object.isFrozen(doc)).toBe(true);
  });

  it('rejects string literals, which is how input gets interpolated', () => {
    const name = "x' OR '1'='1";
    expect(() =>
      defineDocument(`query RbBad { actor { entitySearch(query: "name = '${name}'") { count } } }`),
    ).toThrow(DocumentError);
  });

  it('rejects a second operation or fragment after the first (phase 7 review: the allow-list reads only the first)', () => {
    expect(() =>
      defineDocument('query RbOk { actor { user { id } } } mutation RbEvil($k: Int!) { b(k: $k) { id } }'),
    ).toThrow(/exactly one operation/);
    expect(() =>
      defineDocument('mutation RbAckIssue($a: Int!) { a(a: $a) { id } } mutation RbEvil { b { id } }', {
        mutation: true,
      }),
    ).toThrow(/exactly one operation/);
    expect(() => defineDocument('query RbOk { actor { user { id } } } fragment F on User { id }')).toThrow(
      /exactly one operation/,
    );
    expect(() => defineDocument('query RbOk { actor { user { id } } # }\n }')).toThrow(/exactly one/);
  });

  it('rejects anonymous operations and reserved headers', () => {
    expect(() => defineDocument('{ actor { user { id } } }')).toThrow(/named/);
    expect(() =>
      defineDocument('query RbH { actor { user { id } } }', { headers: { 'API-Key': 'x' } }),
    ).toThrow(/reserved/);
  });
});

describe('createSemaphoreLimiter', () => {
  it('bounds concurrency, runs in FIFO order and releases on failure', async () => {
    const limiter = createSemaphoreLimiter(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (i: number, fail = false) =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(i);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (fail) throw new Error('boom');
        return i;
      });
    const results = await Promise.allSettled([task(1, true), task(2), task(3), task(4, true), task(5)]);
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((r) => r.status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(await task(6)).toBe(6); // slots were all released
  });

  it('validates its size', () => {
    for (const n of [0, -1, 1.5, 26]) expect(() => createSemaphoreLimiter(n)).toThrow(RangeError);
    expect(() => new LimiterPool(0)).toThrow(RangeError);
  });

  it('pools one limiter per credential', () => {
    const pool = new LimiterPool(1);
    expect(pool.for('a')).toBe(pool.for('a'));
    expect(pool.for('a')).not.toBe(pool.for('b'));
  });

  it('caps concurrent NerdGraph calls for one credential', async () => {
    const pool = new LimiterPool(1);
    let active = 0;
    let peak = 0;
    const fetch = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return json({ data: { actor: {} } });
    };
    const doc = defineDocument<{ actor: unknown }>('query RbL { actor { user { id } } }');
    const client = () =>
      new NerdGraphClient({
        credential: { id: 'same', region: 'US', apiKey: new Secret(FAKE_KEY) },
        budget: createBudget(10),
        limiter: pool.for('same'),
        logger: silentLogger,
        clock: { now: () => 0 },
        maxResponseBytes: 1024,
        fetch,
      });
    await Promise.all([client().query(doc, {}), client().query(doc, {}), client().query(doc, {})]);
    expect(peak).toBe(1);
  });
});
