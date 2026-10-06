// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { parseTimeRange } from '../time/range.ts';
import { defineTool, type ToolDefinition } from '../tool.ts';
import { DAY_MS } from './shared.ts';

const timeRangeInput = z.strictObject({
  expression: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'A time expression, e.g. "last 2 hours", "past 30 minutes", "today", "yesterday", "this week", "last month", ' +
        '"2026-10-01T08:00:00Z to 2026-10-01T10:00:00Z" or "2026-10-01 to 2026-10-03". Times are UTC.',
    ),
});

const timeRangeOutput = z.object({
  sinceMs: z.number().int(),
  untilMs: z.number().int(),
  windowMs: z.number().int(),
  since: z.string(),
  until: z.string(),
  clause: z.string(),
  exceedsWindowLimit: z.boolean(),
});

const TIME_RANGE_DESCRIPTION = `Convert a time expression ("yesterday", "last 2 hours", an ISO range) into exact UTC bounds (epoch ms and ISO) and a ready SINCE/UNTIL clause. Offline: nothing is sent to New Relic.

Use it for absolute incident windows or to build the time clause of a run_nrql query. "last week" and "last month" are rolling 7 and 30 days; "this week", "previous week", "this month", "previous month" are calendar periods (weeks start on Monday); a date without a time is midnight UTC and a date-only range end includes that whole day. Warns when the window is longer than this connection allows.`;

/** `time_range`: pure, no subrequest. */
export function createTimeTools(): ToolDefinition[] {
  const timeRange = defineTool({
    name: 'time_range',
    title: 'Resolve time range',
    description: TIME_RANGE_DESCRIPTION,
    inputSchema: timeRangeInput,
    outputSchema: timeRangeOutput,
    kind: 'read',
    openWorld: false,
    cost: 0,
    group: 'time',
    phase: 1,
    handler: async (input, ctx) => {
      const range = parseTimeRange(input.expression, ctx.clock.now());
      const exceeds = range.windowMs > ctx.limits.maxWindowDays * DAY_MS;
      const lines = [
        `Range: ${range.since} to ${range.until} (UTC), ${formatDuration(range.windowMs)}.`,
        `sinceMs: ${range.sinceMs}, untilMs: ${range.untilMs}`,
        `NRQL clause: ${range.clause}`,
      ];
      if (exceeds) {
        lines.push(
          `Warning: this window is longer than the ${ctx.limits.maxWindowDays}-day limit of this connection; queries over it will be refused.`,
        );
      }
      return {
        text: lines.join('\n'),
        structured: {
          sinceMs: range.sinceMs,
          untilMs: range.untilMs,
          windowMs: range.windowMs,
          since: range.since,
          until: range.until,
          clause: range.clause,
          exceedsWindowLimit: exceeds,
        },
      };
    },
  });
  return [timeRange as ToolDefinition];
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${Math.max(minutes, 0)} minute${minutes === 1 ? '' : 's'}`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${Number(hours.toFixed(1))} hours`;
  return `${Number((hours / 24).toFixed(1))} days`;
}
