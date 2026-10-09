// SPDX-License-Identifier: Apache-2.0
// MCP Apps extension (P7-04, spec `io.modelcontextprotocol/ui` 2026-01-26): interactive charts for NRQL results.
// Web-standard only. The view itself lives in packages/core/assets/chart-app.* (see scripts/gen-app-assets.ts).
//
// Fallback: nothing here changes a tool result. A client without MCP Apps ignores the tool's `_meta.ui` and sees the
// same text and `structuredContent` as before; it only sees one more resource in `resources/list`.
export { CHART_APP_HTML } from './chart-app.generated.ts';

/** Extension id a client declares under `capabilities.extensions` when it renders MCP Apps. */
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';
/** MIME type of an MCP App HTML resource. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
/** The NRQL chart view: line (timeseries), bar (facets) or table, drawn from the tool's `structuredContent`. */
export const NRQL_CHART_URI = 'ui://relic-bridge/nrql-chart';

/**
 * Resource `_meta.ui`: no CSP domains at all (no fetch/XHR, no remote script, style, font, image or frame; the host
 * applies its restrictive default), and a border around the inline view.
 */
export const CHART_APP_RESOURCE_META: Readonly<Record<string, unknown>> = Object.freeze({
  ui: Object.freeze({
    csp: Object.freeze({
      connectDomains: Object.freeze([]),
      resourceDomains: Object.freeze([]),
      frameDomains: Object.freeze([]),
      baseUriDomains: Object.freeze([]),
    }),
    prefersBorder: true,
  }),
});

/**
 * Tool `_meta` linking a tool to its view. `visibility: ["model"]`: the view may not call the tool through the host
 * (it never needs to; its data is the result it was given). The flat `ui/resourceUri` key is the spec's deprecated
 * spelling, kept for hosts that predate `ui.resourceUri`.
 */
export function toolUiMeta(resourceUri: string): Record<string, unknown> {
  return { ui: { resourceUri, visibility: ['model'] }, 'ui/resourceUri': resourceUri };
}

/**
 * Whether a client declared MCP Apps support (P7-16): `capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes`
 * lists {@link MCP_APP_MIME_TYPE}.
 *
 * - `undefined` capabilities (nothing is known: a stateless 2025-era HTTP request never sees the `initialize` that
 *   another request carried) answer `'unknown'`.
 * - Capabilities that are present but lack the declaration answer `'no'`.
 */
export function clientAppsSupport(capabilities: unknown): 'yes' | 'no' | 'unknown' {
  if (capabilities === undefined || capabilities === null || typeof capabilities !== 'object')
    return 'unknown';
  const extensions = (capabilities as { extensions?: unknown }).extensions;
  if (extensions === null || typeof extensions !== 'object') return 'no';
  const entry = (extensions as Record<string, unknown>)[MCP_APPS_EXTENSION];
  if (entry === null || typeof entry !== 'object') return 'no';
  const mimeTypes = (entry as { mimeTypes?: unknown }).mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APP_MIME_TYPE) ? 'yes' : 'no';
}
