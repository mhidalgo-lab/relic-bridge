// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCliArgs, UsageError } from '../src/args.ts';
import { auditPurge, parseRetentionDays } from '../src/audit.ts';
import { ConfigError } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'rb-cli-audit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const DAY = 86_400_000;

describe('audit purge arguments', () => {
  it('parses audit purge with an optional --older-than-days', () => {
    expect(parseCliArgs(['audit', 'purge'])).toEqual({ command: 'audit', auditAction: 'purge' });
    expect(parseCliArgs(['audit', 'purge', '--older-than-days', '30', '--db', 'x.db'])).toEqual({
      command: 'audit',
      auditAction: 'purge',
      olderThanDays: '30',
      db: 'x.db',
    });
  });

  it('refuses other forms', () => {
    for (const argv of [
      ['audit'],
      ['audit', 'list'],
      ['audit', 'purge', 'x'],
      ['serve', '--older-than-days', '3'],
    ]) {
      expect(() => parseCliArgs(argv), argv.join(' ')).toThrow(UsageError);
    }
    expect(() => parseCliArgs(['audit', 'purge', '--older-than-days', '0'])).toThrow(UsageError);
    expect(() => parseCliArgs(['audit', 'purge', '--older-than-days', 'x'])).toThrow(UsageError);
  });
});

describe('retention days', () => {
  it('defaults to 90, accepts 0 (keep everything), refuses nonsense', () => {
    expect(parseRetentionDays(undefined)).toBe(90);
    expect(parseRetentionDays(' 30 ')).toBe(30);
    expect(parseRetentionDays('0')).toBe(0);
    expect(() => parseRetentionDays('-1')).toThrow(ConfigError);
  });
});

describe('audit purge', () => {
  async function seed(name: string) {
    const path = join(dir, name);
    const s = await openSqliteStorage({ path });
    const now = Date.now();
    await s.auditLog.append({ ts: now - 100 * DAY, kind: 'admin', action: 'old', status: 'ok' });
    await s.auditLog.append({ ts: now - 5 * DAY, kind: 'tool_call', action: 'whoami', status: 'ok' });
    await s.close();
    return path;
  }
  const run = async (path: string, over: { olderThanDays?: string; env?: Record<string, string> } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await auditPurge({
      dbPath: path,
      env: over.env ?? {},
      ...(over.olderThanDays === undefined ? {} : { olderThanDays: over.olderThanDays }),
      stdout: (t) => out.push(t),
      logger: createLogger({ level: 'debug', sink: (l) => err.push(l) }),
    });
    return { code, out: out.join(''), err: err.join('') };
  };
  const actions = async (path: string) => {
    const s = await openSqliteStorage({ path });
    const all = (await s.auditLog.list()).map((r) => r.action);
    await s.close();
    return all;
  };

  it('deletes rows past the default retention and records the purge itself', async () => {
    const path = await seed('default.db');
    const r = await run(path);
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toMatch(/Deleted 1 audit row\(s\) older than 90 day/);
    expect(await actions(path)).toEqual(['audit.purge', 'whoami']);
  });

  it('--older-than-days overrides the env; RB_AUDIT_RETENTION_DAYS=0 purges nothing', async () => {
    const path = await seed('override.db');
    expect((await run(path, { olderThanDays: '2' })).out).toMatch(/Deleted 2 audit/);
    const keep = await seed('keep.db');
    expect((await run(keep, { env: { RB_AUDIT_RETENTION_DAYS: '0' } })).out).toMatch(/nothing purged/);
    expect(await actions(keep)).toEqual(['whoami', 'old']);
  });

  it('exits 1 for a missing database', async () => {
    expect((await run(join(dir, 'missing.db'))).code).toBe(1);
  });
});
