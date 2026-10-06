// SPDX-License-Identifier: Apache-2.0
// `relic-bridge keychain set | delete | status` (P7-11). The value is read like any other secret (hidden prompt, stdin,
// `--key-file`, `--key-env`: never an argument) and handed to the OS tool on its stdin. Nothing ever prints it.
import { UsageError } from '../args.ts';
import { assertKeychainName, createKeychain, type Keychain } from '../keychain.ts';
import type { ManageArgs } from './args.ts';
import type { ManageContext } from './io.ts';
import { readNewRelicKey } from './secrets.ts';

export async function keychainCommand(ctx: ManageContext, args: ManageArgs): Promise<number> {
  const json = args.values.json === true;
  const keychain: Keychain = ctx.keychain ?? createKeychain({ platform: ctx.platform, env: ctx.env });
  const name = args.positionals[0];
  const out = (data: Record<string, unknown>, text: string): void =>
    ctx.stdout(json ? `${JSON.stringify({ data })}\n` : `${text}\n`);

  if (args.command === 'keychain status') {
    const problem = keychain.unavailable();
    out(
      {
        backend: keychain.backend,
        available: problem === undefined,
        ...(problem === undefined ? {} : { problem }),
      },
      problem === undefined
        ? `${keychain.backend}: available.`
        : `${keychain.backend}: not usable (${problem}).`,
    );
    return problem === undefined ? 0 : 1;
  }
  if (name === undefined) throw new UsageError(`${args.command} needs a name.`);
  assertKeychainName(name);
  if (args.command === 'keychain delete') {
    const removed = keychain.delete(name);
    out(
      { name, deleted: removed },
      removed ? `Deleted keychain entry ${name}.` : `No keychain entry ${name}.`,
    );
    return 0;
  }
  const secret = await readNewRelicKey(ctx, args.values, `Value for keychain entry ${name}`);
  keychain.set(name, secret);
  out({ name, backend: keychain.backend }, `Stored ${name} in the ${keychain.backend}.`);
  if (!json) {
    ctx.stderr(
      `Use it as \`apiKey: keychain:${name}\` in the YAML config, or set RB_MASTER_KEY_KEYCHAIN=${name} ` +
        '(a master key you store here is not recoverable from the database: keep a backup).',
    );
  }
  return 0;
}
