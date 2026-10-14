// SPDX-License-Identifier: Apache-2.0
// P8-04: Starlight docs site. Search is Starlight's built-in Pagefind (static, no third-party service). No analytics,
// no external fonts or CDNs: Starlight's default system font stack, nothing else is loaded.

import { readdirSync } from 'node:fs';
import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';

const guideGroups = [
  ['Get started', ['quickstart-local', 'clients', 'configuration', 'troubleshooting']],
  [
    'Run a server',
    [
      'self-hosting',
      'cloudflare-deploy',
      'cloudflare-limits',
      'admin-guide',
      'multi-device',
      'migrating-config',
    ],
  ],
  [
    'Access and security',
    [
      'security-basics',
      'access-model',
      'secrets',
      'identity-providers',
      'admin-access',
      'admin-panel',
      'audit-log',
      'verify-release',
    ],
  ],
  ['OAuth and phones', ['oauth', 'oauth-phone', 'oauth-how-it-works']],
  [
    'Features',
    [
      'query-limits',
      'query-cache',
      'output-formats',
      'charts',
      'observability',
      'claude-code-plugin',
      'registry-listing',
    ],
  ],
];

const known = new Set(guideGroups.flatMap(([, slugs]) => slugs));
const other = readdirSync(new URL('../docs/guide', import.meta.url))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .filter((s) => !known.has(s));
if (other.length > 0) guideGroups.push(['More guides', other]);

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://mhidalgo-lab.github.io',
  base: process.env.SITE_BASE ?? '/relic-bridge',
  trailingSlash: 'always',
  telemetry: false,
  // Screenshots are shipped as-is: no native image toolchain (sharp) in the docs build.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'relic-bridge',
      description: 'Unofficial MCP server for New Relic via NerdGraph: guides, references and design docs.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/mhidalgo-lab/relic-bridge' }],
      pagefind: true,
      components: { Banner: './src/components/Banner.astro' },
      lastUpdated: false,
      sidebar: [
        ...guideGroups.map(([label, slugs]) => ({
          label,
          items: slugs.map((s) => ({ slug: `guide/${s}` })),
        })),
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Design', items: [{ autogenerate: { directory: 'design' } }] },
        { label: 'Decisions (ADRs)', collapsed: true, items: [{ autogenerate: { directory: 'adr' } }] },
        {
          label: 'Contributing and internals',
          collapsed: true,
          items: [{ autogenerate: { directory: 'dev' } }],
        },
      ],
    }),
  ],
});
