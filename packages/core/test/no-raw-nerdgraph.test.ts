// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MUTATIONS,
  createBuiltinTools,
  DocumentError,
  defineDocument,
  inputJsonSchema,
} from '../src/index.ts';

/**
 * ADR-0014 / THREAT_MODEL T22: relic-bridge ships no raw NerdGraph (GraphQL passthrough) tool, and no built-in document is
 * a mutation. These guards fail when that changes without a deliberate decision (a new ADR superseding ADR-0014, P7-15).
 */
const tools = createBuiltinTools({ fetch: async () => new Response('{}') });

/** Every property name anywhere in a JSON schema. */
function propertyNames(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const s of schema) propertyNames(s, out);
  } else if (schema !== null && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === 'properties' && value && typeof value === 'object') out.push(...Object.keys(value));
      propertyNames(value, out);
    }
  }
  return out;
}

describe('no raw NerdGraph tool (ADR-0014, T22)', () => {
  it('no built-in tool is named like a GraphQL / NerdGraph passthrough', () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(tool.name).not.toMatch(/graph_?ql|nerd_?graph|gql/i);
  });

  it('no built-in tool takes a GraphQL document, operation or variables as input', () => {
    const forbidden =
      /^(graph_?ql|gql|document|mutation|subscription|operation(_?name)?|variables|selection(_?set)?)$/i;
    for (const tool of tools) {
      for (const name of propertyNames(inputJsonSchema(tool))) {
        expect(name, `${tool.name}.${name}`).not.toMatch(forbidden);
      }
    }
  });

  it('no built-in tool describes itself as running GraphQL', () => {
    for (const tool of tools) {
      expect(tool.description, tool.name).not.toMatch(
        /\b(run|execute|send)s? (a |any |raw )?(graphql|nerdgraph)\b/i,
      );
    }
  });
});

describe('defineDocument refuses mutations and subscriptions by default (ADR-0014)', () => {
  it.each([
    'mutation RbM { apiAccessDeleteKeys(keys: {}) { errors { message } } }',
    '  \n\tmutation RbM($k: ID!) { x(id: $k) { y } }',
    'mutation RbM @skip(if: true) { x }',
  ])('rejects a mutation without the explicit opt-in: %s', (doc) => {
    expect(() => defineDocument(doc)).toThrow(DocumentError);
    expect(() => defineDocument(doc, { mutation: false })).toThrow(/mutation/);
  });

  it('accepts a mutation only with { mutation: true } and an allow-listed name (ADR-0015, P7-09)', () => {
    expect(
      defineDocument('mutation RbAckIssue($id: ID!) { x(id: $id) { y } }', { mutation: true }).name,
    ).toBe('RbAckIssue');
    expect(() => defineDocument('mutation RbW($id: ID!) { x(id: $id) { y } }', { mutation: true })).toThrow(
      /allow-list/,
    );
    expect(() => defineDocument('mutation RbAckIssue { x }')).toThrow(/mutation/);
  });

  it('{ mutation: true } on a query is refused (no blanket opt-in)', () => {
    expect(() => defineDocument('query RbQ { actor { user { id } } }', { mutation: true })).toThrow(/query/);
  });

  it('every allow-listed mutation belongs to exactly one write tool document, and none to a read tool', async () => {
    const mutations = await import('../src/nerdgraph/mutations.ts');
    const defined = (Object.values(mutations) as unknown[])
      .filter(
        (v): v is { name: string; query: string } => typeof v === 'object' && v !== null && 'query' in v,
      )
      .filter((d) => d.query.trimStart().startsWith('mutation'))
      .map((d) => d.name)
      .sort();
    expect(defined).toEqual([...ALLOWED_MUTATIONS].sort());
  });

  it('rejects subscriptions even with the opt-in', () => {
    expect(() => defineDocument('subscription RbS { x }')).toThrow(/subscription/);
    expect(() => defineDocument('subscription RbS { x }', { mutation: true })).toThrow(/subscription/);
  });

  it('still accepts named queries', () => {
    expect(defineDocument('query RbQ { actor { user { id } } }').name).toBe('RbQ');
  });
});
