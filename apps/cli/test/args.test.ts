// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseCliArgs, UsageError } from '../src/args.ts';
import { FAKE_KEY } from './helpers.ts';

describe('parseCliArgs', () => {
  it('defaults to stdio', () => {
    expect(parseCliArgs([])).toEqual({ command: 'stdio' });
    expect(parseCliArgs(['stdio'])).toEqual({ command: 'stdio' });
  });

  it('reads config, project and log level', () => {
    expect(parseCliArgs(['--config', '/etc/rb.yaml', '--project', 'acme', '--log-level', 'debug'])).toEqual({
      command: 'stdio',
      config: '/etc/rb.yaml',
      project: 'acme',
      logLevel: 'debug',
    });
    expect(parseCliArgs(['stdio', '--config=/x.yaml'])).toMatchObject({ config: '/x.yaml' });
  });

  it('handles help and version in every spelling', () => {
    for (const a of [['help'], ['--help'], ['-h'], ['stdio', '--help']]) {
      expect(parseCliArgs(a).command).toBe('help');
    }
    for (const a of [['version'], ['--version'], ['-v']]) expect(parseCliArgs(a).command).toBe('version');
  });

  it('refuses unknown options without echoing a key typed into them (T8, T23)', () => {
    let error: unknown;
    try {
      parseCliArgs([`--api-key=${FAKE_KEY}`]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).not.toContain(FAKE_KEY);
    expect(() => parseCliArgs([FAKE_KEY])).toThrow(UsageError);
    try {
      parseCliArgs([FAKE_KEY]);
    } catch (e) {
      expect((e as Error).message).not.toContain(FAKE_KEY);
    }
  });

  it('refuses bad values and extra commands', () => {
    expect(() => parseCliArgs(['--log-level', 'trace'])).toThrow(/log-level/);
    expect(() => parseCliArgs(['stdio', 'serve'])).toThrow(/at most one command/);
    expect(() => parseCliArgs(['serve'])).toThrow(/Unknown command/);
    expect(() => parseCliArgs(['--config', ' '])).toThrow(/file path/);
    expect(() => parseCliArgs(['--project', ''])).toThrow(/slug/);
    expect(() => parseCliArgs(['--config'])).toThrow(UsageError);
  });

  it('parses db backup', () => {
    expect(parseCliArgs(['db', 'backup', 'out.db', '--db', 'x.db'])).toEqual({
      command: 'db',
      dbAction: 'backup',
      file: 'out.db',
      db: 'x.db',
    });
    expect(parseCliArgs(['db', '--help'])).toEqual({ command: 'help' });
    expect(() => parseCliArgs(['db'])).toThrow(/db backup/);
    expect(() => parseCliArgs(['db', 'restore', 'x'])).toThrow(/db backup/);
    expect(() => parseCliArgs(['db', 'backup'])).toThrow(/one destination/);
    expect(() => parseCliArgs(['db', 'backup', 'a', 'b'])).toThrow(/one destination/);
    expect(() => parseCliArgs(['db', 'backup', 'a', '--db', ' '])).toThrow(/--db/);
  });

  it('help text documents the env block and never suggests key flags', () => {
    expect(HELP_TEXT).toContain('NEW_RELIC_API_KEY');
    expect(HELP_TEXT).toContain('"env" block');
    expect(HELP_TEXT).not.toMatch(/--api-key|--key/);
  });
});
