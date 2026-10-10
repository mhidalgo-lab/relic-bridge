// SPDX-License-Identifier: Apache-2.0
// Per-grant usage quotas (P7-12, THREAT_MODEL T5): the `QuotaGuard` a request's tools consult before every real
// NerdGraph call, over a counter store that is atomic (storage `grant_usage`, or the Workers Durable Object). Web-standard
// only (ADR-0004); nothing request-scoped lives in module state (T21): a guard is built per request.
import { ErrorCode, type Logger, type QuotaGuard, RbError, silentLogger } from '@relic-bridge/core';
import {
  type GrantUsageRepository,
  periodResetsAt,
  QUOTA_DEFAULT_WARN_PERCENT,
  type QuotaPeriodName,
  type StoredQuota,
  type StoredQuotaPeriod,
  type UsageCounters,
  usagePeriods,
} from '@relic-bridge/storage';

/** The counters a guard needs. `Storage.grantUsage` is one; the Workers Durable Object store is another. */
export type QuotaStore = Omit<GrantUsageRepository, 'purgeBefore'>;

export type QuotaMeasure = 'queries' | 'inspectedEvents';

/** Why a call was refused. Only the grant's own period, cap and reset time: nothing about other grants or the key. */
export interface QuotaDenial {
  readonly period: QuotaPeriodName;
  readonly measure: QuotaMeasure;
  readonly limit: number;
  /** Epoch ms when the period ends and the counter starts again. */
  readonly resetsAt: number;
}

export interface QuotaGuardOptions {
  readonly store: QuotaStore;
  readonly grantId: string;
  readonly quota: StoredQuota;
  readonly now: () => number;
  readonly logger?: Logger;
  /** Called (in the background) when a hard cap refused a call; must not throw. */
  readonly onDenied?: (denial: QuotaDenial) => void;
}

const PERIODS: readonly QuotaPeriodName[] = ['day', 'month'];
const LABEL: Readonly<Record<QuotaPeriodName, string>> = { day: 'daily', month: 'monthly' };
const MEASURE_LABEL: Readonly<Record<QuotaMeasure, string>> = {
  queries: 'New Relic call',
  inspectedEvents: 'inspected-events',
};

const configured = (q: StoredQuota): { name: QuotaPeriodName; caps: StoredQuotaPeriod }[] =>
  PERIODS.flatMap((name) => {
    const caps = q[name];
    return caps === undefined ? [] : [{ name, caps }];
  });

/** The refusal an agent sees: the period, what ran out and when it resets. Never other grants' or the key's data. */
export function quotaError(denial: QuotaDenial): RbError {
  const resets = new Date(denial.resetsAt).toISOString();
  return new RbError(
    ErrorCode.LimitQuota,
    `The ${LABEL[denial.period]} ${MEASURE_LABEL[denial.measure]} quota for this connection is used up.`,
    {
      hint: `The quota starts again at ${resets} (UTC). Ask an administrator to raise it, or try again then.`,
      details: {
        period: denial.period,
        measure: denial.measure,
        limit: denial.limit,
        resetsAt: resets,
      },
    },
  );
}

/** A guard for one request of a grant that has a quota. */
export function createQuotaGuard(options: QuotaGuardOptions): QuotaGuard {
  const { store, grantId, quota, now } = options;
  const log = options.logger ?? silentLogger;
  const periods = configured(quota);
  const warnAt = quota.warnPercent ?? QUOTA_DEFAULT_WARN_PERCENT;
  let warning: string | undefined;
  let warnedPercent = 0;
  let storeWarned = false;

  const storeFailed = (error: unknown): void => {
    // Fail open: a cost control must not turn a counter outage into an outage of the tool. One log line per request.
    if (storeWarned) return;
    storeWarned = true;
    log.warn('quota counters unavailable: call allowed', {
      grantId,
      error: error instanceof Error ? error.name : typeof error,
    });
  };

  /** Records the highest soft-limit crossing seen in this request. */
  const consider = (
    name: QuotaPeriodName,
    measure: QuotaMeasure,
    used: number,
    limit: number | undefined,
  ): void => {
    if (limit === undefined) return;
    const percent = Math.floor((used / limit) * 100);
    if (percent < warnAt || percent <= warnedPercent) return;
    warnedPercent = percent;
    const resets = new Date(periodResetsAt(name, now())).toISOString();
    warning =
      `Quota warning: this connection has used ${Math.min(percent, 100)}% of its ${LABEL[name]} ` +
      `${MEASURE_LABEL[measure]} quota (${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')}); ` +
      `it starts again at ${resets} (UTC).`;
  };

  const deny = (denial: QuotaDenial): RbError => {
    try {
      options.onDenied?.(denial);
    } catch {
      // an observer never changes the answer
    }
    return quotaError(denial);
  };

  return Object.freeze({
    tracksInspected: periods.some((p) => p.caps.inspectedEvents !== undefined),

    async beforeCall(): Promise<void> {
      const t = now();
      const keys = usagePeriods(t);
      const reserved: string[] = [];
      try {
        for (const { name, caps } of periods) {
          const key = keys[name];
          let counters: UsageCounters | null;
          try {
            counters = await store.reserve(grantId, key, caps.queries ?? null);
          } catch (error) {
            storeFailed(error);
            continue;
          }
          if (counters === null) {
            throw deny({
              period: name,
              measure: 'queries',
              limit: caps.queries as number,
              resetsAt: periodResetsAt(name, t),
            });
          }
          reserved.push(key);
          // The inspected budget is known only after a call: refuse while the counter is at or over it.
          if (caps.inspectedEvents !== undefined && counters.inspected >= caps.inspectedEvents) {
            throw deny({
              period: name,
              measure: 'inspectedEvents',
              limit: caps.inspectedEvents,
              resetsAt: periodResetsAt(name, t),
            });
          }
          consider(name, 'queries', counters.queries, caps.queries);
          consider(name, 'inspectedEvents', counters.inspected, caps.inspectedEvents);
        }
      } catch (error) {
        // Not sent, so not counted: give back what this call took in the periods that did not refuse it.
        await Promise.all(
          reserved.map((key) =>
            store.release(grantId, key).catch((e: unknown) => {
              storeFailed(e);
            }),
          ),
        );
        throw error;
      }
    },

    async recordInspected(events: number): Promise<void> {
      if (!Number.isSafeInteger(events) || events <= 0) return;
      const keys = usagePeriods(now());
      await Promise.all(
        periods.map(async ({ name, caps }) => {
          try {
            const counters = await store.addInspected(grantId, keys[name], events);
            consider(name, 'inspectedEvents', counters.inspected, caps.inspectedEvents);
          } catch (error) {
            storeFailed(error);
          }
        }),
      );
    },

    takeWarning(): string | undefined {
      const w = warning;
      warning = undefined;
      return w;
    },
  });
}
