// SPDX-License-Identifier: Apache-2.0
// analyze_threads, list_gc_metrics, analyze_kafka_metrics. Metric and attribute names are from documentation and unverified
// (docs/RESEARCH.md); a missing event type or metric is reported as "no data", never as an error. Thread, topic, consumer
// group, cluster and metric names are written by the monitored systems and are scrubbed (THREAT_MODEL T6).
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { runNrql } from '../nrql/engine.ts';
import { type NrqlQuery, nrql } from '../nrql/template.ts';
import { pickFields } from '../output/compact.ts';
import { shapeRows } from '../output/format.ts';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { FATAL_CODES } from './changes.ts';
import { checkGuid } from './entities.ts';
import { cleanName, errorNote } from './identity.ts';
import {
  accountInput,
  assertWindowWithinLimit,
  NRQL_COST,
  num,
  singleAccount,
  startableNrql,
  type ToolDeps,
  toolClient,
  UNTRUSTED,
} from './shared.ts';

const DEFAULT_WINDOW = 'last 1 hour';
const MAX_METRICS = 60;
const MAX_NAME_CHARS = 120;
const KAFKA_PARTITION_ROWS = 500;
const MAX_LAG_ROWS = 20;
const MAX_TOPIC_ROWS = 20;
const MAX_BROKER_ROWS = 20;

const RANGE_FIELD = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(`Window, e.g. "last 6 hours" (UTC ranges allowed). Default "${DEFAULT_WINDOW}".`);
const MINIMAL_FIELD = z.boolean().optional().describe('Fewer fields per row.');
const ENTITY_FIELD = z
  .string()
  .min(1)
  .max(256)
  .describe('The APM application (guid; its account is queried).');

const bounds = (sinceMs: number, untilMs: number) => ({
  since: Math.floor(sinceMs / 1000),
  until: Math.ceil(untilMs / 1000),
});

// ---------------------------------------------------------------------------------------------------------------------
// JVM metric timeslices (pure builders and readers)
// ---------------------------------------------------------------------------------------------------------------------

export const THREAD_PREFIXES = ['Threads/', 'JmxBuiltIn/Threads/'] as const;
export const RESOURCE_PREFIXES = ['CPU/', 'Memory/'] as const;
export const GC_PREFIXES = ['GC/', 'JmxBuiltIn/GC/', 'Memory/Heap/'] as const;

const nameFilter = (prefixes: readonly string[]): NrqlQuery => {
  let out: NrqlQuery | undefined;
  for (const p of prefixes) {
    const like = nrql`metricTimesliceName LIKE ${`${p}%`}`;
    out = out === undefined ? like : nrql`${out} OR ${like}`;
  }
  return out ?? nrql``;
};

/** Average, peak, total and count of every timeslice metric under the prefixes, for one entity. */
export function timesliceQuery(
  guid: string,
  prefixes: readonly string[],
  sinceMs: number,
  untilMs: number,
): NrqlQuery {
  const { since, until } = bounds(sinceMs, untilMs);
  const v = nrql.identifier('newrelic.timeslice.value');
  return nrql`SELECT average(${v}) AS avg, max(${v}) AS peak, sum(${v}) AS total, count(${v}) AS samples FROM Metric WHERE ${nrql.identifier('entity.guid')} = ${guid} AND (${nameFilter(prefixes)}) FACET metricTimesliceName LIMIT ${MAX_METRICS} SINCE ${since} UNTIL ${until}`;
}

export interface MetricStat {
  readonly name: string;
  readonly average: number | null;
  readonly peak: number | null;
  readonly total: number | null;
  readonly samples: number | null;
}

const round = (n: number | null): number | null => (n === null ? null : Number(n.toFixed(4)));

function facetValue(row: Record<string, unknown>, key: string): unknown {
  const f = row['facet'];
  return Array.isArray(f) ? f[0] : (f ?? row[key]);
}

/** Facet rows to metric stats; names are scrubbed. Rows with no numbers at all are dropped. Pure. */
export function readMetrics(rows: readonly Record<string, unknown>[]): MetricStat[] {
  const out: MetricStat[] = [];
  for (const r of rows) {
    const raw = facetValue(r, 'metricTimesliceName');
    if (typeof raw !== 'string' || raw === '') continue;
    const stat = {
      name: cleanName(raw, MAX_NAME_CHARS),
      average: round(num(r['avg'])),
      peak: round(num(r['peak'])),
      total: round(num(r['total'])),
      samples: num(r['samples']),
    };
    if (stat.average === null && stat.peak === null && stat.total === null) continue;
    out.push(stat);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const STATE_RE = /^Threads\/SummaryState\/([A-Za-z_]{1,40})\/Count$/;

/** Thread counts per JVM thread state, from `Threads/SummaryState/<STATE>/Count` metrics. Pure. */
export function threadStates(
  metrics: readonly MetricStat[],
): { state: string; average: number | null; peak: number | null }[] {
  const out: { state: string; average: number | null; peak: number | null }[] = [];
  for (const m of metrics) {
    const state = STATE_RE.exec(m.name)?.[1];
    if (state !== undefined) out.push({ state: state.toUpperCase(), average: m.average, peak: m.peak });
  }
  return out.sort((a, b) => (b.average ?? 0) - (a.average ?? 0));
}

const metricRow = z.object({
  name: z.string(),
  average: z.number().nullable(),
  peak: z.number().nullable(),
  total: z.number().nullable().optional(),
  samples: z.number().nullable().optional(),
});

const metricsText = (metrics: readonly MetricStat[], minimal: boolean): string =>
  shapeRows(
    metrics.map((m) =>
      minimal
        ? { name: m.name, average: m.average ?? '', peak: m.peak ?? '' }
        : {
            name: m.name,
            average: m.average ?? '',
            peak: m.peak ?? '',
            total: m.total ?? '',
            samples: m.samples ?? '',
          },
    ),
    { format: 'table', source: 'New Relic JVM metrics', maxRows: MAX_METRICS },
  ).text;

const slim = (metrics: MetricStat[], minimal: boolean) =>
  minimal
    ? (pickFields(metrics as unknown as Record<string, unknown>[], [
        'name',
        'average',
        'peak',
      ]) as unknown as MetricStat[])
    : metrics;

const UNITS = `Values are as reported by the agent (units are not converted). ${UNTRUSTED}`;

// ---------------------------------------------------------------------------------------------------------------------
// Kafka (pure builders and readers)
// ---------------------------------------------------------------------------------------------------------------------

export interface KafkaFilters {
  readonly cluster?: string | undefined;
  readonly group?: string | undefined;
  readonly topic?: string | undefined;
}

const kafkaWhere = (f: KafkaFilters, groupApplies: boolean): NrqlQuery => {
  let out = nrql``;
  if (f.cluster !== undefined) out = nrql`${out} AND ${nrql.identifier('clusterName')} = ${f.cluster}`;
  if (groupApplies && f.group !== undefined)
    out = nrql`${out} AND ${nrql.identifier('consumerGroup')} = ${f.group}`;
  if (f.topic !== undefined) out = nrql`${out} AND ${nrql.identifier('topic')} = ${f.topic}`;
  return out;
};

export function lagQuery(f: KafkaFilters, sinceMs: number, untilMs: number): NrqlQuery {
  const { since, until } = bounds(sinceMs, untilMs);
  const lag = nrql.identifier('consumer.lag');
  return nrql`SELECT latest(${lag}) AS lag, max(${lag}) AS peak FROM KafkaOffsetSample WHERE ${nrql.identifier('consumerGroup')} IS NOT NULL ${kafkaWhere(f, true)} FACET consumerGroup, topic, partition LIMIT ${KAFKA_PARTITION_ROWS} SINCE ${since} UNTIL ${until}`;
}

export function topicQuery(f: KafkaFilters, sinceMs: number, untilMs: number): NrqlQuery {
  const { since, until } = bounds(sinceMs, untilMs);
  return nrql`SELECT average(${nrql.identifier('topic.bytesInPerSec')}) AS bytesIn, average(${nrql.identifier('topic.bytesOutPerSec')}) AS bytesOut, average(${nrql.identifier('topic.messagesInPerSec')}) AS messagesIn FROM KafkaTopicSample WHERE ${nrql.identifier('topic')} IS NOT NULL ${kafkaWhere(f, false)} FACET topic LIMIT ${MAX_TOPIC_ROWS} SINCE ${since} UNTIL ${until}`;
}

export function brokerQuery(f: KafkaFilters, sinceMs: number, untilMs: number): NrqlQuery {
  const { since, until } = bounds(sinceMs, untilMs);
  return nrql`SELECT average(${nrql.identifier('broker.bytesInPerSecond')}) AS bytesIn, average(${nrql.identifier('broker.bytesOutPerSecond')}) AS bytesOut, average(${nrql.identifier('broker.messagesInPerSecond')}) AS messagesIn FROM KafkaBrokerSample WHERE ${nrql.identifier('entityName')} IS NOT NULL ${kafkaWhere({ cluster: f.cluster }, false)} FACET entityName LIMIT ${MAX_BROKER_ROWS} SINCE ${since} UNTIL ${until}`;
}

export interface LagGroup {
  readonly consumerGroup: string;
  readonly topic: string;
  readonly partitions: number;
  /** Sum of the latest lag of every partition. */
  readonly totalLag: number;
  readonly maxPartitionLag: number;
  /** Highest lag any partition reached in the window. */
  readonly peakPartitionLag: number;
  /** maxPartitionLag divided by the mean partition lag (1 = even; null when there is no lag). */
  readonly imbalance: number | null;
}

const asText = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? cleanName(v, MAX_NAME_CHARS) : typeof v === 'number' ? String(v) : null;

/** Per (group, topic): total lag and partition balance from per-partition rows. Most lagging first. Pure. */
export function readLag(rows: readonly Record<string, unknown>[]): LagGroup[] {
  const groups = new Map<string, { consumerGroup: string; topic: string; lags: number[]; peak: number }>();
  for (const r of rows) {
    const f = r['facet'];
    const group = asText(Array.isArray(f) ? f[0] : r['consumerGroup']);
    const topic = asText(Array.isArray(f) ? f[1] : r['topic']);
    const lag = num(r['lag']);
    if (group === null || topic === null || lag === null) continue;
    const key = JSON.stringify([group, topic]);
    const g = groups.get(key) ?? { consumerGroup: group, topic, lags: [], peak: 0 };
    g.lags.push(Math.max(0, lag));
    g.peak = Math.max(g.peak, num(r['peak']) ?? lag);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g): LagGroup => {
      const total = g.lags.reduce((a, b) => a + b, 0);
      const max = Math.max(...g.lags);
      const mean = total / g.lags.length;
      return {
        consumerGroup: g.consumerGroup,
        topic: g.topic,
        partitions: g.lags.length,
        totalLag: total,
        maxPartitionLag: max,
        peakPartitionLag: g.peak,
        imbalance: mean === 0 ? null : Number((max / mean).toFixed(2)),
      };
    })
    .sort((a, b) => b.totalLag - a.totalLag || a.consumerGroup.localeCompare(b.consumerGroup));
}

export interface Throughput {
  readonly name: string;
  readonly bytesInPerSecond: number | null;
  readonly bytesOutPerSecond: number | null;
  readonly messagesInPerSecond: number | null;
}

/** Throughput rows by topic or broker; rows with no numbers are dropped. Pure. */
export function readThroughput(rows: readonly Record<string, unknown>[], key: string): Throughput[] {
  const out: Throughput[] = [];
  for (const r of rows) {
    const name = asText(facetValue(r, key));
    if (name === null) continue;
    const t = {
      name,
      bytesInPerSecond: round(num(r['bytesIn'])),
      bytesOutPerSecond: round(num(r['bytesOut'])),
      messagesInPerSecond: round(num(r['messagesIn'])),
    };
    if (t.bytesInPerSecond === null && t.bytesOutPerSecond === null && t.messagesInPerSecond === null)
      continue;
    out.push(t);
  }
  return out.sort(
    (a, b) => (b.bytesInPerSecond ?? 0) - (a.bytesInPerSecond ?? 0) || a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------------

type Part<T> = { ok: true; value: T } | { ok: false; note: string };
const SKIPPED = { ok: false, note: 'Request budget exhausted.' } as const;

const threadsInput = z.strictObject({
  entity_guid: ENTITY_FIELD,
  time_range: RANGE_FIELD,
  minimal_output: MINIMAL_FIELD,
});
const threadsOutput = z.object({
  accountId: z.number().int(),
  entityGuid: z.string(),
  since: z.string(),
  until: z.string(),
  /** Whether any thread metric was found. */
  hasData: z.boolean(),
  states: z.array(
    z.object({ state: z.string(), average: z.number().nullable(), peak: z.number().nullable() }),
  ),
  threadMetrics: z.array(metricRow),
  resourceMetrics: z.array(metricRow),
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const THREADS_DESCRIPTION = `Summarise the JVM threads of an APM Java application (guid or name): thread counts by state (runnable, blocked, waiting...), other thread metrics, and the CPU and memory metrics the agent reports, each as average and peak.

Runs 2 requests; a stopped one leaves the other (partial). Says so, instead of failing, when the entity reports no such metrics (not Java, no thread/JMX metrics, no traffic). For garbage collection and heap use list_gc_metrics. ${UNITS}`;

const gcInput = threadsInput;
const gcOutput = z.object({
  accountId: z.number().int(),
  entityGuid: z.string(),
  since: z.string(),
  until: z.string(),
  hasData: z.boolean(),
  gc: z.array(metricRow),
  heap: z.array(metricRow),
  notes: z.array(z.string()),
});

const GC_DESCRIPTION = `List the garbage-collection and heap metrics of an APM Java application (guid or name): per collector and heap metric, the average, peak, total and number of samples.

Runs 1 request. Says so, instead of failing, when there are no GC or heap metrics (not Java, no data). For thread states and CPU use analyze_threads. ${UNITS}`;

const kafkaInput = z.strictObject({
  account: accountInput,
  cluster_name: z.string().min(1).max(200).optional().describe('Only this Kafka cluster (clusterName).'),
  consumer_group: z.string().min(1).max(200).optional().describe('Only this consumer group (lag only).'),
  topic: z.string().min(1).max(200).optional().describe('Only this topic.'),
  time_range: RANGE_FIELD,
  minimal_output: MINIMAL_FIELD,
});
const kafkaOutput = z.object({
  accountId: z.number().int(),
  since: z.string(),
  until: z.string(),
  lag: z.array(
    z.object({
      consumerGroup: z.string(),
      topic: z.string(),
      partitions: z.number(),
      totalLag: z.number(),
      maxPartitionLag: z.number(),
      peakPartitionLag: z.number(),
      imbalance: z.number().nullable(),
    }),
  ),
  topics: z.array(
    z.object({
      name: z.string(),
      bytesInPerSecond: z.number().nullable(),
      bytesOutPerSecond: z.number().nullable(),
      messagesInPerSecond: z.number().nullable(),
    }),
  ),
  brokers: z.array(
    z.object({
      name: z.string(),
      bytesInPerSecond: z.number().nullable(),
      bytesOutPerSecond: z.number().nullable(),
      messagesInPerSecond: z.number().nullable(),
    }),
  ),
  /** Event types the account has no matching data for in the window. */
  noData: z.array(z.string()),
  partial: z.boolean(),
  notes: z.array(z.string()),
});

const KAFKA_DESCRIPTION = `Summarise Kafka health in one account from the New Relic Kafka integration: consumer lag per consumer group and topic with partition balance (total, worst partition, imbalance), topic throughput and broker throughput. Optionally narrow by cluster_name, consumer_group or topic.

Runs 3 requests (KafkaOffsetSample, KafkaTopicSample, KafkaBrokerSample); a part the request budget stops marks the result partial, a part without data (integration not installed, no match, event type not allowed) is named in noData. Lag is read for up to ${KAFKA_PARTITION_ROWS} partitions. ${UNTRUSTED}`;

/** `analyze_threads`, `list_gc_metrics` and `analyze_kafka_metrics` (read-only). */
export function createRuntimeTools(deps: ToolDeps = {}): ToolDefinition[] {
  const client = toolClient(deps);

  const run = (ctx: ToolContext, account: number, query: NrqlQuery) =>
    runNrql(
      ctx,
      { nrql: query, accounts: [account], mode: 'auto', maxPolls: 1 },
      { client: client(ctx), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
    );

  async function part<T>(
    ctx: ToolContext,
    account: number,
    query: NrqlQuery,
    read: (rows: Record<string, unknown>[]) => T,
  ): Promise<Part<T>> {
    try {
      const outcome = await run(ctx, account, query);
      if (outcome.status === 'pending')
        return { ok: false, note: 'Still running at New Relic; try again shortly.' };
      return { ok: true, value: read(outcome.results as Record<string, unknown>[]) };
    } catch (e) {
      // Credential, authorization and connection-limit errors (e.g. event type not allowed) hit every part alike.
      if (!(e instanceof RbError) || FATAL_CODES.has(e.code) || e.code === ErrorCode.LimitQuery) throw e;
      if (e.code === ErrorCode.BudgetExhausted) return { ok: false, note: 'Request budget exhausted.' };
      return { ok: false, note: errorNote(e) };
    }
  }

  const entityScope = (ctx: ToolContext, guid: string, timeRange: string | undefined) => {
    const decoded = checkGuid(ctx, guid);
    const account = singleAccount(ctx, decoded.accountId);
    const range = parseTimeRange(timeRange ?? DEFAULT_WINDOW, ctx.clock.now());
    assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());
    return { account, range };
  };

  const threads = defineTool({
    name: 'analyze_threads',
    title: 'Analyze JVM threads',
    description: THREADS_DESCRIPTION,
    inputSchema: threadsInput,
    outputSchema: threadsOutput,
    kind: 'read',
    openWorld: true,
    // Two NRQL queries.
    cost: 2 * NRQL_COST,
    group: 'performance',
    phase: 6,
    handler: async (args, ctx) => {
      const { account, range } = entityScope(ctx, args.entity_guid, args.time_range);
      const startable = startableNrql(2, ctx.budget.remaining);
      const jobs = [
        () =>
          part(
            ctx,
            account,
            timesliceQuery(args.entity_guid, THREAD_PREFIXES, range.sinceMs, range.untilMs),
            readMetrics,
          ),
        () =>
          part(
            ctx,
            account,
            timesliceQuery(args.entity_guid, RESOURCE_PREFIXES, range.sinceMs, range.untilMs),
            readMetrics,
          ),
      ];
      const ran = await Promise.all(jobs.slice(0, startable).map((j) => j()));
      const threadPart = (ran[0] ?? SKIPPED) as Part<MetricStat[]>;
      const resourcePart = (ran[1] ?? SKIPPED) as Part<MetricStat[]>;

      const notes: string[] = [];
      if (!threadPart.ok) notes.push(`Thread metrics: ${threadPart.note}`);
      if (!resourcePart.ok) notes.push(`CPU and memory metrics: ${resourcePart.note}`);
      const partial = !threadPart.ok || !resourcePart.ok;
      const threadMetrics = threadPart.ok ? threadPart.value : [];
      const resourceMetrics = resourcePart.ok ? resourcePart.value : [];
      const states = threadStates(threadMetrics);
      const hasData = threadMetrics.length > 0;
      if (threadPart.ok && !hasData)
        notes.push(
          'No JVM thread metrics for this entity in the window. It may not be a Java APM application, the agent may not report thread metrics, or it had no data in this window.',
        );
      if (resourcePart.ok && resourceMetrics.length === 0)
        notes.push('No CPU or memory metrics for this entity in the window.');

      const minimal = args.minimal_output === true;
      const out = [
        `JVM threads of the entity in account ${account}, ${range.since} to ${range.until} (UTC).${partial ? ' Partial result: see notes.' : ''}`,
      ];
      for (const n of notes) out.push(`Note: ${n}`);
      if (states.length > 0)
        out.push(
          'Thread states:',
          shapeRows(
            states.map((s) => ({ state: s.state, average: s.average ?? '', peak: s.peak ?? '' })),
            { format: 'table', source: 'New Relic JVM metrics', maxRows: 20 },
          ).text,
        );
      if (threadMetrics.length > 0) out.push('Thread metrics:', metricsText(threadMetrics, minimal));
      if (resourceMetrics.length > 0)
        out.push('CPU and memory metrics:', metricsText(resourceMetrics, minimal));
      if (hasData || resourceMetrics.length > 0) out.push(UNITS);

      return {
        text: out.join('\n'),
        structured: {
          accountId: account,
          entityGuid: args.entity_guid,
          since: range.since,
          until: range.until,
          hasData,
          states,
          threadMetrics: slim(threadMetrics, minimal),
          resourceMetrics: slim(resourceMetrics, minimal),
          partial,
          notes,
        },
      };
    },
  });

  const gc = defineTool({
    name: 'list_gc_metrics',
    title: 'List GC and heap metrics',
    description: GC_DESCRIPTION,
    inputSchema: gcInput,
    outputSchema: gcOutput,
    kind: 'read',
    openWorld: true,
    // One NRQL.
    cost: NRQL_COST,
    group: 'performance',
    phase: 6,
    handler: async (args, ctx) => {
      const { account, range } = entityScope(ctx, args.entity_guid, args.time_range);
      const outcome = await run(
        ctx,
        account,
        timesliceQuery(args.entity_guid, GC_PREFIXES, range.sinceMs, range.untilMs),
      );
      if (outcome.status === 'pending') {
        throw new RbError(ErrorCode.NerdGraphTimeout, 'The query is still running at New Relic.', {
          hint: 'Try again shortly, or use a shorter time_range.',
        });
      }
      const all = readMetrics(outcome.results as Record<string, unknown>[]);
      const heap = all.filter((m) => m.name.startsWith('Memory/Heap/'));
      const gcMetrics = all.filter((m) => !m.name.startsWith('Memory/Heap/'));
      const hasData = all.length > 0;
      const notes: string[] = [];
      if (!hasData)
        notes.push(
          'No GC or heap metrics for this entity in the window. It may not be a Java APM application, or it had no data in this window.',
        );
      else if (gcMetrics.length === 0) notes.push('Heap metrics found, but no garbage-collector metrics.');
      const minimal = args.minimal_output === true;
      const out = [
        `GC and heap metrics of the entity in account ${account}, ${range.since} to ${range.until} (UTC).`,
      ];
      for (const n of notes) out.push(`Note: ${n}`);
      if (gcMetrics.length > 0) out.push('Garbage collection:', metricsText(gcMetrics, minimal));
      if (heap.length > 0) out.push('Heap:', metricsText(heap, minimal));
      if (hasData) out.push(UNITS);
      return {
        text: out.join('\n'),
        structured: {
          accountId: account,
          entityGuid: args.entity_guid,
          since: range.since,
          until: range.until,
          hasData,
          gc: slim(gcMetrics, minimal),
          heap: slim(heap, minimal),
          notes,
        },
      };
    },
  });

  const kafka = defineTool({
    name: 'analyze_kafka_metrics',
    title: 'Analyze Kafka metrics',
    description: KAFKA_DESCRIPTION,
    inputSchema: kafkaInput,
    outputSchema: kafkaOutput,
    kind: 'read',
    openWorld: true,
    // Consumer lag, topic throughput and broker throughput (one NRQL each).
    cost: 3 * NRQL_COST,
    group: 'performance',
    phase: 6,
    handler: async (args, ctx) => {
      const account = singleAccount(ctx, args.account);
      const range = parseTimeRange(args.time_range ?? DEFAULT_WINDOW, ctx.clock.now());
      assertWindowWithinLimit(range, ctx.limits, ctx.clock.now());
      const filters: KafkaFilters = {
        cluster: args.cluster_name,
        group: args.consumer_group,
        topic: args.topic,
      };

      let lagRows = 0;
      const startable = startableNrql(3, ctx.budget.remaining);
      const jobs: Array<() => Promise<unknown>> = [
        () =>
          part(ctx, account, lagQuery(filters, range.sinceMs, range.untilMs), (rows) => {
            lagRows = rows.length;
            return readLag(rows);
          }),
        () =>
          part(ctx, account, topicQuery(filters, range.sinceMs, range.untilMs), (rows) =>
            readThroughput(rows, 'topic'),
          ),
        () =>
          part(ctx, account, brokerQuery(filters, range.sinceMs, range.untilMs), (rows) =>
            readThroughput(rows, 'entityName'),
          ),
      ];
      const ran = await Promise.all(jobs.slice(0, startable).map((j) => j()));
      const lagPart = (ran[0] ?? SKIPPED) as Part<LagGroup[]>;
      const topicPart = (ran[1] ?? SKIPPED) as Part<Throughput[]>;
      const brokerPart = (ran[2] ?? SKIPPED) as Part<Throughput[]>;

      const notes: string[] = [];
      const noData: string[] = [];
      const check = (p: Part<unknown[]>, what: string, event: string) => {
        if (!p.ok) notes.push(`${what}: ${p.note}`);
        else if (p.value.length === 0) noData.push(event);
      };
      check(lagPart, 'Consumer lag', 'KafkaOffsetSample');
      check(topicPart, 'Topic throughput', 'KafkaTopicSample');
      check(brokerPart, 'Broker throughput', 'KafkaBrokerSample');
      const partial = !lagPart.ok || !topicPart.ok || !brokerPart.ok;

      const lag = lagPart.ok ? lagPart.value : [];
      const topics = topicPart.ok ? topicPart.value : [];
      const brokers = brokerPart.ok ? brokerPart.value : [];
      if (noData.length > 0)
        notes.push(
          `No data in the window for: ${noData.join(', ')}. The Kafka integration may not be installed for this account, the filters may match nothing, or the event type may not be allowed for this connection.`,
        );
      if (noData.length === 3)
        notes.push('No Kafka data found at all; nothing to analyse for this account and window.');
      if (lagPart.ok && lagPart.value.length > 0 && lagRows >= KAFKA_PARTITION_ROWS)
        notes.push(
          `Lag is based on the first ${KAFKA_PARTITION_ROWS} partitions; narrow with cluster_name, consumer_group or topic.`,
        );
      const shownLag = lag.slice(0, MAX_LAG_ROWS);

      const minimal = args.minimal_output === true;
      const out = [
        `Kafka in account ${account}, ${range.since} to ${range.until} (UTC).${partial ? ' Partial result: see notes.' : ''}`,
      ];
      for (const n of notes) out.push(`Note: ${n}`);
      if (shownLag.length > 0)
        out.push(
          'Consumer lag (latest, per group and topic):',
          shapeRows(
            shownLag.map((l) =>
              minimal
                ? { group: l.consumerGroup, topic: l.topic, total_lag: l.totalLag }
                : {
                    group: l.consumerGroup,
                    topic: l.topic,
                    partitions: l.partitions,
                    total_lag: l.totalLag,
                    worst_partition: l.maxPartitionLag,
                    peak_partition: l.peakPartitionLag,
                    imbalance: l.imbalance ?? '',
                  },
            ),
            { format: 'table', source: 'New Relic Kafka data', maxRows: MAX_LAG_ROWS },
          ).text,
        );
      const throughput = (rows: readonly Throughput[], first: string) =>
        shapeRows(
          rows.map((t) =>
            minimal
              ? { [first]: t.name, bytes_in_per_sec: t.bytesInPerSecond ?? '' }
              : {
                  [first]: t.name,
                  bytes_in_per_sec: t.bytesInPerSecond ?? '',
                  bytes_out_per_sec: t.bytesOutPerSecond ?? '',
                  messages_in_per_sec: t.messagesInPerSecond ?? '',
                },
          ),
          { format: 'table', source: 'New Relic Kafka data', maxRows: MAX_TOPIC_ROWS },
        ).text;
      if (topics.length > 0) out.push('Topic throughput (average):', throughput(topics, 'topic'));
      if (brokers.length > 0) out.push('Broker throughput (average):', throughput(brokers, 'broker'));

      return {
        text: out.join('\n'),
        structured: {
          accountId: account,
          since: range.since,
          until: range.until,
          lag: shownLag,
          topics,
          brokers,
          noData,
          partial,
          notes,
        },
      };
    },
  });

  return [threads as ToolDefinition, gc as ToolDefinition, kafka as ToolDefinition];
}
