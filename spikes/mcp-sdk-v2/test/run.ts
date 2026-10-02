// SPDX-License-Identifier: Apache-2.0
// Automated P0-07 checks: both protocol eras × slugs × transports. Usage:
//   tsx test/run.ts http http://127.0.0.1:8787     (Node or wrangler dev base URL)
//   tsx test/run.ts stdio
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

type Mode = 'legacy' | { pin: string };
const ERAS: { label: string; mode: Mode }[] = [
  { label: '2025-era (initialize)', mode: 'legacy' },
  { label: '2026-07-28 (pinned)', mode: { pin: '2026-07-28' } },
];

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}

async function callExpectingRejection(client: Client, name: string): Promise<boolean> {
  try {
    const r = await client.callTool({ name, arguments: {} });
    return r.isError === true;
  } catch {
    return true;
  }
}

async function exercise(client: Client, expected: string[], forbidden: string[]): Promise<void> {
  check(client.getProtocolEra() !== undefined, `negotiated era = ${client.getProtocolEra()}`);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify([...expected].sort()), `tools = ${names.join(',')}`);
  check(
    tools.every((t) => t.annotations?.readOnlyHint === true),
    'all tools carry readOnlyHint',
  );
  const typed = tools.find((t) => t.name === 'typed_result');
  if (typed) {
    check(JSON.stringify(typed.inputSchema).includes('$defs'), 'typed_result inputSchema keeps $defs/oneOf');
    check(typed.outputSchema !== undefined, 'typed_result has outputSchema');
    const r = await client.callTool({
      name: 'typed_result',
      arguments: { shape: { kind: 'square', side: 3 } },
    });
    check(
      (r.structuredContent as { area?: number } | undefined)?.area === 9,
      'typed_result structuredContent area=9',
    );
    const bad = await client
      .callTool({ name: 'typed_result', arguments: { shape: { kind: 'square', side: -1 } } })
      .then((x) => x.isError === true)
      .catch(() => true);
    check(bad, 'invalid oneOf input rejected');
  }
  const echo = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
  check(JSON.stringify(echo.content).includes('hi'), 'echo works');
  for (const f of forbidden) check(await callExpectingRejection(client, f), `call to hidden "${f}" rejected`);
}

async function http(base: string): Promise<void> {
  const cases = [
    {
      slug: 'a',
      header: undefined,
      expected: ['admin_only', 'echo', 'typed_result'],
      forbidden: [] as string[],
    },
    { slug: 'b', header: undefined, expected: ['echo', 'typed_result'], forbidden: ['admin_only'] },
    { slug: 'a', header: 'limited', expected: ['echo'], forbidden: ['typed_result', 'admin_only'] },
  ];
  for (const era of ERAS) {
    for (const c of cases) {
      console.log(`\n[http ${era.label}] slug=${c.slug}${c.header ? ` grant=${c.header}` : ''}`);
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/p/${c.slug}/mcp`), {
        requestInit: c.header ? { headers: { 'x-spike-grant': c.header } } : {},
      });
      const client = new Client(
        { name: 'spike-test', version: '0.0.0' },
        { versionNegotiation: { mode: era.mode } },
      );
      await client.connect(transport);
      await exercise(client, c.expected, c.forbidden);
      await client.close();
    }
  }
  console.log('\n[http] unknown slug');
  const res = await fetch(`${base}/p/zzz/mcp`, { method: 'POST', body: '{}' });
  check(res.status === 401, `unknown slug → ${res.status}`);
}

async function stdio(): Promise<void> {
  for (const era of ERAS) {
    console.log(`\n[stdio ${era.label}] slug=b`);
    const transport = new StdioClientTransport({
      command: 'node_modules/.bin/tsx',
      args: ['src/stdio.ts'],
      env: { ...process.env, SPIKE_SLUG: 'b' } as Record<string, string>,
    });
    const client = new Client(
      { name: 'spike-test', version: '0.0.0' },
      { versionNegotiation: { mode: era.mode } },
    );
    await client.connect(transport);
    await exercise(client, ['echo', 'typed_result'], ['admin_only']);
    await client.close();
  }
}

const [kind, base] = process.argv.slice(2);
if (kind === 'http' && base) await http(base);
else if (kind === 'stdio') await stdio();
else {
  console.error('usage: tsx test/run.ts http <baseUrl> | stdio');
  process.exit(2);
}
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
