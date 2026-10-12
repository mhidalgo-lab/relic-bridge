// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  assertRawNrqlAllowed,
  createBudget,
  DEFAULT_LIMITS,
  ErrorCode,
  enforceQueryLimits,
  nerdGraphFor,
  nrql,
  type QueryLimits,
  RbError,
  runNrql,
  runRawNrql,
  tokenize,
} from '../src/index.ts';
import { testContext } from './helpers/context.ts';
import { json, scriptedFetch } from './helpers/nerdgraph.ts';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 86_400_000;

function check(source: string, limits: Partial<QueryLimits> = {}) {
  return enforceQueryLimits(source, { ...DEFAULT_LIMITS, ...limits }, NOW);
}

function rejection(source: string, limits: Partial<QueryLimits> = {}): RbError {
  try {
    check(source, limits);
  } catch (error) {
    if (error instanceof RbError) return error;
    throw error;
  }
  throw new Error(`expected ${source} to be rejected`);
}

describe('tokenize', () => {
  it('marks comments and keeps strings, identifiers and depth', () => {
    const tokens = tokenize("SELECT `a b` -- x LIMIT 1\nFROM (SELECT 'it\\'s' /* FROM y */ // z\n) 1e6");
    expect(tokens.map((t) => [t.kind, t.kind === 'comment' ? '' : t.value, t.depth])).toEqual([
      ['word', 'SELECT', 0],
      ['ident', 'a b', 0],
      ['comment', '', 0],
      ['word', 'FROM', 0],
      ['punct', '(', 0],
      ['word', 'SELECT', 1],
      ['string', "it's", 1],
      ['comment', '', 1],
      ['comment', '', 1],
      ['punct', ')', 0],
      ['number', '1e6', 0],
    ]);
  });

  it.each(["SELECT 'open", 'SELECT `open', 'SELECT 1 /* open', "SELECT 'trailing\\"])(
    'rejects unterminated input: %s',
    (source) => {
      let code: string | undefined;
      try {
        tokenize(source);
      } catch (e) {
        code = (e as RbError).code;
      }
      expect(code).toBe(ErrorCode.InputInvalid);
    },
  );
});

describe('LIMIT', () => {
  it('injects a LIMIT into raw event queries without one', () => {
    const out = check('SELECT * FROM Log SINCE 1 hour ago');
    // NRQL's own default is 10 rows (P1-04 probe), so the injected LIMIT never returns more than NRQL would.
    expect(out.nrql).toBe('SELECT * FROM Log SINCE 1 hour ago LIMIT 10');
    expect(out.notes).toEqual(['LIMIT 10 added (raw event query without LIMIT).']);
    expect(check('SELECT message FROM Log', { maxLimit: 5 }).nrql).toMatch(/LIMIT 5$/);
  });

  it('injects before OFFSET', () => {
    expect(check('SELECT * FROM Log OFFSET 3').nrql).toBe('SELECT * FROM Log LIMIT 10 OFFSET 3');
  });

  it('ignores LIMIT inside strings', () => {
    expect(check("SELECT * FROM Log WHERE m = 'LIMIT 5'").notes).toHaveLength(1);
  });

  it('clamps LIMITs in subqueries too', () => {
    expect(check('SELECT count(*) FROM (SELECT * FROM Log LIMIT MAX)').nrql).toBe(
      'SELECT count(*) FROM (SELECT * FROM Log LIMIT 1000)',
    );
  });

  // Reviewer findings (P1-04 security review).
  it.each([
    ['two LIMITs', 'SELECT * FROM Log LIMIT 10 LIMIT 100000'],
    ['exponent', 'SELECT * FROM Log LIMIT 1e6'],
    ['hex', 'SELECT * FROM Log LIMIT 0x10'],
    ['trailing junk', 'SELECT * FROM Log LIMIT 10 + 100000'],
  ])('rejects %s', (_name, q) => {
    expect(rejection(q).code).toBe(ErrorCode.LimitQuery);
  });

  it('leaves aggregate and FACET queries alone (NRQL defaults already bound them)', () => {
    for (const q of [
      'SELECT count(*) FROM Transaction',
      'SELECT count(*) FROM Transaction FACET appName',
      'SELECT latest(x) FROM (SELECT * FROM Log) TIMESERIES',
      'SHOW EVENT TYPES',
    ]) {
      expect(check(q)).toMatchObject({ nrql: q, notes: [] });
    }
  });

  it('clamps LIMIT above the connection limit and LIMIT MAX', () => {
    expect(check('SELECT * FROM Log LIMIT 5000').nrql).toBe('SELECT * FROM Log LIMIT 1000');
    expect(check('SELECT count(*) FROM T FACET a LIMIT MAX').nrql).toBe(
      'SELECT count(*) FROM T FACET a LIMIT 1000',
    );
    expect(check('SELECT * FROM Log LIMIT 50').notes).toEqual([]);
  });

  it('rejects malformed LIMITs', () => {
    expect(rejection('SELECT * FROM Log LIMIT -1').code).toBe(ErrorCode.LimitQuery);
    expect(rejection('SELECT * FROM Log LIMIT 1.5').code).toBe(ErrorCode.LimitQuery);
    expect(rejection('SELECT * FROM Log LIMIT x').code).toBe(ErrorCode.LimitQuery);
  });
});

describe('time window', () => {
  it.each([
    ['no SINCE (1 hour default)', 'SELECT count(*) FROM T'],
    ['7 days', 'SELECT count(*) FROM T SINCE 7 days ago'],
    ['1 week', 'SELECT count(*) FROM T SINCE 1 week ago'],
    ['UNTIL narrows', 'SELECT count(*) FROM T SINCE 7 days ago UNTIL 3 days ago'],
    ['calendar', 'SELECT count(*) FROM T SINCE yesterday UNTIL today'],
    ['this week', 'SELECT count(*) FROM T SINCE this week'],
    ['epoch ms', `SELECT count(*) FROM T SINCE ${NOW - 2 * DAY}`],
    ['epoch s', `SELECT count(*) FROM T SINCE ${(NOW - 2 * DAY) / 1000}`],
    ['quoted date', "SELECT count(*) FROM T SINCE '2026-10-01 00:00:00' UNTIL '2026-10-03'"],
    ['ISO with zone', "SELECT count(*) FROM T SINCE '2026-10-01T00:00:00+02:00'"],
    ['UNTIL NOW', 'SELECT count(*) FROM T SINCE 2 hours ago UNTIL NOW'],
    ['compare within', 'SELECT count(*) FROM T SINCE 1 day ago COMPARE WITH 1 day ago'],
    ['SINCE in a string', "SELECT count(*) FROM T WHERE m = 'SINCE 30 days ago'"],
  ])('allows %s', (_name, q) => {
    expect(() => check(q)).not.toThrow();
  });

  it.each([
    ['30 days', 'SELECT count(*) FROM T SINCE 30 days ago'],
    ['8 days', 'SELECT count(*) FROM T SINCE 8 days ago'],
    ['last month', 'SELECT count(*) FROM T SINCE last month'],
    ['old epoch', `SELECT count(*) FROM T SINCE ${NOW - 10 * DAY}`],
    ['old date', "SELECT count(*) FROM T SINCE '2026-01-01'"],
    ['compare widens', 'SELECT count(*) FROM T SINCE 1 day ago COMPARE WITH 1 week ago'],
    ['subquery', 'SELECT max(c) FROM (SELECT count(*) AS c FROM T SINCE 30 days ago TIMESERIES)'],
  ])('rejects %s', (_name, q) => {
    const error = rejection(q);
    expect(error.code).toBe(ErrorCode.LimitQuery);
    expect(error.hint).toContain('SINCE 7 days ago');
  });

  // BUG-22 (live test run 2026-10-12): maxWindowDays also limits how far back a query reads, not only its width.
  it.each([
    ['relative, UNTIL in the past', 'SELECT count(*) FROM T SINCE 60 days ago UNTIL 59 days ago'],
    ['relative, lowercase', 'select count(*) from T since 60 days ago until 59 days ago'],
    ['quoted dates', "SELECT count(*) FROM T SINCE '2026-07-25 00:00:00' UNTIL '2026-07-26 00:00:00'"],
    ['quoted ISO dates', "SELECT count(*) FROM T SINCE '2026-07-25T00:00:00Z' UNTIL '2026-07-26T00:00:00Z'"],
    ['epoch ms', `SELECT count(*) FROM T SINCE ${NOW - 80 * DAY} UNTIL ${NOW - 79 * DAY}`],
    [
      'epoch seconds',
      `SELECT count(*) FROM T SINCE ${(NOW - 80 * DAY) / 1000} UNTIL ${(NOW - 79 * DAY) / 1000}`,
    ],
    ['months then days', 'SELECT count(*) FROM T SINCE 3 months ago UNTIL 89 days ago'],
    ['weeks', 'SELECT count(*) FROM T SINCE 3 weeks ago UNTIL 2 weeks ago'],
    ['calendar keyword', 'SELECT count(*) FROM T SINCE last month UNTIL this month'],
    [
      'compare offset counts',
      'SELECT count(*) FROM T SINCE 2 days ago UNTIL 1 day ago COMPARE WITH 6 days ago',
    ],
    [
      'subquery in the past',
      'SELECT max(c) FROM (SELECT count(*) AS c FROM T SINCE 60 days ago UNTIL 59 days ago)',
    ],
    ['metric', 'SELECT average(v) FROM Metric SINCE 60 days ago UNTIL 59 days ago'],
    [
      'with timezone',
      "SELECT count(*) FROM T SINCE '2026-09-26 12:00:00' UNTIL '2026-09-27' WITH TIMEZONE 'UTC'",
    ],
  ])('rejects a narrow window that starts too far back: %s', (_name, q) => {
    const error = rejection(q);
    expect(error.code).toBe(ErrorCode.LimitQuery);
    expect(error.message).toMatch(/days/);
  });

  it('allows exactly maxWindowDays of lookback (inclusive boundary) and rejects a millisecond more', () => {
    expect(() => check(`SELECT count(*) FROM T SINCE ${NOW - 7 * DAY} UNTIL ${NOW - 6 * DAY}`)).not.toThrow();
    expect(() => check(`SELECT count(*) FROM T SINCE ${NOW - 7 * DAY - 1} UNTIL ${NOW - 6 * DAY}`)).toThrow(
      RbError,
    );
    expect(() => check('SELECT count(*) FROM T SINCE 7 days ago UNTIL 6 days ago')).not.toThrow();
  });

  it('honours a raised limit for lookback', () => {
    expect(() =>
      check('SELECT count(*) FROM T SINCE 60 days ago UNTIL 59 days ago', { maxWindowDays: 90 }),
    ).not.toThrow();
  });

  it.each([
    'SELECT count(*) FROM T SINCE whenever',
    'SELECT count(*) FROM T SINCE 3 hours',
    "SELECT count(*) FROM T SINCE 'not a date'",
    'SELECT count(*) FROM T SINCE 1 day ago COMPARE WITH yesterday',
  ])('fails closed on time forms it cannot read: %s', (q) => {
    expect(rejection(q).code).toBe(ErrorCode.LimitQuery);
  });

  // Reviewer findings (P1-04 security review).
  it.each([
    ['duplicate UNTIL', 'SELECT count(*) FROM T SINCE 1 day ago UNTIL 0 minutes ago UNTIL 6 days ago'],
    ['duplicate SINCE', 'SELECT count(*) FROM T SINCE 1 day ago SINCE 30 days ago'],
    ['duplicate COMPARE', 'SELECT count(*) FROM T COMPARE WITH 1 day ago COMPARE WITH 1 hour ago'],
    ['ambiguous epochs', 'SELECT count(*) FROM T SINCE 10000000000 UNTIL 20000000000'],
    ['tiny epochs', 'SELECT count(*) FROM T SINCE 1000'],
    ['exponent', 'SELECT count(*) FROM T SINCE 1e3 days ago'],
  ])('rejects %s', (_name, q) => {
    expect(rejection(q).code).toBe(ErrorCode.LimitQuery);
  });

  it('reports the window it measured', () => {
    expect(check('SELECT count(*) FROM T SINCE 2 days ago UNTIL 1 day ago').windowMs).toBe(DAY);
    expect(check('SELECT count(*) FROM T SINCE 40 days ago', { maxWindowDays: 90 }).windowMs).toBe(40 * DAY);
  });
});

describe('event types', () => {
  it('collects event types from FROM lists, backticks and subqueries', () => {
    expect(
      check('SELECT count(*) FROM Transaction, `Log` WHERE x IN (SELECT y FROM Span)').eventTypes,
    ).toEqual(['Transaction', 'Log', 'Span']);
  });

  it('enforces deny lists case-insensitively, wherever the event type appears', () => {
    const deny = { eventTypes: { deny: ['Log'] } };
    for (const q of [
      'SELECT * FROM Log',
      'SELECT * FROM log',
      'SELECT * FROM `Log`',
      'SELECT count(*) FROM Transaction, Log',
      'SELECT max(c) FROM (SELECT count(*) AS c FROM Log TIMESERIES)',
      'FROM Transaction JOIN (FROM Log SELECT count(*) FACET id) ON id SELECT count(*)',
    ]) {
      expect(rejection(q, deny)).toMatchObject({
        code: ErrorCode.LimitQuery,
        details: { eventType: expect.any(String) },
      });
    }
    expect(() => check('SELECT count(*) FROM Transaction', deny)).not.toThrow();
  });

  // Reviewer findings (P1-04 security review).
  it('treats names glued to punctuation as unresolved and trims backtick names', () => {
    const allow = { eventTypes: { allow: ['Log'] } };
    expect(rejection('SELECT * FROM Log-Archive', allow).code).toBe(ErrorCode.LimitQuery);
    expect(rejection('SELECT * FROM Log:x', allow).code).toBe(ErrorCode.LimitQuery);
    expect(rejection('SELECT * FROM `Secret `', { eventTypes: { deny: ['Secret'] } }).code).toBe(
      ErrorCode.LimitQuery,
    );
    expect(() => check('SELECT * FROM Log AS l WHERE l.x = 1', allow)).not.toThrow();
  });

  it('rejects queries without FROM when an allow list is set', () => {
    expect(rejection('SHOW EVENT TYPES', { eventTypes: { allow: ['Log'] } }).code).toBe(ErrorCode.LimitQuery);
    expect(() => check('SHOW EVENT TYPES', { eventTypes: { deny: ['Log'] } })).not.toThrow();
  });

  it('enforces allow lists', () => {
    const allow = { eventTypes: { allow: ['Transaction'] } };
    expect(() => check('SELECT count(*) FROM Transaction', allow)).not.toThrow();
    expect(rejection('SELECT count(*) FROM Transaction, Log', allow).code).toBe(ErrorCode.LimitQuery);
  });

  it('fails closed when FROM cannot be resolved and lists are configured', () => {
    const allow = { eventTypes: { allow: ['Transaction'] } };
    expect(rejection('SELECT * FROM lookup(myTable)', allow).code).toBe(ErrorCode.LimitQuery);
    expect(rejection("SELECT * FROM 'Transaction'", allow).code).toBe(ErrorCode.LimitQuery);
    expect(() => check('SELECT * FROM lookup(myTable)')).not.toThrow(); // no lists: nothing to enforce
  });
});

describe('comments', () => {
  // NRQL reads --, // and /* */ as comments, exactly like the tokenizer (P1-04 probe, incl. `count(*)--1`).
  it('checks the query without comments and sends it without them', () => {
    const out = check('SELECT count(*) FROM Log // SINCE 400 days ago');
    expect(out.nrql).toBe('SELECT count(*) FROM Log');
    expect(out.windowMs).toBe(3_600_000);
    expect(out.notes).toEqual(['Comments removed before sending.']);
    expect(check('SELECT /* x */ count(*) FROM Log -- y').nrql).toBe('SELECT   count(*) FROM Log');
  });

  it('sees event types and LIMITs split around comments', () => {
    expect(rejection('SELECT count(*) FROM T -- x\n, Log', { eventTypes: { deny: ['Log'] } }).code).toBe(
      ErrorCode.LimitQuery,
    );
    expect(check('SELECT * FROM Log /* LIMIT 5 */').nrql).toBe('SELECT * FROM Log   LIMIT 10');
  });

  it('treats x--1 as a comment, like NRQL', () => {
    const out = check('SELECT average(x)--1 FROM Log SINCE 400 days ago');
    expect(out.nrql).toBe('SELECT average(x)');
    expect(out.eventTypes).toEqual([]);
  });

  it('keeps comment markers inside strings', () => {
    const q = "SELECT count(*) FROM Log WHERE m = '-- // /* */'";
    expect(check(q).nrql).toBe(q);
  });
});

describe('NRQL syntax mirrored from the probe', () => {
  it('rejects double-quoted strings like NRQL does', () => {
    expect(rejection('SELECT count(*) FROM Log WHERE a = "x"').code).toBe(ErrorCode.InputInvalid);
  });

  it('widens quoted-date windows by 14 h under WITH TIMEZONE', () => {
    const date = new Date(NOW - 6.5 * DAY).toISOString().slice(0, 19).replace('T', ' ');
    expect(() => check(`SELECT count(*) FROM T SINCE '${date}'`)).not.toThrow();
    expect(rejection(`SELECT count(*) FROM T SINCE '${date}' WITH TIMEZONE 'Asia/Tokyo'`).code).toBe(
      ErrorCode.LimitQuery,
    );
  });

  it('counts a month as 30 days', () => {
    expect(check('SELECT count(*) FROM T SINCE 1 month ago', { maxWindowDays: 30 }).windowMs).toBe(30 * DAY);
  });

  it('matches allow lists exactly (event types are case-sensitive) and deny lists loosely', () => {
    const allow = { eventTypes: { allow: ['Transaction'] } };
    expect(rejection('SELECT count(*) FROM transaction', allow).code).toBe(ErrorCode.LimitQuery);
    expect(rejection('SELECT count(*) FROM `Transaction `', allow).code).toBe(ErrorCode.LimitQuery);
    expect(rejection('SELECT count(*) FROM `log `', { eventTypes: { deny: ['Log'] } }).code).toBe(
      ErrorCode.LimitQuery,
    );
  });
});

describe('rawNrql flag', () => {
  it('disables arbitrary NRQL', () => {
    expect(() => assertRawNrqlAllowed({ ...DEFAULT_LIMITS, rawNrql: false })).toThrow(
      expect.objectContaining({ code: ErrorCode.ToolDisabled }),
    );
    expect(() => assertRawNrqlAllowed(DEFAULT_LIMITS)).not.toThrow();
  });
});

describe('runNrql applies limits', () => {
  function setup(limits: Partial<QueryLimits> = {}) {
    const ctx = testContext({
      limits: { ...DEFAULT_LIMITS, ...limits },
      budget: createBudget(10),
      clock: { now: () => NOW },
    });
    const ok = json({
      data: { actor: { account: { nrql: { results: [], queryProgress: { completed: true } } } } },
    });
    const { fetch, calls } = scriptedFetch(ok);
    return { ctx, calls, deps: { client: nerdGraphFor(ctx, { fetch }) } };
  }

  it('rejects before any request', async () => {
    const { ctx, calls, deps } = setup({ eventTypes: { deny: ['Log'] } });
    await expect(runRawNrql(ctx, { nrql: 'SELECT * FROM Log' }, deps)).rejects.toMatchObject({
      code: ErrorCode.LimitQuery,
    });
    await expect(
      runRawNrql(ctx, { nrql: 'SELECT count(*) FROM T SINCE 30 days ago' }, deps),
    ).rejects.toMatchObject({
      code: ErrorCode.LimitQuery,
    });
    expect(calls).toHaveLength(0);
    expect(ctx.budget.used).toBe(0);
  });

  it('keeps strings out of runNrql and honours the rawNrql switch', async () => {
    const { ctx, calls, deps } = setup({ rawNrql: false });
    await expect(runNrql(ctx, { nrql: 'SELECT 1' as never }, deps)).rejects.toMatchObject({
      code: ErrorCode.Internal,
    });
    await expect(runRawNrql(ctx, { nrql: 'SELECT count(*) FROM T' }, deps)).rejects.toMatchObject({
      code: ErrorCode.ToolDisabled,
    });
    expect((await runNrql(ctx, { nrql: nrql`SELECT count(*) FROM T` }, deps)).status).toBe('complete');
    expect(calls).toHaveLength(1);
  });

  it('sends the adjusted NRQL and reports the notes', async () => {
    const { ctx, calls, deps } = setup();
    const out = await runNrql(ctx, { nrql: nrql`SELECT * FROM Log WHERE level = ${'error'}` }, deps);
    expect(calls[0]?.body.variables['nrql']).toBe("SELECT * FROM Log WHERE level = 'error' LIMIT 10");
    expect(out.notes).toEqual(['LIMIT 10 added (raw event query without LIMIT).']);
  });
});
