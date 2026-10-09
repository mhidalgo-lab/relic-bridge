// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, main, parseArgs, summarise, toolList } from '../eval-tools.ts';

describe('eval:tools (P6-13)', () => {
  it('is skipped, with no request, when ANTHROPIC_API_KEY is not set', async () => {
    const lines: string[] = [];
    await expect(main([], {}, (l) => lines.push(l))).resolves.toBe(0);
    expect(lines.join('\n')).toContain('skipped');
  });

  it('parses options and defaults to the current model', () => {
    expect(parseArgs([], {})).toMatchObject({ model: DEFAULT_MODEL, effort: 'medium', cases: null });
    expect(parseArgs([], { RB_EVAL_MODEL: 'claude-sonnet-5-5' }).model).toBe('claude-sonnet-5-5');
    expect(parseArgs(['--cases', 'healthy, gc', '--effort', 'low', '--min', '0.9'], {})).toMatchObject({
      cases: ['healthy', 'gc'],
      effort: 'low',
      min: 0.9,
    });
    expect(() => parseArgs(['--effort', 'turbo'], {})).toThrow(/--effort/);
    expect(() => parseArgs(['--bogus', 'x'], {})).toThrow(/unknown option/);
    expect(() => parseArgs(['--model'], {})).toThrow(/needs a value/);
  });

  it('sends the real tool list, prompt-cached at its end', () => {
    const tools = toolList();
    expect(tools.length).toBeGreaterThan(30);
    expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(tools.filter((t) => t.cache_control)).toHaveLength(1);
    for (const t of tools) expect(t.input_schema.type).toBe('object');
  });

  it('summarises choice and injection pass rates', () => {
    const ok = { pass: true, reason: '' };
    const ko = { pass: false, reason: '' };
    expect(
      summarise([
        { id: 'a', topic: 't', choice: ok, injection: null },
        { id: 'b', topic: 't', choice: ko, injection: ok },
        { id: 'c', topic: 't', choice: ok, injection: ko },
        { id: 'd', topic: 't', choice: ok, injection: null },
      ]),
    ).toEqual({ choice: 0.75, injection: 0.5, passed: 3, total: 4 });
  });
});
