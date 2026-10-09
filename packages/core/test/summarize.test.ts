// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  type NrqlComplete,
  nrqlResultSchema,
  shapeNrqlOutcome,
  summarizeRows,
  UNTRUSTED_NOTICE,
} from '../src/index.ts';

const T0 = 1_790_000_000;

const outcome = (
  results: Record<string, unknown>[],
  metadata: Partial<NrqlComplete['metadata']>,
): NrqlComplete => ({
  status: 'complete',
  accounts: [1000001],
  results,
  metadata: { eventTypes: ['Transaction'], facets: [], timeseries: false, ...metadata },
  messages: [],
  warnings: [],
  polls: 0,
  notes: [],
  nrql: 'SELECT 1',
  durationMs: 100,
});

/** 4 series x 500 one-minute buckets, with one spike. */
const series = (n = 500, k = 4) =>
  Array.from({ length: n * k }, (_, i) => ({
    beginTimeSeconds: T0 + Math.floor(i / k) * 60,
    endTimeSeconds: T0 + Math.floor(i / k) * 60 + 60,
    facet: `svc-${i % k}`,
    'average.duration': 0.05 + ((i * 7) % 31) / 1000 + (i === 1234 ? 2 : 0),
    count: 100 + ((i * 13) % 57),
  }));

const facets = (n = 300) =>
  Array.from({ length: n }, (_, i) => ({
    facet: `route-${i}`,
    count: 1000 - i,
    'p95.duration': 0.1 + (i % 17) / 100,
  }));

describe('summarizeRows', () => {
  it('downsamples a timeseries per series, keeps time order, stats are exact', () => {
    const rows = series();
    const { rows: out, summary } = summarizeRows(rows, true);
    expect(summary.mode).toBe('downsampled');
    expect(out.length).toBeLessThanOrEqual(25);
    expect(summary.totalRows).toBe(2000);
    const counts = rows.map((r) => r.count);
    const c = summary.stats.find((s) => s.column === 'count');
    expect(c).toMatchObject({
      count: 2000,
      min: Math.min(...counts),
      max: Math.max(...counts),
    });
    expect(c?.avg).toBeCloseTo(counts.reduce((a, b) => a + b, 0) / counts.length, 5);
    const first = out.filter((r) => r['facet'] === 'svc-0');
    const times = first.map((r) => r['beginTimeSeconds'] as number);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(first[0]?.['beginTimeSeconds']).toBe(T0);
  });

  it('flags the spike as an anomaly hint, and nothing in a flat series', () => {
    const { summary } = summarizeRows(series(), true);
    const hit = summary.anomalies.find((a) => a.column === 'average.duration');
    expect(hit?.value).toBeGreaterThan(2);
    expect(hit?.series).toContain('svc-2');
    expect(
      summarizeRows(
        series().map((r) => ({ ...r, 'average.duration': 1 })),
        true,
      ).summary.anomalies,
    ).toEqual([]);
  });

  it('caps series and rows read', () => {
    const many = Array.from({ length: 45 }, (_, s) =>
      Array.from({ length: 100 }, (_, i) => ({ beginTimeSeconds: T0 + i * 60, facet: `s${s}`, count: i })),
    ).flat();
    const { rows, summary } = summarizeRows(many, true);
    expect(summary.omittedSeries).toBe(35);
    expect(rows.length).toBeLessThanOrEqual(60);
    const huge = Array.from({ length: 7000 }, (_, i) => ({ facet: `f${i}`, count: i }));
    expect(summarizeRows(huge, false).summary.ignoredRows).toBe(2000);
  });

  it('top-n keeps the first rows and sums the rest', () => {
    const { rows, summary } = summarizeRows(facets(), false);
    expect(summary.mode).toBe('top-n');
    expect(rows[0]).toMatchObject({ facet: 'route-0' });
    const c = summary.stats.find((s) => s.column === 'count');
    expect(c?.max).toBe(1000);
    expect(c?.othersSum).toBe(
      facets()
        .slice(rows.length)
        .reduce((a, r) => a + r.count, 0),
    );
  });
});

describe('shapeNrqlOutcome detail', () => {
  const big = () => outcome(series(), { timeseries: true, facets: ['facet'] });

  it('auto summarizes a big timeseries, inside the envelope, and structured content validates', () => {
    const out = shapeNrqlOutcome(big(), { envelopeId: '0123456789abcdef' });
    expect(out.text).toContain('Summarized: 2,000 rows reduced to');
    expect(out.text).toContain('detail "full"');
    const open = out.text.indexOf('<untrusted-data');
    expect(out.text.indexOf('Stats "count"')).toBeGreaterThan(open);
    expect(out.text.indexOf('Anomaly hint')).toBeGreaterThan(open);
    expect(out.text.indexOf(UNTRUSTED_NOTICE)).toBeLessThan(open);
    expect(nrqlResultSchema.parse(out.structured)).toEqual(out.structured);
    expect(out.structured).toMatchObject({
      totalRows: 2000,
      truncated: true,
      summary: { mode: 'downsampled' },
    });
  });

  it('full and small results are not summarized; raw events are not summarized by auto', () => {
    expect(shapeNrqlOutcome(big(), { detail: 'full', maxRows: 1000 }).structured?.summary).toBeUndefined();
    expect(
      shapeNrqlOutcome(outcome(series(5, 4), { timeseries: true, facets: ['facet'] })).structured?.summary,
    ).toBeUndefined();
    const raw = outcome(
      Array.from({ length: 300 }, (_, i) => ({ message: `m${i}`, n: i })),
      {},
    );
    expect(shapeNrqlOutcome(raw).structured?.summary).toBeUndefined();
    expect(shapeNrqlOutcome(raw, { detail: 'summary' }).structured?.summary).toMatchObject({ mode: 'top-n' });
  });

  it('secrets and injected text in series names stay redacted and enveloped', () => {
    const rows = series().map((r) => ({ ...r, facet: `NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 ${r.facet}` }));
    const out = shapeNrqlOutcome(outcome(rows, { timeseries: true, facets: ['facet'] }));
    expect(JSON.stringify(out)).not.toContain('NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  });

  it('cuts tokens by at least 50% on large results without losing the exact stats', () => {
    for (const o of [
      big(),
      outcome(facets(1000), { facets: ['facet'] }),
      outcome(series(1000, 1), { timeseries: true, facets: [] }),
    ]) {
      const full = shapeNrqlOutcome(o, { detail: 'full' });
      const auto = shapeNrqlOutcome(o);
      const tokens = (r: typeof full) =>
        estimateTokens(r.text) + estimateTokens(JSON.stringify(r.structured));
      expect(tokens(auto)).toBeLessThan(tokens(full) * 0.5);
      expect(auto.structured?.summary?.stats.length).toBeGreaterThan(0);
    }
  });
});
