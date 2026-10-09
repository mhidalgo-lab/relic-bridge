// SPDX-License-Identifier: Apache-2.0
// `relic-bridge keys rotate --remote <url>` (P3-11): master-key rotation on a server the CLI cannot open directly (a
// Worker on D1, or `serve` elsewhere). The server holds both keys and re-encrypts one bounded batch per
// `POST /api/admin/v1/keys/rotate`; this loops until every row was visited. No key material is sent or received.
import { redact } from '@relic-bridge/core';
import { UsageError } from '../args.ts';
import { ConfigError } from '../config.ts';
import { intOption } from './args.ts';
import { ApiError, api } from './client.ts';
import { type Rec, type Run, rec, str } from './commands.ts';

/** Upper bound on calls (100 rows each at most: a million rows); a server that never finishes can't loop forever. */
const MAX_CALLS = 10_000;
/** `429` answers in a row before giving up, and the pause between them. */
const MAX_RATE_LIMITED = 6;
const RATE_LIMIT_PAUSE_MS = 10_000;

const HINTS: Readonly<Record<string, string>> = {
  key_version_unknown:
    'its key version is not loaded on the server: set RB_MASTER_KEY_PREVIOUS to the key it was encrypted with',
  decrypt_failed:
    'the stored row does not decrypt (damaged or tampered): replace the key with `credential rotate`',
  conflict: 'it changed while rotating: run keys rotate again',
};

export async function keysRotateRemote(run: Run): Promise<number> {
  const { ctx, client, args, json } = run;
  if (client.mode !== 'remote') {
    throw new UsageError(
      'keys rotate --remote needs a server URL; without --remote it rotates a local database.',
    );
  }
  const batchSize = intOption('batch-size', args.values['batch-size'], 1, 100);
  let after: string | null = null;
  let reencrypted = 0;
  const failed = new Map<string, string>();
  let last: Rec = {};
  let rateLimited = 0;
  let calls = 0;
  for (;;) {
    if (calls >= MAX_CALLS)
      throw new ConfigError('The server did not finish the rotation; run keys rotate again.');
    let body: Rec;
    try {
      body = rec(
        await api(client, 'POST', '/keys/rotate', {
          body: { ...(batchSize === undefined ? {} : { batchSize }), ...(after === null ? {} : { after }) },
        }),
      );
    } catch (error) {
      // Refused before any work was done: safe to send the same batch again.
      if (error instanceof ApiError && error.status === 429 && rateLimited < MAX_RATE_LIMITED) {
        rateLimited++;
        if (!json) ctx.stderr(`rate limited; retrying in ${RATE_LIMIT_PAUSE_MS / 1000} s`);
        await ctx.host.sleep(RATE_LIMIT_PAUSE_MS);
        if (ctx.host.signal?.aborted === true) return 1;
        continue;
      }
      throw error;
    }
    rateLimited = 0;
    calls++;
    const data = rec(body['data']);
    last = data;
    if (json) ctx.stdout(`${JSON.stringify(body)}\n`);
    const done = Array.isArray(data['reencrypted']) ? data['reencrypted'].length : 0;
    reencrypted += done;
    for (const f of Array.isArray(data['failed']) ? data['failed'] : []) {
      const row = rec(f);
      failed.set(str(row['id']), str(row['code']));
    }
    if (!json) {
      ctx.stderr(
        `batch ${calls}: ${done} re-encrypted, ${Number(data['pending'] ?? 0)} of ${Number(data['total'] ?? 0)} ` +
          'not yet on the current version',
      );
    }
    const next = data['nextCursor'];
    if (typeof next !== 'string') break;
    // The cursor must move forward, or the server is not making progress.
    if (after !== null && next <= after) {
      throw new ConfigError('The server answered a cursor that does not advance; run keys rotate again.');
    }
    after = next;
  }

  const current = Number(last['currentVersion'] ?? 0);
  const pending = Number(last['pending'] ?? 0);
  const inUse = Array.isArray(last['versionsInUse']) ? last['versionsInUse'].map(Number) : [];
  const complete = pending === 0 && failed.size === 0;
  if (json) return complete ? 0 : 1;
  for (const [id, code] of failed) {
    ctx.stderr(
      `warning: credential ${redact(id).slice(0, 64)} not rotated (${redact(code).slice(0, 40)}): ${HINTS[code] ?? 'see the server log'}`,
    );
  }
  ctx.stdout(
    [
      `Master key version ${current}: ${reencrypted} re-encrypted in ${calls} call${calls === 1 ? '' : 's'}, ` +
        `${failed.size} failed, ${pending} not on version ${current}.`,
      complete
        ? `Every credential uses version ${current}. Remove RB_MASTER_KEY_PREVIOUS from the server (keep a backup ` +
          'of it until the server has started without it).'
        : `Versions still in use: ${inUse.join(', ')}. Keep RB_MASTER_KEY_PREVIOUS on the server, fix the rows ` +
          'reported above, and run keys rotate --remote again.',
      '',
    ].join('\n'),
  );
  return complete ? 0 : 1;
}
