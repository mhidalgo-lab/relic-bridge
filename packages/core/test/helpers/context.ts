// SPDX-License-Identifier: Apache-2.0
import {
  createBudget,
  createLogger,
  DEFAULT_LIMITS,
  type LogSink,
  Secret,
  type ToolContext,
  unboundedLimiter,
} from '../../src/index.ts';

/** Test key: obviously fake but shaped like a real User key, so redaction is exercised. */
export const FAKE_KEY = 'NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0';

export function testContext(overrides: Partial<ToolContext> = {}, sink?: LogSink): ToolContext {
  const lines: string[] = [];
  return {
    requestId: 'req-test-1',
    credential: { id: 'cred-1', region: 'US', apiKey: new Secret(FAKE_KEY) },
    accounts: { allowed: [1000001], default: 1000001 },
    budget: createBudget(50),
    limiter: unboundedLimiter,
    limits: DEFAULT_LIMITS,
    logger: createLogger({ level: 'debug', sink: sink ?? ((l) => lines.push(l)), now: () => 0 }),
    clock: { now: () => 0 },
    ...overrides,
  };
}
