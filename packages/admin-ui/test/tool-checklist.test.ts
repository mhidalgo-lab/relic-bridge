// SPDX-License-Identifier: Apache-2.0
// The tools checklist (P4-04) and write tools (P7-09): "all tools" never implies a write tool; ticking one next to
// "all" turns the choice into an explicit list of every read tool plus the ticked write tools.
import { describe, expect, it } from 'vitest';
import type { UiTool, VerifiedForm } from '../src/kit.ts';
import { toolsFrom } from '../src/screens/shared.tsx';
import { principalFor } from './fixtures.ts';

const TOOLS: UiTool[] = [
  { name: 'whoami', title: 'Who am I', group: 'identity', kind: 'read' },
  { name: 'run_nrql', title: 'Run NRQL', group: 'query', kind: 'read' },
  { name: 'acknowledge_issue', title: 'Ack', group: 'writes', kind: 'write' },
  { name: 'close_issue', title: 'Close', group: 'writes', kind: 'destructive' },
];

const form = (pairs: [string, string][]): VerifiedForm => ({
  fields: new URLSearchParams(pairs),
  principal: principalFor('owner'),
});

describe('toolsFrom', () => {
  it('"all" alone is null (every read tool)', () => {
    expect(toolsFrom(form([['tools_all', '1']]), TOOLS)).toEqual({ value: null });
    expect(
      toolsFrom(
        form([
          ['tools_all', '1'],
          ['tools', 'whoami'],
        ]),
        TOOLS,
      ),
    ).toEqual({ value: null });
  });

  it('"all" plus write tools becomes an explicit list', () => {
    expect(
      toolsFrom(
        form([
          ['tools_all', '1'],
          ['tools', 'close_issue'],
        ]),
        TOOLS,
      ),
    ).toEqual({
      value: ['whoami', 'run_nrql', 'close_issue'],
    });
  });

  it('a chosen subset stays as chosen', () => {
    expect(
      toolsFrom(
        form([
          ['tools', 'whoami'],
          ['tools', 'acknowledge_issue'],
        ]),
        TOOLS,
      ),
    ).toEqual({
      value: ['whoami', 'acknowledge_issue'],
    });
    expect(toolsFrom(form([]), TOOLS)).toHaveProperty('error');
  });
});
