// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createLogger, Secret } from '../src/index.ts';

const KEY = 'NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0';

function capture(level: 'debug' | 'info' = 'info') {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: (l) => lines.push(l), now: () => 0 });
  return { logger, lines, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('logger', () => {
  it('writes structured JSON with level filtering', () => {
    const { logger, records } = capture('info');
    logger.debug('hidden');
    logger.info('shown', { n: 1 });
    expect(records()).toEqual([{ ts: '1970-01-01T00:00:00.000Z', level: 'info', msg: 'shown', n: 1 }]);
  });

  it('redacts secrets in messages, fields, Secrets and errors', () => {
    const { logger, lines } = capture();
    logger.error(`failed with ${KEY}`, {
      apiKey: KEY,
      secret: new Secret(KEY),
      error: new Error(`upstream echoed ${KEY}`),
      headers: { 'API-Key': KEY },
      note: `token rb_live_FAKE8Kq2Lm9Np4Rs7Tv1Wy3Ab6`,
    });
    const out = lines.join('\n');
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('FAKE8Kq2Lm9Np4Rs7Tv1Wy3Ab6');
  });

  it('child loggers carry fields', () => {
    const { logger, records } = capture();
    logger.child({ requestId: 'r1' }).info('hi');
    expect(records()[0]).toMatchObject({ requestId: 'r1', msg: 'hi' });
  });

  it('never throws when the sink fails', () => {
    const logger = createLogger({
      sink: () => {
        throw new Error('sink down');
      },
    });
    expect(() => logger.error('x')).not.toThrow();
  });
});
