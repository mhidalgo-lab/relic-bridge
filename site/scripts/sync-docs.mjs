// SPDX-License-Identifier: Apache-2.0
// P8-04: copy the Markdown in ../docs into site/src/content/docs (git-ignored) so Starlight can render it, without
// moving or editing the sources. Adds the front matter Starlight needs (title from the first heading) and rewrites
// relative links: pages on the site become site routes, everything else becomes a GitHub URL. A relative link whose
// target does not exist is an error (that is the source-level broken-link check).
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(siteRoot, '..');
const docsRoot = join(repoRoot, 'docs');
const outRoot = join(siteRoot, 'src', 'content', 'docs');

export const REPO_URL = 'https://github.com/mhidalgo-lab/relic-bridge';
const BASE = (process.env.SITE_BASE ?? '/relic-bridge').replace(/\/+$/, '');

/** Docs-relative source to site route (no base, no trailing slash handling here). Everything else is not on the site. */
const FIXED = {
  'ARCHITECTURE.md': 'design/architecture',
  'THREAT_MODEL.md': 'design/threat-model',
  'RESEARCH.md': 'design/research',
  'adr/README.md': 'adr/index',
};
const DIRS = ['guide', 'reference', 'adr', 'dev'];
const EXCLUDED = new Set(['dev/releasing.md']);

function listMarkdown(dir) {
  return readdirSync(join(docsRoot, dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `${dir}/${f}`);
}

const sources = [...Object.keys(FIXED), ...DIRS.flatMap(listMarkdown)].filter((s) => !EXCLUDED.has(s));
const routeOf = new Map();
for (const s of sources) routeOf.set(s, FIXED[s] ?? s.replace(/\.md$/, ''));

/** Route for a docs-relative path or directory, or undefined when it is not a site page. */
function siteRoute(docPath) {
  if (routeOf.has(docPath)) return routeOf.get(docPath);
  const asDir = docPath.replace(/\/$/, '');
  if (asDir === 'adr') return 'adr/index';
  return undefined;
}

const errors = [];

function githubUrl(repoPath, isDir) {
  return `${REPO_URL}/${isDir ? 'tree' : 'blob'}/main/${repoPath}`;
}

function rewriteHref(href, sourceRel) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
  const [pathPart, hash = ''] = href.split(/(?=#)/);
  if (pathPart === '') return href;
  const abs = resolve(docsRoot, dirname(sourceRel), decodeURI(pathPart));
  const repoRel = relative(repoRoot, abs).split(sep).join('/');
  if (repoRel.startsWith('..')) {
    errors.push(`${sourceRel}: link escapes the repository: ${href}`);
    return href;
  }
  if (!existsSync(abs)) {
    errors.push(`${sourceRel}: broken link ${href} (no such file: ${repoRel})`);
    return href;
  }
  const docRel = relative(docsRoot, abs).split(sep).join('/');
  if (!docRel.startsWith('..')) {
    if (/\.(png|jpe?g|gif|svg|webp)$/i.test(docRel)) return href; // images are copied next to the page
    const route = siteRoute(docRel);
    if (route) return `${BASE}/${route.replace(/\/index$/, '')}/${hash}`;
  }
  return `${githubUrl(repoRel, statSync(abs).isDirectory())}${hash}`;
}

/** Rewrite links outside fenced code blocks. */
function rewriteLinks(body, sourceRel) {
  let inFence = false;
  return body
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line
        .replace(
          /(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g,
          (_m, a, href, c) => `${a}${rewriteHref(href, sourceRel)}${c}`,
        )
        .replace(/^(\[[^\]]+\]:\s+)(\S+)/, (_m, a, href) => `${a}${rewriteHref(href, sourceRel)}`);
    })
    .join('\n');
}

function transform(sourceRel) {
  const raw = readFileSync(join(docsRoot, sourceRel), 'utf8');
  const lines = raw.split('\n');
  const h1 = lines.findIndex((l) => /^# /.test(l));
  if (h1 === -1) throw new Error(`${sourceRel}: no top-level heading`);
  const title = lines[h1].slice(2).trim().replace(/\\/g, '');
  lines.splice(h1, 1);
  const body = rewriteLinks(lines.join('\n'), sourceRel);
  const front = `---\ntitle: ${JSON.stringify(title)}\neditUrl: ${JSON.stringify(githubUrl(`docs/${sourceRel}`, false).replace('/blob/', '/edit/'))}\n---\n\n`;
  return front + body;
}

// Clean only the generated folders; index.mdx (and anything else committed) stays.
for (const d of ['guide', 'reference', 'adr', 'dev', 'design']) {
  rmSync(join(outRoot, d), { recursive: true, force: true });
}

for (const s of sources) {
  const target = join(outRoot, `${routeOf.get(s)}.md`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, transform(s));
}
cpSync(join(docsRoot, 'guide', 'images'), join(outRoot, 'guide', 'images'), { recursive: true });

if (errors.length > 0) {
  for (const e of errors) console.error(`x ${e}`);
  console.error(`${errors.length} broken link(s) in docs/`);
  process.exit(1);
}
console.log(`synced ${sources.length} pages from docs/ (base "${BASE}")`);
