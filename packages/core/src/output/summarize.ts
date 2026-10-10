// SPDX-License-Identifier: Apache-2.0
// Result shaping v2 (P7-01): summaries for large NRQL results. Pure and bounded: at most MAX_SUMMARY_ROWS rows are
// read, at most MAX_SERIES series and MAX_STAT_COLUMNS columns are summarized, so the cost is O(n log n) on a few
// thousand numbers (Workers Free CPU budget). Everything derived from New Relic text (facet values, column names) is
// returned as data; the caller puts it inside the untrusted-data envelope.

export type DetailMode = 'auto' | 'summary' | 'full';
export const DETAIL_MODES: readonly DetailMode[] = Object.freeze(['auto', 'summary', 'full']);

/** `auto` summarizes a timeseries or faceted result with at least this many rows. */
export const SUMMARY_MIN_ROWS = 50;
/** Rows kept in the shown table (top-N facets, or downsampled points over all series). */
export const SUMMARY_TARGET_ROWS = 25;
/** Most series (facet values) of a timeseries that are kept; the rest are counted. */
export const MAX_SERIES = 10;
/** Most points per series after downsampling, fewest too (a series is never cut below this). */
export const MAX_POINTS = 24;
export const MIN_POINTS = 6;
/** Rows read at all; more are ignored (NRDB returns at most 2000 per query, 5000 leaves slack for cross-account). */
export const MAX_SUMMARY_ROWS = 5000;
export const MAX_STAT_COLUMNS = 8;
export const MAX_ANOMALIES = 5;
/** Robust z-score (median/MAD) above which a point is an anomaly hint. */
export const ANOMALY_Z = 3.5;
const MIN_ANOMALY_POINTS = 8;

const TIME_KEYS = new Set(['beginTimeSeconds', 'endTimeSeconds']);

export interface ColumnStats {
  readonly column: string;
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  /** Sum of the rows not shown (top-N mode only). */
  readonly othersSum?: number | undefined;
}

export interface AnomalyHint {
  readonly column: string;
  /** Facet values of the series, when the result has several. */
  readonly series?: string | undefined;
  readonly beginTimeSeconds?: number | undefined;
  readonly value: number;
  readonly median: number;
}

export interface ResultSummary {
  readonly mode: 'downsampled' | 'top-n';
  readonly totalRows: number;
  readonly shownRows: number;
  readonly stats: ColumnStats[];
  readonly anomalies: AnomalyHint[];
  /** Series dropped beyond MAX_SERIES (timeseries only). */
  readonly omittedSeries: number;
  /** Rows beyond MAX_SUMMARY_ROWS that were not read at all. */
  readonly ignoredRows: number;
}

export interface Summarized {
  readonly rows: Record<string, unknown>[];
  readonly summary: ResultSummary;
}

type Row = Record<string, unknown>;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Numeric columns (not timestamps): a column counts when every non-null value in the first rows is a finite number. */
function numericColumns(rows: readonly Row[]): string[] {
  const seen = new Map<string, boolean>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (TIME_KEYS.has(k) || v === null || v === undefined) continue;
      seen.set(k, (seen.get(k) ?? true) && isNum(v));
    }
  }
  return [...seen]
    .filter(([, ok]) => ok)
    .map(([k]) => k)
    .slice(0, MAX_STAT_COLUMNS);
}

function percentile(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i] as number;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function statsOf(column: string, values: number[], othersSum?: number): ColumnStats | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    column,
    count: values.length,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    avg: round(sum / values.length),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    ...(othersSum === undefined ? {} : { othersSum: round(othersSum) }),
  };
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  return n % 2
    ? (sorted[(n - 1) / 2] as number)
    : ((sorted[n / 2 - 1] as number) + (sorted[n / 2] as number)) / 2;
}

function seriesKey(row: Row, numeric: ReadonlySet<string>): string {
  const parts: unknown[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (!TIME_KEYS.has(k) && !numeric.has(k)) parts.push(v);
  }
  return parts.length === 0 ? '' : JSON.stringify(parts);
}

function anomaliesOf(points: readonly Row[], column: string, series: string | undefined): AnomalyHint[] {
  const vals = points.map((p) => p[column]).filter(isNum);
  if (vals.length < MIN_ANOMALY_POINTS) return [];
  const sorted = [...vals].sort((a, b) => a - b);
  const med = median(sorted);
  const mad = median(vals.map((v) => Math.abs(v - med)).sort((a, b) => a - b));
  if (mad === 0) return [];
  const out: AnomalyHint[] = [];
  for (const p of points) {
    const v = p[column];
    if (!isNum(v)) continue;
    if (Math.abs((0.6745 * (v - med)) / mad) > ANOMALY_Z) {
      out.push({
        column,
        ...(series === undefined ? {} : { series }),
        ...(isNum(p['beginTimeSeconds']) ? { beginTimeSeconds: p['beginTimeSeconds'] } : {}),
        value: v,
        median: med,
      });
    }
  }
  // Largest deviations first.
  return out.sort((a, b) => Math.abs(b.value - b.median) - Math.abs(a.value - a.median));
}

/** Average consecutive points into at most `n` buckets (first begin, last end, numeric columns averaged). */
function downsample(points: readonly Row[], n: number, numeric: readonly string[]): Row[] {
  if (points.length <= n) return points.map((p) => ({ ...p }));
  const out: Row[] = [];
  for (let b = 0; b < n; b++) {
    const lo = Math.floor((b * points.length) / n);
    const hi = Math.floor(((b + 1) * points.length) / n);
    const group = points.slice(lo, hi);
    const first = group[0] as Row;
    const bucket: Row = { ...first };
    const last = group[group.length - 1] as Row;
    if ('endTimeSeconds' in last) bucket['endTimeSeconds'] = last['endTimeSeconds'];
    for (const c of numeric) {
      const vs = group.map((g) => g[c]).filter(isNum);
      bucket[c] = vs.length === 0 ? null : round(vs.reduce((a, b) => a + b, 0) / vs.length);
    }
    out.push(bucket);
  }
  return out;
}

/**
 * Reduce a large result: a timeseries is downsampled per series (kept in time order) with robust anomaly hints;
 * a faceted/aggregated table keeps its first rows (NRDB already ranks them) and the rest is described by stats.
 * Stats are exact over all rows read, so the summary loses detail, not accuracy.
 */
export function summarizeRows(input: readonly Row[], timeseries: boolean): Summarized {
  const all = input.slice(0, MAX_SUMMARY_ROWS);
  const ignoredRows = input.length - all.length;
  const numeric = numericColumns(all);
  const numericSet = new Set(numeric);

  if (!timeseries) {
    const shown = all.slice(0, SUMMARY_TARGET_ROWS);
    const rest = all.slice(SUMMARY_TARGET_ROWS);
    const stats = numeric.flatMap((c) => {
      const s = statsOf(
        c,
        all.map((r) => r[c]).filter(isNum),
        rest.length === 0
          ? undefined
          : rest
              .map((r) => r[c])
              .filter(isNum)
              .reduce((a, b) => a + b, 0),
      );
      return s ? [s] : [];
    });
    return {
      rows: shown,
      summary: {
        mode: 'top-n',
        totalRows: input.length,
        shownRows: shown.length,
        stats,
        anomalies: [],
        omittedSeries: 0,
        ignoredRows,
      },
    };
  }

  const groups = new Map<string, Row[]>();
  for (const row of all) {
    const key = seriesKey(row, numericSet);
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }
  const keys = [...groups.keys()];
  const kept = keys.slice(0, MAX_SERIES);
  const perSeries = Math.min(
    MAX_POINTS,
    Math.max(MIN_POINTS, Math.floor(SUMMARY_TARGET_ROWS / Math.max(1, kept.length))),
  );
  const rows: Row[] = [];
  const anomalies: AnomalyHint[] = [];
  for (const key of kept) {
    const points = (groups.get(key) as Row[]).sort(
      (a, b) =>
        (isNum(a['beginTimeSeconds']) ? a['beginTimeSeconds'] : 0) -
        (isNum(b['beginTimeSeconds']) ? b['beginTimeSeconds'] : 0),
    );
    rows.push(...downsample(points, perSeries, numeric));
    const label = key === '' ? undefined : key;
    for (const c of numeric) anomalies.push(...anomaliesOf(points, c, label));
  }
  anomalies.sort((a, b) => Math.abs(b.value - b.median) - Math.abs(a.value - a.median));
  const keptRows = kept.flatMap((k) => groups.get(k) as Row[]);
  const stats = numeric.flatMap((c) => {
    const s = statsOf(c, keptRows.map((r) => r[c]).filter(isNum));
    return s ? [s] : [];
  });
  return {
    rows,
    summary: {
      mode: 'downsampled',
      totalRows: input.length,
      shownRows: rows.length,
      stats,
      anomalies: anomalies.slice(0, MAX_ANOMALIES),
      omittedSeries: keys.length - kept.length,
      ignoredRows,
    },
  };
}
