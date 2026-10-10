// SPDX-License-Identifier: Apache-2.0
// P7-08: the exporter against a real local OTLP receiver (a socket), on Node. No real endpoint or key.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTelemetry } from '@relic-bridge/http-app';
import { describe, expect, it } from 'vitest';

describe('OTLP exporter over a real socket', () => {
  it('posts JSON with the configured headers to /v1/metrics and /v1/traces', async () => {
    const seen: { url: string; key: string | undefined; type: string | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          key: req.headers['api-key'] as string | undefined,
          type: req.headers['content-type'],
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const port = (server.address() as AddressInfo).port;
      const t = createTelemetry({
        endpoint: `http://127.0.0.1:${port}`,
        headers: { 'api-key': 'fake-key' },
        runtime: 'node',
      });
      await t.hooks.onToolCall?.({} as never, { projectSlug: 'prod' } as never, {
        tool: 'whoami',
        status: 'ok',
        errorCode: null,
        durationMs: 42,
        input: {},
        meta: undefined,
      });
      expect(seen.map((s) => s.url).sort()).toEqual(['/v1/metrics', '/v1/traces']);
      expect(seen.every((s) => s.key === 'fake-key' && s.type === 'application/json')).toBe(true);
      const metrics = JSON.parse(seen.find((s) => s.url === '/v1/metrics')?.body ?? '{}');
      expect(metrics.resourceMetrics[0].resource.attributes).toContainEqual({
        key: 'process.runtime.name',
        value: { stringValue: 'node' },
      });
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });
});
