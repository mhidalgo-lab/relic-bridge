// SPDX-License-Identifier: Apache-2.0
import type { ConfigFs } from '../src/config.ts';

/** Shaped like a real User key so redaction is exercised; obviously fake. */
export const FAKE_KEY = 'NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0';
export const OTHER_KEY = 'NRAK-FAKEOTHERKEY0123456789ABCD';

/** In-memory files for the YAML loader. */
export function memoryFs(files: Record<string, { text: string; mode?: number }>): ConfigFs {
  return {
    stat(path) {
      const f = files[path];
      if (!f) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return { size: Buffer.byteLength(f.text), mode: f.mode ?? 0o100600, isFile: () => true };
    },
    readFile(path) {
      const f = files[path];
      if (!f) throw new Error(`ENOENT: ${path}`);
      return f.text;
    },
  };
}

/** NerdGraph body for the Identity query used by whoami / list_accounts. */
export function identityBody(accounts: { id: number; name: string }[]): unknown {
  return {
    data: {
      actor: {
        user: { id: 7, name: 'Jane', email: 'jane.doe@example.com' },
        accounts,
      },
    },
  };
}
