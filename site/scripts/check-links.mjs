// SPDX-License-Identifier: Apache-2.0
// P8-04: verify the built site (site/dist). Every internal link, image and #anchor must resolve, and no page may load
// anything from another origin (no trackers, fonts or CDNs). External links are not fetched (flaky, non-blocking).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const BASE = (process.env.SITE_BASE ?? '/relic-bridge').replace(/\/+$/, '');

if (!existsSync(dist)) {
  console.error('site/dist not found: run `pnpm --filter relic-bridge-docs-site build` first');
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const htmlFiles = walk(dist).filter((f) => f.endsWith('.html'));
const idCache = new Map();
function idsOf(file) {
  if (!idCache.has(file)) {
    const html = readFileSync(file, 'utf8');
    idCache.set(file, new Set([...html.matchAll(/\s(?:id|name)="([^"]*)"/g)].map((m) => m[1])));
  }
  return idCache.get(file);
}

/** Map a URL path (base included) to a file in dist, or undefined. */
function fileFor(urlPath) {
  if (!urlPath.startsWith(`${BASE}/`) && urlPath !== BASE) return undefined;
  const rel = decodeURI(urlPath.slice(BASE.length)).replace(/^\/+/, '');
  const candidates = [join(dist, rel), join(dist, rel, 'index.html'), join(dist, `${rel}.html`)];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

const problems = [];
let checked = 0;
for (const file of htmlFiles) {
  const page = `/${file.slice(dist.length + 1)}`.replace(/index\.html$/, '');
  const html = readFileSync(file, 'utf8');
  const refs = [...html.matchAll(/\s(href|src|srcset|poster)="([^"]*)"/g)].flatMap((m) =>
    m[1] === 'srcset' ? m[2].split(',').map((s) => ['src', s.trim().split(/\s+/)[0]]) : [[m[1], m[2]]],
  );
  for (const [, raw] of refs) {
    const ref = raw.replaceAll('&amp;', '&');
    if (ref === '' || /^(mailto:|tel:|data:|javascript:)/i.test(ref)) continue;
    if (/^(https?:)?\/\//i.test(ref)) {
      // External: only anchors (<a href>) are allowed; anything loaded by the page itself is a violation.
      continue;
    }
    checked++;
    const url = new URL(ref, `https://x.invalid${BASE}${page.startsWith('/') ? page : `/${page}`}`);
    const target = fileFor(url.pathname);
    if (!target) {
      problems.push(`${page}: broken link ${raw}`);
      continue;
    }
    if (url.hash && url.hash.length > 1 && target.endsWith('.html')) {
      const id = decodeURIComponent(url.hash.slice(1));
      if (!idsOf(target).has(id)) problems.push(`${page}: missing anchor ${raw}`);
    }
  }
  // No third-party requests made by the page itself.
  const loads = [
    ...html.matchAll(/<(?:script|img|iframe|source|video|audio)\b[^>]*\ssrc="(https?:)?\/\/[^"]*"/gi),
    ...html.matchAll(/<link\b[^>]*\shref="(https?:)?\/\/[^"]*"[^>]*>/gi),
    ...html.matchAll(/url\(\s*['"]?(?:https?:)?\/\/[^)]*\)/gi),
    ...html.matchAll(/@import\s+(?:url\()?['"]?(?:https?:)?\/\//gi),
  ].filter((m) => !/rel="(canonical|alternate)"/i.test(m[0]));
  for (const m of loads) problems.push(`${page}: external resource ${m[0].slice(0, 120)}`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`x ${p}`);
  console.error(`${problems.length} problem(s) in ${htmlFiles.length} pages`);
  process.exit(1);
}
console.log(`ok: ${htmlFiles.length} pages, ${checked} internal references, no external loads`);
