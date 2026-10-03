// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  generateSecrets,
  LOCAL_CONFIG,
  localConfigFor,
  localConfigName,
  parseArgs,
  rateLimitNamespace,
  runSetup,
  type SetupDeps,
  SetupError,
  type SetupOptions,
  type WranglerResult,
} from '../cloudflare-setup.ts';

const OPTS: SetupOptions = {
  name: 'relic-bridge',
  plan: 'free',
  passthrough: false,
  dryRun: false,
  assumeNew: false,
  backupFile: undefined,
  signIn: false,
  publicUrl: undefined,
  replaceMasterKey: false,
};

interface Call {
  args: readonly string[];
  input: string | undefined;
}

const COMMITTED =
  '{ "name": "relic-bridge", "d1_databases": [{ "binding": "DB", "database_name": "relic-bridge" }], ' +
  '"ratelimits": [{ "name": "RATE_LIMITER", "namespace_id": "1701" }] }';

function harness(
  replies: (args: readonly string[]) => Partial<WranglerResult>,
  existingConfig = false,
  existing: readonly string[] = [],
  localContent?: string,
) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const revealed: string[] = [];
  const files = new Map<string, { content: string; mode: number }>();
  const copies: string[][] = [];
  let counter = 0;
  const deps: SetupDeps = {
    wrangler: async (args, input) => {
      calls.push({ args, input });
      return { code: 0, stdout: '', stderr: '', ...replies(args) };
    },
    random: (n) => new Uint8Array(n).fill(++counter),
    log: (l) => logs.push(l),
    reveal: (l) => revealed.push(l),
    workerDir: '/w',
    repoRoot: '/repo',
    fs: {
      exists: (p) => (p.endsWith('.jsonc') ? existingConfig : existing.includes(p) || files.has(p)),
      read: (p) => {
        if (p === '/w/wrangler.jsonc') return COMMITTED;
        if (p.endsWith('.local.jsonc') && localContent !== undefined) return localContent;
        throw new Error(`unexpected read ${p}`);
      },
      writeNew: (p, content, mode) => {
        if (files.has(p) || existing.includes(p)) throw new Error('EEXIST');
        if (p.endsWith('.jsonc')) copies.push([p, content]);
        else files.set(p, { content, mode });
      },
    },
  };
  return { deps, calls, logs, revealed, files, copies };
}

const ok = (args: readonly string[]): Partial<WranglerResult> => {
  if (args[0] === 'secret' && args[1] === 'list')
    return { code: 1, stderr: 'A request failed [code: 10007]' };
  if (args[0] === 'deploy')
    return { stdout: 'Deployed relic-bridge\n  https://relic-bridge.acme.workers.dev\n' };
  return {};
};

describe('parseArgs', () => {
  it('has safe defaults and validates', () => {
    expect(parseArgs([])).toEqual(OPTS);
    expect(parseArgs(['--plan', 'paid', '--passthrough', '--name', 'rb-2'])).toMatchObject({
      plan: 'paid',
      passthrough: true,
      name: 'rb-2',
    });
    expect(parseArgs(['-h'])).toBe('help');
    expect(() => parseArgs(['--plan', 'gold'])).toThrow(SetupError);
    expect(() => parseArgs(['--name', 'Bad_Name'])).toThrow(SetupError);
    expect(() => parseArgs(['--name'])).toThrow(SetupError);
    expect(() => parseArgs(['--master-key', 'x'])).toThrow(SetupError);
  });
});

describe('generateSecrets', () => {
  it('formats a v1 master key, a base64url admin token and a base64 fingerprint secret', () => {
    const s = generateSecrets(['RB_MASTER_KEY', 'RB_ADMIN_TOKEN', 'RB_FINGERPRINT_SECRET'], (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    );
    expect(s['RB_MASTER_KEY']).toMatch(/^v1:[A-Za-z0-9+/]{43}=$/);
    expect(s['RB_ADMIN_TOKEN']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s['RB_FINGERPRINT_SECRET']).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});

describe('runSetup', () => {
  it('dry run calls nothing', async () => {
    const h = harness(ok);
    await runSetup({ ...OPTS, dryRun: true }, h.deps);
    expect(h.calls).toEqual([]);
    expect(h.copies).toEqual([]);
    expect(h.revealed).toEqual([]);
  });

  it('sets secrets on stdin only, deploys with the local config and prints the url', async () => {
    const h = harness(ok);
    const r = await runSetup({ ...OPTS, plan: 'paid' }, h.deps);
    expect(r.url).toBe('https://relic-bridge.acme.workers.dev');
    expect(h.copies).toEqual([[`/w/${LOCAL_CONFIG}`, COMMITTED]]);
    const bulk = h.calls.find((c) => c.args[1] === 'bulk');
    expect(Object.keys(JSON.parse(bulk?.input ?? '{}'))).toEqual(['RB_MASTER_KEY', 'RB_ADMIN_TOKEN']);
    const values = Object.values(JSON.parse(bulk?.input ?? '{}') as Record<string, string>);
    // No secret value ever appears in an argument list or a log line.
    for (const c of h.calls) for (const v of values) expect(c.args.join(' ')).not.toContain(v);
    for (const v of values) expect(h.logs.join('\n')).not.toContain(v);
    // They are revealed once, on the dedicated channel.
    for (const v of values) expect(h.revealed.join('\n')).toContain(v);
    const deploy = h.calls.find((c) => c.args[0] === 'deploy');
    expect(deploy?.args).toEqual(
      expect.arrayContaining(['-c', `/w/${LOCAL_CONFIG}`, '--var', 'RB_PLAN:paid']),
    );
    // Dashboard variables (RB_ALLOWED_HOSTS, RB_AUDIT_*, …) survive a re-run (phase-3 review).
    expect(deploy?.args).toContain('--keep-vars');
    // order: secrets before deploy (secrets.required is validated at deploy)
    expect(h.calls.findIndex((c) => c.args[1] === 'bulk')).toBeLessThan(
      h.calls.findIndex((c) => c.args[0] === 'deploy'),
    );
    expect(h.logs.join('\n')).toContain('RB_REMOTE=https://relic-bridge.acme.workers.dev');
  });

  it('adds the fingerprint secret and RB_PASSTHROUGH with --passthrough', async () => {
    const h = harness(ok);
    await runSetup({ ...OPTS, passthrough: true }, h.deps);
    const bulk = h.calls.find((c) => c.args[1] === 'bulk');
    expect(Object.keys(JSON.parse(bulk?.input ?? '{}'))).toContain('RB_FINGERPRINT_SECRET');
    expect(h.calls.find((c) => c.args[0] === 'deploy')?.args).toContain('RB_PASSTHROUGH:on');
  });

  it('never regenerates a secret that exists (a new master key would orphan stored credentials)', async () => {
    const h = harness((a) =>
      a[1] === 'list' ? { stdout: JSON.stringify([{ name: 'RB_MASTER_KEY', type: 'secret_text' }]) } : ok(a),
    );
    await runSetup(OPTS, h.deps);
    const bulk = h.calls.find((c) => c.args[1] === 'bulk');
    expect(Object.keys(JSON.parse(bulk?.input ?? '{}'))).toEqual(['RB_ADMIN_TOKEN']);
    expect(h.revealed.join('\n')).not.toContain('RB_MASTER_KEY=');
  });

  it('skips the bulk call and the reveal when every secret exists', async () => {
    const h = harness((a) =>
      a[1] === 'list'
        ? { stdout: JSON.stringify([{ name: 'RB_MASTER_KEY' }, { name: 'RB_ADMIN_TOKEN' }]) }
        : ok(a),
    );
    await runSetup(OPTS, h.deps);
    expect(h.calls.some((c) => c.args[1] === 'bulk')).toBe(false);
    expect(h.revealed).toEqual([]);
  });

  it('refuses to generate secrets when the secret list fails for another reason', async () => {
    const h = harness((a) => (a[1] === 'list' ? { code: 1, stderr: 'fetch failed' } : ok(a)));
    await expect(runSetup(OPTS, h.deps)).rejects.toThrow(/Refusing to continue/);
    expect(h.calls.some((c) => c.args[1] === 'bulk')).toBe(false);
    // ...unless the owner says the Worker is new.
    const h2 = harness((a) => (a[1] === 'list' ? { code: 1, stderr: 'fetch failed' } : ok(a)));
    await runSetup({ ...OPTS, assumeNew: true }, h2.deps);
    expect(h2.calls.some((c) => c.args[1] === 'bulk')).toBe(true);
  });

  it('stops when not logged in, and does not deploy when secrets fail', async () => {
    const h = harness((a) => (a[0] === 'whoami' ? { stdout: 'You are not authenticated.' } : ok(a)));
    await expect(runSetup(OPTS, h.deps)).rejects.toThrow(/not logged in/);
    const h2 = harness((a) => (a[1] === 'bulk' ? { code: 1, stderr: 'boom' } : ok(a)));
    await expect(runSetup(OPTS, h2.deps)).rejects.toThrow(/secret bulk failed/);
    expect(h2.calls.some((c) => c.args[0] === 'deploy')).toBe(false);
  });

  it('writes the backup file 0600 only when asked, and never over an existing file', async () => {
    const h = harness(ok);
    await runSetup({ ...OPTS, backupFile: '/tmp/rb.env' }, h.deps);
    const f = h.files.get('/tmp/rb.env');
    expect(f?.mode).toBe(0o600);
    expect(f?.content).toMatch(/^RB_MASTER_KEY=v1:/);
    const none = harness(ok);
    await runSetup(OPTS, none.deps);
    expect(none.files.size).toBe(0);
  });

  it('does not copy the config again on a re-run, and stays quiet when only provisioned ids differ', async () => {
    const withIds = COMMITTED.replace('"binding": "DB",', '"binding": "DB", "database_id": "abc-123",');
    const h = harness(ok, true, [], withIds);
    await runSetup(OPTS, h.deps);
    expect(h.copies).toEqual([]);
    expect(h.logs.join('\n')).not.toContain('differs from wrangler.jsonc');
  });

  it('warns on a re-run when wrangler.jsonc gained something the local copy lacks, without overwriting it', async () => {
    const old = COMMITTED.replace(', "ratelimits"', ', "x": 1, "ratelimits"').replace('"x": 1, ', '');
    const stale = old.replace(/, "ratelimits".*\}$/, ' }');
    const h = harness(ok, true, [], stale);
    await runSetup(OPTS, h.deps);
    expect(h.logs.join('\n')).toMatch(/wrangler\.local\.jsonc differs from wrangler\.jsonc/);
    expect(h.copies).toEqual([]);
    expect(h.calls.some((c) => c.args[0] === 'deploy')).toBe(true);
  });

  it('gives each Worker name its own rate-limit namespace', () => {
    expect(rateLimitNamespace('relic-bridge')).toBe('1701');
    const a = rateLimitNamespace('rb-staging');
    expect(a).toMatch(/^\d+$/);
    expect(a).not.toBe('1701');
    expect(a).not.toBe(rateLimitNamespace('rb-dev'));
    expect(localConfigFor(COMMITTED, 'rb-staging')).toContain(`"namespace_id": "${a}"`);
    expect(() => localConfigFor('{ "d1_databases": [{ "database_name": "relic-bridge" }] }', 'x')).toThrow(
      SetupError,
    );
  });

  it('warns when the backup file is inside the repository, not when it is outside', async () => {
    const inside = harness(ok);
    await runSetup({ ...OPTS, backupFile: '/repo/secrets.txt' }, inside.deps);
    expect(inside.logs.join('\n')).toMatch(/inside the repository/);
    const outside = harness(ok);
    await runSetup({ ...OPTS, backupFile: '/home/me/rb.env' }, outside.deps);
    expect(outside.logs.join('\n')).not.toMatch(/inside the repository/);
  });

  it('refuses a new master key next to an existing admin token unless --replace-master-key', async () => {
    const list = (a: readonly string[]) =>
      a[1] === 'list' ? { stdout: JSON.stringify([{ name: 'RB_ADMIN_TOKEN' }]) } : ok(a);
    const h = harness(list);
    await expect(runSetup(OPTS, h.deps)).rejects.toThrow(/undecryptable/);
    expect(h.calls.some((c) => c.args[1] === 'bulk')).toBe(false);
    expect(h.calls.some((c) => c.args[0] === 'deploy')).toBe(false);
    const forced = harness(list);
    await runSetup({ ...OPTS, replaceMasterKey: true }, forced.deps);
    const bulk = forced.calls.find((c) => c.args[1] === 'bulk');
    expect(Object.keys(JSON.parse(bulk?.input ?? '{}'))).toEqual(['RB_MASTER_KEY']);
    expect(forced.logs.join('\n')).toMatch(/WARNING: --replace-master-key/);
  });

  it('refuses --assume-new when the Worker already has secrets', async () => {
    const h = harness((a) =>
      a[1] === 'list' ? { stdout: JSON.stringify([{ name: 'RB_MASTER_KEY' }]) } : ok(a),
    );
    await expect(runSetup({ ...OPTS, assumeNew: true }, h.deps)).rejects.toThrow(/already exists/);
    expect(h.calls.some((c) => c.args[1] === 'bulk')).toBe(false);
  });

  it('dry run describes the re-run checks', async () => {
    const h = harness(ok);
    await runSetup({ ...OPTS, dryRun: true, name: 'rb-2' }, h.deps);
    const out = h.logs.join('\n');
    expect(out).toMatch(/rate-limit namespace/);
    expect(out).toMatch(/--replace-master-key/);
    expect(out).toMatch(/wrangler\.jsonc changed/);
  });

  it('gives another Worker name its own local config and D1 database (no binding to the first one)', async () => {
    expect(localConfigName('relic-bridge')).toBe(LOCAL_CONFIG);
    expect(localConfigName('rb-staging')).toBe('wrangler.rb-staging.local.jsonc');
    expect(localConfigFor(COMMITTED, 'rb-staging')).toContain('"database_name": "rb-staging"');
    const h = harness(ok);
    await runSetup({ ...OPTS, name: 'rb-staging' }, h.deps);
    expect(h.copies).toEqual([
      ['/w/wrangler.rb-staging.local.jsonc', localConfigFor(COMMITTED, 'rb-staging')],
    ]);
    for (const c of h.calls.filter((x) => x.args[0] !== 'whoami')) {
      expect(c.args).toEqual(expect.arrayContaining(['-c', '/w/wrangler.rb-staging.local.jsonc']));
    }
  });

  it('refuses an existing backup file before generating anything', async () => {
    const h = harness(ok, false, ['/tmp/rb.env']);
    await expect(runSetup({ ...OPTS, backupFile: '/tmp/rb.env' }, h.deps)).rejects.toThrow(/already exists/);
    expect(h.calls.some((c) => c.args[1] === 'bulk')).toBe(false);
  });

  it('still reveals and deploys when the backup write fails after the secrets are set', async () => {
    const h = harness(ok);
    h.deps.fs.writeNew = (p, content, mode) => {
      if (!p.endsWith('.jsonc')) throw new Error('EACCES');
      h.copies.push([p, content, String(mode)]);
    };
    await runSetup({ ...OPTS, backupFile: '/ro/rb.env' }, h.deps);
    expect(h.revealed.join('\n')).toMatch(/RB_MASTER_KEY=v1:/);
    expect(h.logs.join('\n')).toMatch(/could not write/);
    expect(h.calls.some((c) => c.args[0] === 'deploy')).toBe(true);
  });

  describe('--sign-in (P4-09)', () => {
    const SECRET = 'GOCSPX-super-secret-value';
    const base: SetupOptions = { ...OPTS, signIn: true };

    it('parses the flags', () => {
      expect(parseArgs(['--sign-in', '--public-url', 'https://rb.example.com'])).toMatchObject({
        signIn: true,
        publicUrl: 'https://rb.example.com',
      });
      expect(() => parseArgs(['--google-client-secret', 'x'])).toThrow(SetupError);
    });

    it('prompts, sends client secrets on stdin only and ids as --var', async () => {
      const h = harness(ok);
      const answers = ['https://rb.example.com', 'google-id.apps.example', '', ''];
      const asked: string[] = [];
      const deps: SetupDeps = {
        ...h.deps,
        env: {},
        prompt: async (q) => {
          asked.push(q);
          return answers.shift() ?? '';
        },
        promptSecret: async (q) => {
          asked.push(q);
          return SECRET;
        },
      };
      await runSetup(base, deps);
      const bulk = h.calls.find((c) => c.args[1] === 'bulk');
      const sent = JSON.parse(bulk?.input ?? '{}') as Record<string, string>;
      expect(sent['RB_GOOGLE_CLIENT_SECRET']).toBe(SECRET);
      expect(Object.keys(sent)).toEqual(['RB_MASTER_KEY', 'RB_ADMIN_TOKEN', 'RB_GOOGLE_CLIENT_SECRET']);
      const deploy = h.calls.find((c) => c.args[0] === 'deploy');
      expect(deploy?.args).toEqual(
        expect.arrayContaining([
          '--var',
          'RB_PUBLIC_URL:https://rb.example.com',
          'RB_GOOGLE_CLIENT_ID:google-id.apps.example',
        ]),
      );
      // The secret is in no argument, no log line, no revealed line and no file written.
      for (const c of h.calls) expect(c.args.join(' ')).not.toContain(SECRET);
      expect(h.logs.join('\n')).not.toContain(SECRET);
      expect(h.revealed.join('\n')).not.toContain(SECRET);
      expect(h.logs.join('\n')).toContain('RB_GOOGLE_CLIENT_SECRET');
      for (const [, content] of h.copies) expect(content).not.toContain(SECRET);
      expect(h.logs.join('\n')).toContain('https://rb.example.com/auth/callback/google');
      expect(asked.some((q) => q.includes('Public URL'))).toBe(true);
    });

    it('works without a terminal from the environment', async () => {
      const h = harness(ok);
      await runSetup(
        { ...base, publicUrl: 'https://rb.example.com' },
        {
          ...h.deps,
          env: { RB_GITHUB_CLIENT_ID: 'gh-id', RB_GITHUB_CLIENT_SECRET: SECRET },
        },
      );
      const bulk = h.calls.find((c) => c.args[1] === 'bulk');
      expect(JSON.parse(bulk?.input ?? '{}')).toMatchObject({ RB_GITHUB_CLIENT_SECRET: SECRET });
      expect(h.calls.find((c) => c.args[0] === 'deploy')?.args).toContain('RB_GITHUB_CLIENT_ID:gh-id');
    });

    it('keeps a stored client secret when none is given now, and asks nothing in a dry run', async () => {
      const kept = harness((args) =>
        args[0] === 'secret' && args[1] === 'list'
          ? {
              stdout: JSON.stringify(
                ['RB_MASTER_KEY', 'RB_ADMIN_TOKEN', 'RB_GITHUB_CLIENT_SECRET'].map((name) => ({ name })),
              ),
            }
          : ok(args),
      );
      await runSetup(
        { ...base, publicUrl: 'https://rb.example.com' },
        { ...kept.deps, env: { RB_GITHUB_CLIENT_ID: 'gh-id' } },
      );
      expect(kept.calls.some((c) => c.args[1] === 'bulk')).toBe(false);
      const dry = harness(ok);
      const prompt = async (): Promise<string> => {
        throw new Error('must not ask');
      };
      await runSetup({ ...base, dryRun: true }, { ...dry.deps, prompt, promptSecret: prompt });
      expect(dry.calls).toEqual([]);
    });

    it('refuses bad answers before anything is sent', async () => {
      for (const [publicUrl, env] of [
        ['http://rb.example.com', { RB_GITHUB_CLIENT_ID: 'x', RB_GITHUB_CLIENT_SECRET: 's' }],
        ['https://rb.example.com/path', { RB_GITHUB_CLIENT_ID: 'x', RB_GITHUB_CLIENT_SECRET: 's' }],
        ['https://rb.example.com', {}],
        ['https://rb.example.com', { RB_GITHUB_CLIENT_ID: 'x' }],
        ['https://rb.example.com', { RB_OIDC_CLIENT_ID: 'x', RB_OIDC_CLIENT_SECRET: 's' }],
      ] as const) {
        const h = harness(ok);
        await expect(runSetup({ ...base, publicUrl }, { ...h.deps, env })).rejects.toThrow(SetupError);
        expect(h.calls.some((c) => c.args[1] === 'bulk' || c.args[0] === 'deploy')).toBe(false);
      }
    });
  });
});
