// SPDX-License-Identifier: Apache-2.0
// P8-96 (ASVS V15.3.2): no outbound request follows a redirect. Product code reaches other servers only through
// `outboundFetch` / `noRedirects` (packages/core/src/outbound.ts) or a fetch a caller injected; source files must not
// call the global `fetch` themselves. Node's own HTTP client (`node:https`, used by the metadata-document guard) never
// follows redirects, and its test covers that.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { noRedirects, outboundFetch, outboundRedirectMode } from '../../packages/core/src/outbound.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The one place allowed to name the global `fetch`. */
const WRAPPER = 'packages/core/src/outbound.ts';

/** A direct use of the global fetch: a bare call, `globalThis.fetch`, or taking it as a value. */
const RAW_FETCH_RE = /(?<![\w.$'"`/-])fetch\s*\(|\bglobalThis\.fetch\b|[=(,]\s*fetch\s*[,);]|=\s*fetch\s*$/m;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'test' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name) && !name.endsWith('.generated.ts')) {
        out.push(path);
      }
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

/**
 * A file that declares its own binding called `fetch` (an injected `FetchLike` parameter, or a Worker's `fetch`
 * handler) calls that, not the global: only `globalThis.fetch` counts there.
 */
const LOCAL_FETCH_RE =
  /\b(?:const|let)\s+fetch\b|\bfetch\s*:\s*FetchLike|^\s*(?:async\s+)?fetch\s*\(\s*\w+\s*[:,)]/m;

function usesGlobalFetch(source: string): boolean {
  const text = code(source);
  return LOCAL_FETCH_RE.test(text) ? /\bglobalThis\.fetch\b/.test(text) : RAW_FETCH_RE.test(text);
}

/** Source without comments and string literals' contents, so prose about `fetch(` is not a call. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');
}

describe('outbound redirect policy (P8-96, V15.3.2)', () => {
  it('finds a raw fetch in a sample (the scanner works)', () => {
    expect(RAW_FETCH_RE.test('const r = await fetch(url, init);')).toBe(true);
    expect(RAW_FETCH_RE.test('const f = options.fetch ?? ((u, i) => globalThis.fetch(u, i));')).toBe(true);
    expect(RAW_FETCH_RE.test('function g(fetchImpl = fetch, x) {}')).toBe(true);
    expect(RAW_FETCH_RE.test('await host.fetch(url, init); app.fetch(req); handler.fetch(r)')).toBe(false);
  });

  it('no source file calls the global fetch outside the wrapper', () => {
    const offenders = sourceFiles()
      .filter((f) => f !== WRAPPER)
      .filter((f) => usesGlobalFetch(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the wrapper is the only place that names globalThis.fetch', () => {
    expect(code(readFileSync(join(ROOT, WRAPPER), 'utf8'))).toMatch(/globalThis\.fetch\(/);
  });

  it('the redirect mode is never follow', () => {
    expect(outboundRedirectMode(undefined)).toBe('manual');
    expect(outboundRedirectMode('follow')).toBe('manual');
    expect(outboundRedirectMode('manual')).toBe('manual');
    expect(outboundRedirectMode('error')).toBe('error');
  });

  it('noRedirects overrides a caller that asks to follow, and keeps everything else', async () => {
    const seen: RequestInit[] = [];
    const wrapped = noRedirects(async (_url, init) => {
      seen.push(init);
      return new Response('ok');
    });
    await wrapped('https://example.test/a', { method: 'POST', redirect: 'follow', headers: { 'x-a': '1' } });
    await wrapped('https://example.test/b', {});
    expect(seen[0]).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'x-a': '1' } });
    expect(seen[1]).toMatchObject({ redirect: 'manual' });
  });

  it('outboundFetch asks the platform fetch for manual redirects, and a 302 comes back unfollowed', async () => {
    const real = globalThis.fetch;
    const calls: Array<{ url: string; redirect: unknown }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, redirect: init?.redirect });
      return new Response(null, { status: 302, headers: { location: 'https://evil.test/' } });
    }) as typeof fetch;
    try {
      const res = await outboundFetch('https://api.example.test/x', { redirect: 'follow' });
      expect(res.status).toBe(302);
      expect(calls).toEqual([{ url: 'https://api.example.test/x', redirect: 'manual' }]);
    } finally {
      globalThis.fetch = real;
    }
  });
});
