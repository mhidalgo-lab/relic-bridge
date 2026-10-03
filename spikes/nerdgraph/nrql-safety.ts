// SPDX-License-Identifier: Apache-2.0
// P1-04 follow-up probe: how does NRQL itself parse escapes, comments, time expressions and LIMIT edge cases?
// Answers the open questions in docs/RESEARCH.md §2 so relic-bridge's escaping and limits match NRQL exactly.
//
//   node nrql-safety.ts --dry-run     print every NRQL query, no network, no key needed
//   node nrql-safety.ts               run against NR_KEY_A / NR_REGION_A / NR_ACCOUNT_A (read-only queries)
//   NR_EVENT_TYPE=Transaction node nrql-safety.ts    force the event type to test against
//
// Output: results/raw/nrql-safety.json (full responses, gitignored) and results/nrql-safety-summary.json
// (verdicts only: no account ids, no event data, just counts compared to a baseline and time-window offsets).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENDPOINTS,
  type GqlResult,
  gql,
  loadProfiles,
  type Profile,
  redact,
  SPIKE_DIR,
  saveRaw,
  sleep,
} from './lib.ts';

const DOC = `query RbProbe($accountId: Int!, $nrql: Nrql!) {
  actor { account(id: $accountId) { nrql(query: $nrql, timeout: 30) {
    results metadata { messages timeWindow { begin end since until } }
  } } }
}`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** relic-bridge's escaping rule (packages/core/src/nrql/template.ts), duplicated here so the spike stays standalone. */
const quote = (v: string): string => `'${v.replace(/[\\']/g, (c) => `\\${c}`)}'`;
/** A nasty value: quote, backslash, double quotes, comment markers. Its NRQL length must equal its JS length. */
const NASTY = `it's a \\ "q" -- // /* x`;

interface Outcome {
  ok: boolean;
  errors: string[];
  rows: Record<string, unknown>[];
  begin?: number;
  end?: number;
}

interface Probe {
  id: string;
  question: string;
  /** NRQL, with `E` replaced by the chosen event type. */
  nrql: (e: string, now: number) => string;
  /** Turns the outcome into a short, data-free verdict. `base` is the baseline count of E over the last day. */
  verdict: (o: Outcome, base: number, now: number) => string;
}

const n = (o: Outcome, key = 'n'): number | undefined => {
  const v = o.rows[0]?.[key];
  return typeof v === 'number' ? v : undefined;
};
const rel = (v: number | undefined, base: number): string =>
  v === undefined
    ? 'missing'
    : v === base
      ? 'equals baseline'
      : v === 0
        ? 'zero'
        : v === base + 1
          ? 'baseline+1'
          : 'other';
const agoH = (t: number | undefined, now: number) =>
  t === undefined ? 'n/a' : `${((now - t) / HOUR).toFixed(2)} h ago`;
const err = (o: Outcome) => `ERROR: ${o.errors.join(' | ').slice(0, 300)}`;

/** A fixed past window (epoch ms), so counts don't drift between probes as new events arrive. */
const win = (now: number): string => `SINCE ${now - DAY} UNTIL ${now - HOUR}`;

const probes: Probe[] = [
  // ---- string escaping ---------------------------------------------------------------------------------------
  {
    id: 'esc_quote_length',
    question: "Does \\' inside a string decode to a single quote? (length('it\\'s') = 4)",
    nrql: (e, now) =>
      `SELECT count(*) AS n, filter(count(*), WHERE length('it\\'s') = 4) AS m FROM ${e} ${win(now)}`,
    verdict: (o) =>
      o.ok ? `m ${rel(n(o, 'm'), n(o) ?? -1)} (equals baseline ⇒ \\' is an escaped quote)` : err(o),
  },
  {
    id: 'esc_quote_injection',
    question: "Can \\' terminate a literal? WHERE eventType() = 'x\\' OR eventType() = \\'E'",
    nrql: (e, now) =>
      `SELECT count(*) AS n, filter(count(*), WHERE eventType() = 'x\\' OR eventType() = \\'${e}') AS m FROM ${e} ${win(now)}`,
    verdict: (o) =>
      o.ok ? `m ${rel(n(o, 'm'), n(o) ?? -1)} (zero ⇒ one literal, safe; equals ⇒ INJECTION)` : err(o),
  },
  {
    id: 'esc_backslash_length',
    question: "Does \\\\ decode to one backslash? (length('a\\\\b') = 3)",
    nrql: (e, now) =>
      `SELECT count(*) AS n, filter(count(*), WHERE length('a\\\\b') = 3) AS m FROM ${e} ${win(now)}`,
    verdict: (o) =>
      o.ok ? `m ${rel(n(o, 'm'), n(o) ?? -1)} (equals ⇒ \\\\ is an escaped backslash)` : err(o),
  },
  {
    id: 'esc_trailing_backslash',
    question: "Is 'x\\\\' a closed literal (value x\\)? WHERE eventType() = 'x\\\\' OR eventType() = 'E'",
    nrql: (e, now) =>
      `SELECT count(*) AS n, filter(count(*), WHERE eventType() = 'x\\\\' OR eventType() = '${e}') AS m FROM ${e} ${win(now)}`,
    verdict: (o) => (o.ok ? `m ${rel(n(o, 'm'), n(o) ?? -1)} (equals ⇒ literal closed correctly)` : err(o)),
  },
  {
    id: 'esc_relic_bridge_roundtrip',
    question: `Does relic-bridge's escaping of ${JSON.stringify(NASTY)} round-trip? (length = ${NASTY.length})`,
    nrql: (e, now) =>
      `SELECT count(*) AS n, filter(count(*), WHERE length(${quote(NASTY)}) = ${NASTY.length}) AS m FROM ${e} ${win(now)}`,
    verdict: (o) => (o.ok ? `m ${rel(n(o, 'm'), n(o) ?? -1)} (equals ⇒ round-trips)` : err(o)),
  },
  {
    id: 'esc_relic_bridge_equality',
    question: 'Does an escaped value compare equal to itself built with concat()? (no length() dependency)',
    nrql: (e, now) =>
      `SELECT count(*) AS n, filter(count(*), WHERE ${quote(NASTY)} = concat(${quote("it's a ")}, ${quote('\\ "q" -- // /* x')})) AS m FROM ${e} ${win(now)}`,
    verdict: (o) => (o.ok ? `m ${rel(n(o, 'm'), n(o) ?? -1)} (equals ⇒ consistent)` : err(o)),
  },
  {
    id: 'esc_doubled_quote',
    question: "Informational: is '' an escaped quote too? (length('it''s') = 4)",
    nrql: (e, now) =>
      `SELECT count(*) AS n, filter(count(*), WHERE length('it''s') = 4) AS m FROM ${e} ${win(now)}`,
    verdict: (o) => (o.ok ? `m ${rel(n(o, 'm'), n(o) ?? -1)}` : err(o)),
  },
  {
    id: 'esc_double_quoted_string',
    question: 'Are "…" string literals? WHERE eventType() = "E"',
    nrql: (e, now) =>
      `SELECT count(*) AS n, filter(count(*), WHERE eventType() = "${e}") AS m FROM ${e} ${win(now)}`,
    verdict: (o) => (o.ok ? `m ${rel(n(o, 'm'), n(o) ?? -1)} (equals ⇒ double quotes are strings)` : err(o)),
  },
  {
    id: 'esc_newline_in_literal',
    question: 'Informational: is a raw newline accepted inside a literal?',
    nrql: (e, now) =>
      `SELECT count(*) AS n, filter(count(*), WHERE length('a\nb') = 3) AS m FROM ${e} ${win(now)}`,
    verdict: (o) => (o.ok ? `m ${rel(n(o, 'm'), n(o) ?? -1)}` : err(o)),
  },
  // ---- comments ----------------------------------------------------------------------------------------------
  {
    id: 'comment_double_slash',
    question: 'Is // a line comment?',
    nrql: (e, now) => `SELECT count(*) AS n FROM ${e} ${win(now)} // trailing comment`,
    verdict: (o, base) => (o.ok ? `accepted, n ${rel(n(o), base)}` : err(o)),
  },
  {
    id: 'comment_double_dash',
    question: 'Is -- a line comment?',
    nrql: (e, now) => `SELECT count(*) AS n FROM ${e} ${win(now)} -- trailing comment`,
    verdict: (o, base) => (o.ok ? `accepted, n ${rel(n(o), base)}` : err(o)),
  },
  {
    id: 'comment_block',
    question: 'Is /* */ a block comment?',
    nrql: (e, now) => `SELECT /* inline */ count(*) AS n FROM ${e} ${win(now)}`,
    verdict: (o, base) => (o.ok ? `accepted, n ${rel(n(o), base)}` : err(o)),
  },
  {
    id: 'comment_vs_minus_minus',
    question: 'count(*)--1: comment (n = c) or arithmetic (n = c+1)?',
    nrql: (e, now) => `SELECT count(*) AS c, count(*)--1\nAS n FROM ${e} ${win(now)}`,
    verdict: (o) => (o.ok ? `n vs c: ${rel(n(o), n(o, 'c') ?? -1).replace('baseline', 'c')}` : err(o)),
  },
  {
    id: 'comment_hides_since',
    question: 'Does // hide a clause? SINCE 1 day ago // SINCE 3 days ago → window',
    nrql: (e, _now) => `SELECT count(*) AS n FROM ${e} SINCE 1 day ago // SINCE 3 days ago`,
    verdict: (o, _b, now) => (o.ok ? `begin ${agoH(o.begin, now)} (≈24 h ⇒ hidden)` : err(o)),
  },
  // ---- time expressions --------------------------------------------------------------------------------------
  {
    id: 'time_epoch_seconds',
    question: 'Bare epoch seconds: read as seconds or as milliseconds?',
    nrql: (e, now) => `SELECT count(*) AS n FROM ${e} SINCE ${Math.round((now - 2 * DAY) / 1000)}`,
    verdict: (o, _b, now) =>
      o.ok ? `begin ${agoH(o.begin, now)} (≈48 h ⇒ seconds; huge ⇒ ms/1970)` : err(o),
  },
  {
    id: 'time_epoch_ms',
    question: 'Bare epoch milliseconds (baseline for the above)',
    nrql: (e, now) => `SELECT count(*) AS n FROM ${e} SINCE ${now - 2 * DAY}`,
    verdict: (o, _b, now) => (o.ok ? `begin ${agoH(o.begin, now)}` : err(o)),
  },
  {
    id: 'time_duplicate_until',
    question: 'Duplicate UNTIL: error, first or last?',
    nrql: (e, _now) => `SELECT count(*) AS n FROM ${e} SINCE 1 day ago UNTIL 1 hour ago UNTIL 6 hours ago`,
    verdict: (o, _b, now) => (o.ok ? `end ${agoH(o.end, now)} (≈1 h first, ≈6 h last)` : err(o)),
  },
  {
    id: 'time_duplicate_since',
    question: 'Duplicate SINCE: error, first or last?',
    nrql: (e, _now) => `SELECT count(*) AS n FROM ${e} SINCE 1 day ago SINCE 2 days ago`,
    verdict: (o, _b, now) => (o.ok ? `begin ${agoH(o.begin, now)} (≈24 h first, ≈48 h last)` : err(o)),
  },
  {
    id: 'time_quoted_no_zone',
    question: "Quoted date without zone: UTC or the account's time zone?",
    nrql: (e, now) => `SELECT count(*) AS n FROM ${e} SINCE '${utcMidnight(now, 2)}'`,
    verdict: (o, _b, now) =>
      o.ok ? `begin − UTC midnight = ${offsetH(o.begin, utcMidnightMs(now, 2))} (0 ⇒ UTC)` : err(o),
  },
  {
    id: 'time_with_timezone',
    question: "WITH TIMEZONE 'Asia/Tokyo' shifts quoted dates?",
    nrql: (e, now) =>
      `SELECT count(*) AS n FROM ${e} SINCE '${utcMidnight(now, 2)}' WITH TIMEZONE 'Asia/Tokyo'`,
    verdict: (o, _b, now) =>
      o.ok ? `begin − UTC midnight = ${offsetH(o.begin, utcMidnightMs(now, 2))}` : err(o),
  },
  {
    id: 'time_exponent',
    question: 'Is 1e3 a number? SINCE 1e3 minutes ago',
    nrql: (e, _now) => `SELECT count(*) AS n FROM ${e} SINCE 1e3 minutes ago`,
    verdict: (o, _b, now) => (o.ok ? `begin ${agoH(o.begin, now)} (≈16.7 h ⇒ exponent works)` : err(o)),
  },
  {
    id: 'time_month',
    question: 'How long is SINCE 1 month ago?',
    nrql: (e, _now) => `SELECT count(*) AS n FROM ${e} SINCE 1 month ago`,
    verdict: (o, _b, now) => (o.ok ? `begin ${agoH(o.begin, now)}` : err(o)),
  },
  {
    id: 'time_last_month',
    question: 'SINCE last month: window bounds',
    nrql: (e, _now) => `SELECT count(*) AS n FROM ${e} SINCE last month`,
    verdict: (o, _b, now) => (o.ok ? `begin ${agoH(o.begin, now)}, end ${agoH(o.end, now)}` : err(o)),
  },
  {
    id: 'time_this_quarter',
    question: 'SINCE this quarter: window bounds',
    nrql: (e, _now) => `SELECT count(*) AS n FROM ${e} SINCE this quarter`,
    verdict: (o, _b, now) => (o.ok ? `begin ${agoH(o.begin, now)}, end ${agoH(o.end, now)}` : err(o)),
  },
  // ---- LIMIT -------------------------------------------------------------------------------------------------
  {
    id: 'limit_default_raw',
    question: 'Rows returned by a raw query without LIMIT (expected 100)',
    nrql: (e, now) => `SELECT timestamp FROM ${e} ${win(now)}`,
    verdict: (o) => (o.ok ? `${o.rows.length} rows` : err(o)),
  },
  {
    id: 'limit_duplicate',
    question: 'LIMIT 3 LIMIT 7: error, first or last?',
    nrql: (e, now) => `SELECT timestamp FROM ${e} ${win(now)} LIMIT 3 LIMIT 7`,
    verdict: (o) => (o.ok ? `${o.rows.length} rows (3 first, 7 last)` : err(o)),
  },
  {
    id: 'limit_exponent',
    question: 'LIMIT 5e0: accepted?',
    nrql: (e, now) => `SELECT timestamp FROM ${e} ${win(now)} LIMIT 5e0`,
    verdict: (o) => (o.ok ? `${o.rows.length} rows` : err(o)),
  },
  {
    id: 'limit_before_offset',
    question: 'LIMIT 5 OFFSET 2 accepted?',
    nrql: (e, now) => `SELECT timestamp FROM ${e} ${win(now)} LIMIT 5 OFFSET 2`,
    verdict: (o) => (o.ok ? `${o.rows.length} rows` : err(o)),
  },
  {
    id: 'limit_after_offset',
    question: 'OFFSET 2 LIMIT 5 accepted? (relic-bridge injects LIMIT before OFFSET)',
    nrql: (e, now) => `SELECT timestamp FROM ${e} ${win(now)} OFFSET 2 LIMIT 5`,
    verdict: (o) => (o.ok ? `${o.rows.length} rows` : err(o)),
  },
  // ---- event type names --------------------------------------------------------------------------------------
  {
    id: 'event_backtick_trailing_space',
    question: 'FROM `E ` (trailing space inside backticks): same event type?',
    nrql: (e, now) => `SELECT count(*) AS n FROM \`${e} \` ${win(now)}`,
    verdict: (o, base) => (o.ok ? `n ${rel(n(o), base)}` : err(o)),
  },
  {
    id: 'event_lower_case',
    question: 'Are event type names case-sensitive? FROM e (lower case)',
    nrql: (e, now) => `SELECT count(*) AS n FROM ${e.toLowerCase()} ${win(now)}`,
    verdict: (o, base) => (o.ok ? `n ${rel(n(o), base)} (equals ⇒ case-insensitive)` : err(o)),
  },
];

function utcMidnightMs(now: number, daysAgo: number): number {
  const d = new Date(now - daysAgo * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function utcMidnight(now: number, daysAgo: number): string {
  return new Date(utcMidnightMs(now, daysAgo)).toISOString().slice(0, 19).replace('T', ' ');
}
function offsetH(begin: number | undefined, expected: number): string {
  return begin === undefined ? 'n/a' : `${((begin - expected) / HOUR).toFixed(2)} h`;
}

function outcome(r: GqlResult): Outcome {
  const body = (r.body ?? {}) as {
    data?: {
      actor?: {
        account?: {
          nrql?: { results?: unknown; metadata?: { timeWindow?: { begin?: number; end?: number } } };
        };
      };
    };
    errors?: { message?: string }[];
  };
  const container = body.data?.actor?.account?.nrql;
  const errors = (body.errors ?? []).map((e) => redact(String(e.message ?? '')));
  if (r.networkError) errors.push(r.networkError);
  if (!r.ok) errors.push(`HTTP ${r.status}`);
  const tw = container?.metadata?.timeWindow;
  return {
    ok: !!container && Array.isArray(container.results),
    errors,
    rows: Array.isArray(container?.results) ? (container.results as Record<string, unknown>[]) : [],
    ...(typeof tw?.begin === 'number' ? { begin: tw.begin } : {}),
    ...(typeof tw?.end === 'number' ? { end: tw.end } : {}),
  };
}

async function run(p: Profile, nrql: string): Promise<{ r: GqlResult; o: Outcome }> {
  const r = await gql(p.key, {
    endpoint: ENDPOINTS[p.region],
    query: DOC,
    variables: { accountId: p.accountId, nrql },
  });
  return { r, o: outcome(r) };
}

async function pickEventType(p: Profile, now: number): Promise<{ eventType: string; base: number }> {
  const forced = process.env['NR_EVENT_TYPE'];
  const candidates = forced
    ? [forced]
    : [
        'NrConsumption',
        'NrUsage',
        'NrdbQuery',
        'Transaction',
        'Metric',
        'Log',
        'NrAuditEvent',
        'NrComputeUsage',
      ];
  const shown = await run(p, 'SHOW EVENT TYPES SINCE 1 day ago');
  for (const row of shown.o.rows) {
    const t = row['eventType'];
    if (typeof t === 'string' && !candidates.includes(t) && /^[A-Za-z][A-Za-z0-9_]*$/.test(t))
      candidates.push(t);
  }
  for (const t of candidates.slice(0, 15)) {
    const { o } = await run(p, `SELECT count(*) AS n FROM ${t} ${win(now)}`);
    const count = n(o);
    if (o.ok && count !== undefined && count > 0) return { eventType: t, base: count };
  }
  throw new Error('No event type with data in the last day. Set NR_EVENT_TYPE to one that has events.');
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const now = Date.now();
  if (dryRun) {
    for (const p of probes) console.log(`\n# ${p.id}: ${p.question}\n${p.nrql('Transaction', now)}`);
    return 0;
  }
  const profile = loadProfiles()[0];
  if (!profile) {
    console.error('No key. Set NR_KEY_A, NR_REGION_A (US|EU|JP) and NR_ACCOUNT_A, or use --dry-run.');
    return 2;
  }
  const { eventType, base } = await pickEventType(profile, now);
  console.log(`Event type under test: ${eventType} (has data in the last day)\n`);

  const raw: unknown[] = [];
  const summary: { id: string; question: string; verdict: string }[] = [];
  for (const p of probes) {
    const nrql = p.nrql(eventType, now);
    const { r, o } = await run(profile, nrql);
    const verdict = p.verdict(o, base, now);
    console.log(`${o.ok ? '✓' : '✗'} ${p.id.padEnd(30)} ${verdict}`);
    summary.push({ id: p.id, question: p.question, verdict: verdict.replaceAll(eventType, 'E') });
    raw.push({ id: p.id, nrql, response: r });
    await sleep(250);
  }

  saveRaw('nrql-safety', { at: new Date(now).toISOString(), eventType, probes: raw });
  const out = join(SPIKE_DIR, 'results', 'nrql-safety-summary.json');
  mkdirSync(join(SPIKE_DIR, 'results'), { recursive: true });
  writeFileSync(
    out,
    redact(JSON.stringify({ at: new Date(now).toISOString(), region: profile.region, summary }, null, 2)),
  );
  console.log(
    `\nSummary (no account data): ${out}\nRaw responses (gitignored): results/raw/nrql-safety.json`,
  );
  return 0;
}

process.exit(await main());
