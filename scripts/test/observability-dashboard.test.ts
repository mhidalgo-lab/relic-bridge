// SPDX-License-Identifier: Apache-2.0
// P8-52: the self-monitoring dashboard in docs/guide/observability-dashboard.json is a valid NerdGraph `DashboardInput`
// (checked against the committed schema snapshot), so it imports as is once the account id is set.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { coerceInputValue, type GraphQLInputType, isInputType, validateInputValue } from 'graphql';
import { describe, expect, it } from 'vitest';
import { loadSnapshot, validateDocument } from '../nerdgraph-schema.ts';

const FILE = fileURLToPath(new URL('../../docs/guide/observability-dashboard.json', import.meta.url));
const GUIDE = fileURLToPath(new URL('../../docs/guide/observability.md', import.meta.url));
const dashboard = JSON.parse(readFileSync(FILE, 'utf8')) as {
  pages: {
    widgets: {
      title: string;
      layout: { column: number; row: number; width: number; height: number };
      visualization: { id: string };
      rawConfiguration: { nrqlQueries: { accountIds: number[]; query: string }[] };
    }[];
  }[];
};
const widgets = dashboard.pages.flatMap((p) => p.widgets);
const schema = loadSnapshot();

describe('self-monitoring dashboard (P8-52)', () => {
  it('is a DashboardInput the dashboardCreate mutation accepts', () => {
    expect(schema).not.toBeNull();
    if (schema === null) return;
    const mutation =
      'mutation($accountId: Int!, $dashboard: DashboardInput!) { dashboardCreate(accountId: $accountId, dashboard: $dashboard) { errors { description } } }';
    expect(validateDocument(schema, mutation)).toEqual([]);
    const type = schema.getType('DashboardInput');
    expect(type !== undefined && isInputType(type)).toBe(true);
    const errorsOf = (value: unknown): string[] => {
      const errors: string[] = [];
      // Unknown fields, missing required fields, wrong scalar types and invalid enum values are all reported here.
      validateInputValue(value, type as GraphQLInputType, (error, path) => {
        errors.push(`${path.join('.')}: ${error.message}`);
      });
      return errors;
    };
    expect(errorsOf(dashboard)).toEqual([]);
    expect(coerceInputValue(dashboard, type as GraphQLInputType)).not.toBeUndefined();
    // The check itself rejects a broken dashboard.
    const firstWidget = { ...widgets[0], titel: 'x' };
    const broken = {
      ...dashboard,
      permissions: 'EVERYONE',
      pages: [{ ...dashboard.pages[0], widgets: [firstWidget] }],
    };
    expect(errorsOf(broken).length).toBe(2);
  });

  it('only uses typed visualizations, a 12-column grid and the placeholder account id', () => {
    const typed = new Set(['viz.area', 'viz.bar', 'viz.billboard', 'viz.line', 'viz.pie', 'viz.table']);
    for (const w of widgets) {
      expect(typed).toContain(w.visualization.id);
      expect(w.layout.column + w.layout.width - 1).toBeLessThanOrEqual(12);
      expect(w.rawConfiguration.nrqlQueries.length).toBeGreaterThan(0);
      for (const q of w.rawConfiguration.nrqlQueries) expect(q.accountIds).toEqual([0]);
    }
  });

  it('queries only relic-bridge data, without a fixed time window', () => {
    for (const w of widgets) {
      for (const { query } of w.rawConfiguration.nrqlQueries) {
        expect(query).toContain("service.name = 'relic-bridge'");
        expect(query).not.toMatch(/\b(SINCE|UNTIL)\b/i);
      }
    }
    // No account id, guid or key slipped in (the file is public).
    expect(readFileSync(FILE, 'utf8')).not.toMatch(/\b\d{6,}\b|NRAK-|[A-Za-z0-9]{40,}/);
  });

  it('is linked from the guide', () => {
    expect(readFileSync(GUIDE, 'utf8')).toContain('observability-dashboard.json');
  });
});
