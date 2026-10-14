// SPDX-License-Identifier: Apache-2.0
// Per-tool overhead and cost inside workerd (P8-03). Run through `pnpm bench` (scripts/bench-tools.ts), which reads
// `task.meta.tools` from the JSON reporter. The tool code is the same as under Node; only the runtime differs.
import { describe, it } from 'vitest';
import { measureTools } from '../../../scripts/bench/tools-harness.ts';

describe('tools', () => {
  it('per-tool overhead and cost', async ({ task }) => {
    (task.meta as Record<string, unknown>)['tools'] = await measureTools();
  });
});
