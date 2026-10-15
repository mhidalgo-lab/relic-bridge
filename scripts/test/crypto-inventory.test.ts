// SPDX-License-Identifier: Apache-2.0
// P8-71: docs/security/cryptography.md stays complete. Every product or tooling source file that calls a cryptographic
// primitive or a random source must be listed there, and every algorithm name such a file spells out must be mentioned.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DOC = readFileSync(join(ROOT, 'docs/security/cryptography.md'), 'utf8');

/** Calls that make a file part of the inventory. */
const PRIMITIVE_RE =
  /\bcrypto\.subtle\b|\bgetRandomValues\b|\brandomUUID\b|\bMath\.random\b|\brandomBytes\b|\bcreateHash\b|\bcreateHmac\b|\bcreateCipheriv\b|\bpbkdf2\b|\bscrypt\b|\btimingSafeEqual\(|from 'jose'/;
/** Algorithm names as WebCrypto, jose and node:crypto spell them. */
const ALGORITHM_RE =
  /['"](AES-(?:GCM|KW|CBC|CTR)|HKDF|PBKDF2|HMAC|SHA-(?:1|256|384|512)|sha(?:1|256|384|512)|md5|RSA-OAEP|RSA-PSS|RSASSA-PKCS1-v1_5|ECDSA|ECDH|X25519|Ed25519|EdDSA|[RPE]S(?:256|384|512)|HS(?:256|384|512))['"]/g;

/** Product and tooling sources: `packages/*\/src`, `apps/*\/src` and top-level `scripts/*.ts` (tests excluded). */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'test' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(path);
    }
  };
  for (const group of ['packages', 'apps']) {
    for (const pkg of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, pkg, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // no src directory
      }
    }
  }
  for (const name of readdirSync(join(ROOT, 'scripts'))) {
    if (name.endsWith('.ts')) out.push(join(ROOT, 'scripts', name));
  }
  return out.map((p) => relative(ROOT, p).replaceAll('\\', '/')).sort();
}

/** What the inventory is missing for one file's source: the file itself, and algorithm names. */
function missingFromInventory(file: string, source: string, doc: string): string[] {
  if (!PRIMITIVE_RE.test(source)) return [];
  const missing: string[] = [];
  const plain = (text: string): string => text.toLowerCase().replaceAll('-', '');
  if (!doc.includes(`\`${file}\``)) missing.push(`file ${file}`);
  for (const m of source.matchAll(ALGORITHM_RE)) {
    const name = m[1] as string;
    if (!plain(doc).includes(plain(name))) missing.push(`algorithm ${name} (${file})`);
  }
  return missing;
}

describe('cryptographic inventory (P8-71)', () => {
  it('lists every file that uses a primitive and every algorithm it names', () => {
    const missing = sourceFiles().flatMap((file) =>
      missingFromInventory(file, readFileSync(join(ROOT, file), 'utf8'), DOC),
    );
    expect(missing).toEqual([]);
  });

  it('flags an unlisted file and an unmentioned algorithm', () => {
    const src = "await crypto.subtle.importKey('raw', k, { name: 'AES-CBC' }, false, ['encrypt']);";
    expect(missingFromInventory('packages/x/src/new.ts', src, 'nothing here')).toEqual([
      'file packages/x/src/new.ts',
      'algorithm AES-CBC (packages/x/src/new.ts)',
    ]);
    expect(
      missingFromInventory('packages/x/src/new.ts', src, '`packages/x/src/new.ts` uses AES-CBC'),
    ).toEqual([]);
  });

  it('ignores files without primitives', () => {
    expect(missingFromInventory('a.ts', "const s = 'SHA-256';", '')).toEqual([]);
  });
});
