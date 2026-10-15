// SPDX-License-Identifier: Apache-2.0
// Database fixtures for the upgrade tests (P8-05): one per published minor, at that minor's newest patch tag.
//
// A fixture is the database a user of that release has: the migrations embedded in the release
// (`git show <tag>:packages/storage/src/migrations.generated.ts`, exactly what shipped), applied by the migration
// runner to an empty SQLite database, plus the fixed synthetic SEED below, dumped as plain SQL statements (schema in
// creation order, then rows parents first). Nothing in a fixture is written by hand.
//
//   node scripts/gen-db-fixtures.ts           (re)write packages/storage/test/fixtures/db/v<minor>.json
//   node scripts/gen-db-fixtures.ts --check   part of `pnpm lint`
//
// `--check` always re-derives every dump from the migrations recorded in its fixture (catches hand edits) and checks
// that each recorded migration is still in this build, unchanged. With release tags available it also checks the
// recorded migrations against the minor's newest tag, that every published minor (0.7+) has a fixture, and that no
// patch release changed the migrations of its minor (versioning policy). A shallow clone without tags skips those
// three, and says so.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { type Migration, type MigrationDriver, migrate } from '../packages/storage/src/migrate.ts';
import { MIGRATIONS } from '../packages/storage/src/migrations.generated.ts';

export const FIXTURE_DIR = 'packages/storage/test/fixtures/db';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GENERATED = 'packages/storage/src/migrations.generated.ts';
/** First published release (P8-14); earlier tags were never published. */
export const FIRST_MINOR = '0.7';
/** `applied_at` of the fixture's migration rows and the base of every seeded time (2026-10-01T00:00:00Z). */
export const SEED_TIME = 1_790_812_800_000;

export interface FixtureMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly statements: readonly string[];
}

export interface DbFixture {
  /** `0.9`: the minor this fixture stands for. */
  readonly minor: string;
  /** Tag the migrations were read from (the minor's newest patch). */
  readonly tag: string;
  readonly generatedBy: string;
  /** Migrations embedded in that release, as shipped. */
  readonly migrations: readonly FixtureMigration[];
  /** The database: schema statements, then INSERTs. Load in order into an empty database. */
  readonly dump: readonly string[];
}

interface Seed {
  readonly sql: string;
  readonly params: readonly SQLInputValue[];
}

const bytes = (n: number, f: (i: number) => number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => f(i));
const hex64 = (c: string): string => c.repeat(64);
const t = (minutes: number): number => SEED_TIME + minutes * 60_000;

/**
 * Synthetic rows covering every table and nullable column group of the 0.7.0 schema (schema version 4): fake
 * ciphertext, hashes of no real token, example.com mail, made-up account ids. Every published schema has these
 * columns; a later migration that drops or renames one needs the seed split by schema version.
 */
export const SEED: readonly Seed[] = [
  {
    sql: 'INSERT INTO users (id, email, display_name, idp, idp_subject, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    params: ['usr_owner', 'owner@example.com', 'Owner', 'google', 'sub-owner', 'owner', t(0), t(0)],
  },
  {
    sql: 'INSERT INTO users (id, email, display_name, role, created_at, updated_at, disabled_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: ['usr_member', 'member@example.com', null, 'member', t(1), t(2), null],
  },
  {
    sql:
      'INSERT INTO credentials (id, owner_user_id, label, region, key_ciphertext, key_iv, key_version, key_hint, ' +
      'validation_status, validated_at, nr_user_id, nr_user_email, reachable_account_ids, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      'cred_shared',
      null,
      'Shared key',
      'US',
      bytes(40, (i) => (i * 7 + 1) % 256),
      bytes(12, (i) => i + 1),
      1,
      'AB12',
      'valid',
      t(3),
      1001,
      'nr-user@example.com',
      '[1111111,2222222]',
      t(3),
      t(3),
    ],
  },
  {
    sql:
      'INSERT INTO credentials (id, owner_user_id, label, region, key_ciphertext, key_iv, key_version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      'cred_member',
      'usr_member',
      'My key',
      'EU',
      bytes(40, (i) => (i * 11 + 2) % 256),
      bytes(12, (i) => i + 2),
      2,
      t(4),
      t(4),
    ],
  },
  {
    sql:
      'INSERT INTO projects (id, slug, name, default_account_id, allowed_account_ids, enabled_tools, limits, ' +
      'default_credential_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      'prj_main',
      'main',
      'Main project',
      1111111,
      '[1111111,2222222]',
      null,
      '{"maxLimit":500,"maxWindowDays":7,"eventTypes":{"deny":["Secret"]}}',
      'cred_shared',
      t(5),
      t(5),
    ],
  },
  {
    sql:
      'INSERT INTO projects (id, slug, name, default_account_id, allowed_account_ids, enabled_tools, limits, ' +
      'created_at, updated_at, disabled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: ['prj_off', 'off', null, 3333333, '[3333333]', '["whoami","run_nrql"]', '{}', t(6), t(6), t(7)],
  },
  {
    sql:
      'INSERT INTO grants (id, project_id, user_id, label, credential_id, tools, account_ids, limits, rate_limit, ' +
      'created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      'gr_member',
      'prj_main',
      'usr_member',
      null,
      'cred_member',
      '["whoami","run_nrql"]',
      '[1111111]',
      '{"maxLimit":100}',
      '{"requests":60,"perSeconds":60}',
      t(8),
      t(8),
      t(60 * 24 * 365),
    ],
  },
  {
    sql: 'INSERT INTO grants (id, project_id, label, limits, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: ['gr_service', 'prj_main', 'ci-bot', '{}', t(9), t(9), null],
  },
  {
    sql:
      'INSERT INTO access_tokens (id, grant_id, prefix, token_hash, label, created_at, expires_at, last_used_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    params: ['tok_laptop', 'gr_member', 'rb_abcd', hex64('a'), 'laptop', t(10), null, t(20)],
  },
  {
    sql: 'INSERT INTO access_tokens (id, grant_id, prefix, token_hash, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: ['tok_ci', 'gr_service', 'rb_ef01', hex64('b'), 'ci', t(11), t(12)],
  },
  {
    sql:
      'INSERT INTO audit_log (ts, kind, action, status, request_id, user_id, grant_id, token_id, project_id, ' +
      'account_ids, nrql, duration_ms, inspected_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      t(21),
      'tool_call',
      'run_nrql',
      'ok',
      'req-1',
      'usr_member',
      'gr_member',
      'tok_laptop',
      'prj_main',
      '[1111111]',
      'SELECT count(*) FROM Transaction SINCE ? minutes ago',
      120,
      5000,
    ],
  },
  {
    sql: 'INSERT INTO audit_log (ts, kind, action, status, error_code, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    params: [t(22), 'admin', 'token.revoke', 'ok', null, 'token', 'tok_ci', '{"actor":"admin_token"}'],
  },
  {
    sql: 'INSERT INTO audit_log (ts, kind, action, status, error_code) VALUES (?, ?, ?, ?, ?)',
    params: [t(23), 'auth', 'auth.denied', 'denied', 'invalid_token'],
  },
  {
    sql: 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    params: ['oauth.registration', '"approval"', t(24)],
  },
  {
    sql: 'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)',
    params: ['fixture:live', '{"v":1}', t(60 * 24 * 365 * 50)],
  },
  {
    sql: 'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)',
    params: ['fixture:forever', 'plain', null],
  },
  {
    sql: 'UPDATE grants SET quota = ? WHERE id = ?',
    params: ['{"day":{"queries":100},"month":{"inspectedEvents":1000000},"warnPercent":80}', 'gr_member'],
  },
  {
    sql: 'INSERT INTO audit_log (ts, kind, action, status, key_id, account_ids) VALUES (?, ?, ?, ?, ?, ?)',
    params: [t(25), 'tool_call', 'whoami', 'ok', 'pt_0123456789ab', '[1111111]'],
  },
  {
    sql: 'INSERT INTO grant_usage (grant_id, period, queries, inspected, updated_at) VALUES (?, ?, ?, ?, ?)',
    params: ['gr_member', 'd2026-10-01', 3, 15000, t(26)],
  },
  {
    sql: 'INSERT INTO grant_usage (grant_id, period, queries, inspected, updated_at) VALUES (?, ?, ?, ?, ?)',
    params: ['gr_member', 'm2026-10', 3, 15000, t(26)],
  },
];

function driverFor(db: DatabaseSync): MigrationDriver {
  return {
    async all(sql, params = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[];
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const s of statements) db.prepare(s.sql).run(...((s.params ?? []) as SQLInputValue[]));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

const quoteId = (name: string): string => `\`${name.replaceAll('`', '``')}\``;

/** A value as an SQL literal (fixture values are synthetic; this is a dump, not a query builder). */
export function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  throw new TypeError(`unsupported SQLite value ${typeof value}`);
}

/** User tables, parents before children (foreign keys), ties by name. */
export function tableOrder(db: DatabaseSync): string[] {
  const names = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const parents = new Map(
    names.map((n) => [
      n,
      new Set(
        (db.prepare(`PRAGMA foreign_key_list(${quoteId(n)})`).all() as { table: string }[])
          .map((f) => f.table)
          .filter((p) => p !== n),
      ),
    ]),
  );
  const out: string[] = [];
  while (out.length < names.length) {
    const next = names.find(
      (n) => !out.includes(n) && [...(parents.get(n) ?? [])].every((p) => out.includes(p)),
    );
    if (next === undefined) throw new Error('foreign-key cycle between tables');
    out.push(next);
  }
  return out;
}

/** Schema (creation order, tables before indexes) then every row as an INSERT. */
export function dumpDatabase(db: DatabaseSync): string[] {
  const schema = db
    .prepare(
      "SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' " +
        "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid",
    )
    .all() as { type: string; sql: string }[];
  const out = schema.map((s) => s.sql);
  for (const table of tableOrder(db)) {
    const cols = db.prepare(`PRAGMA table_info(${quoteId(table)})`).all() as { name: string; pk: number }[];
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => quoteId(c.name));
    const order = pk.length > 0 ? pk.join(', ') : 'rowid';
    const rows = db.prepare(`SELECT * FROM ${quoteId(table)} ORDER BY ${order}`).all() as Record<
      string,
      unknown
    >[];
    // Columns by name, not position: a value then never directly follows a name such as `0001_audit_auth_kind`, which
    // the secret scanner's generic rule would read as a key assignment (the migration checksums are high-entropy hex).
    const names = cols.map((c) => c.name).sort();
    const list = names.map(quoteId).join(', ');
    for (const row of rows) {
      out.push(
        `INSERT INTO ${quoteId(table)} (${list}) VALUES (${names.map((c) => literal(row[c])).join(', ')})`,
      );
    }
  }
  return out;
}

/** The database a release with these migrations creates, with the seed, as a dump. */
export async function buildDump(migrations: readonly FixtureMigration[]): Promise<string[]> {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    await migrate(driverFor(db), migrations as readonly Migration[], { now: () => SEED_TIME });
    db.exec('BEGIN');
    for (const s of SEED) db.prepare(s.sql).run(...s.params);
    db.exec('COMMIT');
    return dumpDatabase(db);
  } finally {
    db.close();
  }
}

/** The `MIGRATIONS` array of a `migrations.generated.ts` source (JSON inside `Object.freeze(...)`). */
export function parseGeneratedMigrations(source: string): FixtureMigration[] {
  const start = source.indexOf('Object.freeze(');
  const end = source.lastIndexOf(');');
  if (start < 0 || end < start) throw new Error('not a migrations.generated.ts module');
  return JSON.parse(source.slice(start + 'Object.freeze('.length, end)) as FixtureMigration[];
}

export interface Release {
  readonly tag: string;
  readonly minor: string;
  readonly patch: number;
}

/** Published release tags `vX.Y.Z` from FIRST_MINOR on (pre-releases excluded). */
export function parseTags(lines: readonly string[]): Release[] {
  const [fMajor, fMinor] = FIRST_MINOR.split('.').map(Number) as [number, number];
  return lines
    .map((l) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), tag: m[0] }))
    .filter((r) => r.major > fMajor || (r.major === fMajor && r.minor >= fMinor))
    .sort((a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch)
    .map((r) => ({ tag: r.tag, minor: `${r.major}.${r.minor}`, patch: r.patch }));
}

/** Newest patch of each minor. */
export function latestPerMinor(releases: readonly Release[]): Release[] {
  const by = new Map<string, Release>();
  for (const r of releases) by.set(r.minor, r);
  return [...by.values()];
}

/** Each fixture migration is still in this build, with the same name and checksum. */
export function checkAgainstBuild(fixture: DbFixture, build: readonly FixtureMigration[]): string[] {
  const problems: string[] = [];
  for (const m of fixture.migrations) {
    const now = build[m.version - 1];
    if (now?.name !== m.name || now.checksum !== m.checksum) {
      problems.push(
        `v${fixture.minor}: migration ${m.name} shipped in ${fixture.tag} is missing or changed in this build (migrations are forward-only)`,
      );
    }
  }
  return problems;
}

const git = (args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const releasedMigrations = (tag: string): FixtureMigration[] =>
  parseGeneratedMigrations(git(['show', `${tag}:${GENERATED}`]));

const fixturePath = (minor: string): string => `${ROOT}${FIXTURE_DIR}/v${minor}.json`;

export function renderFixture(fixture: DbFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

function readFixtures(): DbFixture[] {
  return readdirSync(`${ROOT}${FIXTURE_DIR}`)
    .filter((f) => /^v\d+\.\d+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(`${ROOT}${FIXTURE_DIR}/${f}`, 'utf8')) as DbFixture);
}

export async function main(args: readonly string[]): Promise<number> {
  const check = args.includes('--check');
  let releases: Release[] = [];
  try {
    releases = parseTags(git(['tag', '--list', 'v*']).split('\n'));
  } catch {
    releases = [];
  }
  if (!check) {
    if (releases.length === 0) {
      console.error('✗ no release tags (v*) found; fetch them first: git fetch --tags');
      return 1;
    }
    for (const r of latestPerMinor(releases)) {
      const migrations = releasedMigrations(r.tag);
      const fixture: DbFixture = {
        minor: r.minor,
        tag: r.tag,
        generatedBy: 'node scripts/gen-db-fixtures.ts',
        migrations,
        dump: await buildDump(migrations),
      };
      writeFileSync(fixturePath(r.minor), renderFixture(fixture));
      console.log(`Wrote ${FIXTURE_DIR}/v${r.minor}.json (${r.tag}, schema version ${migrations.length})`);
    }
    return 0;
  }

  const problems: string[] = [];
  const fixtures = readFixtures();
  if (fixtures.length === 0) problems.push(`no fixtures in ${FIXTURE_DIR}`);
  for (const f of fixtures) {
    const dump = await buildDump(f.migrations);
    if (JSON.stringify(dump) !== JSON.stringify(f.dump)) {
      problems.push(
        `v${f.minor}: dump does not match its migrations and the seed (edited by hand, or SEED changed)`,
      );
    }
    problems.push(...checkAgainstBuild(f, MIGRATIONS));
  }
  if (releases.length === 0) {
    console.log('• no release tags in this clone: skipped the tag comparison (fetch tags to run it)');
  } else {
    const byMinor = new Map(fixtures.map((f) => [f.minor, f]));
    for (const r of latestPerMinor(releases)) {
      const f = byMinor.get(r.minor);
      if (f === undefined) {
        problems.push(`published minor ${r.minor} (${r.tag}) has no fixture`);
        continue;
      }
      // Any patch of the minor will do: patches never change migrations (checked below).
      if (JSON.stringify(releasedMigrations(r.tag)) !== JSON.stringify(f.migrations)) {
        problems.push(`v${r.minor}: recorded migrations (${f.tag}) differ from ${r.tag}`);
      }
    }
    for (const r of releases) {
      const newest = latestPerMinor(releases).find((x) => x.minor === r.minor);
      if (newest === undefined || newest.tag === r.tag) continue;
      const a = releasedMigrations(r.tag).map((m) => m.checksum);
      const b = releasedMigrations(newest.tag).map((m) => m.checksum);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        problems.push(
          `${newest.tag} changed the migrations of ${r.tag}: a patch release must not add migrations`,
        );
      }
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error('  Regenerate with `node scripts/gen-db-fixtures.ts` (needs the release tags).');
    return 1;
  }
  console.log(`✓ ${fixtures.length} database fixtures are up to date`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
