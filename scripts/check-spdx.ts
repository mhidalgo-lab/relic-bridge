// SPDX-License-Identifier: Apache-2.0
// ADR-0003: every source file starts with an SPDX license header (shebang line allowed first).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HEADER = 'SPDX-License-Identifier: Apache-2.0';
const SOURCE_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

export function hasHeader(source: string): boolean {
  const lines = source.split('\n');
  const first = lines[0]?.startsWith('#!') ? lines[1] : lines[0];
  return first?.includes(HEADER) ?? false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // Tracked + untracked-but-not-ignored files, so the check works before the first commit too.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => SOURCE_RE.test(f));
  const missing = files.filter((f) => {
    try {
      return !hasHeader(readFileSync(`${root}/${f}`, 'utf8'));
    } catch {
      return false; // deleted in working tree
    }
  });
  for (const f of missing) console.error(`✗ ${f}: missing "// ${HEADER}" header`);
  process.exit(missing.length === 0 ? 0 : 1);
}
