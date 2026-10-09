// SPDX-License-Identifier: Apache-2.0
// The `/admin` sub-app (P4-03). Mounted by `@relic-bridge/http-app` at `/admin` whenever sign-in is configured.
//
//   GET /admin                     overview (any signed-in role)
//   /admin/credentials, /admin/projects, /admin/grants, /admin/tokens, /admin/users   P4-04 screens (admin, owner)
//   GET /admin/assets/:file        static assets (public, hashed names, immutable)
//   ALL /admin/*                   signed-in 404 page (everyone else: sign-in redirect)
//
// Screens (P4-04+) register their routes in `registerScreens` with `kit.page` / `kit.form`.
import { Hono } from 'hono';
import { ASSET_CACHE_CONTROL, findAsset } from './assets.ts';
import { type AdminUiDeps, createUiKit, requestIdOf, type UiKit } from './kit.ts';
import { errorPage } from './pages.tsx';
import { registerAudit } from './screens/audit.tsx';
import { registerConnect } from './screens/connect.tsx';
import { registerCredentials } from './screens/credentials.tsx';
import { registerGrants } from './screens/grants.tsx';
import { registerOverview } from './screens/overview.tsx';
import { registerProjects } from './screens/projects.tsx';
import { registerTokens } from './screens/tokens.tsx';
import { registerUsage } from './screens/usage.tsx';
import { registerUsers } from './screens/users.tsx';

/** Where the UI is mounted. */
export const ADMIN_UI_BASE: '/admin' = '/admin';

/** Every screen's routes. Add new screens here, before the catch-all. */
function registerScreens(ui: Hono, kit: UiKit): void {
  registerOverview(ui, kit);
  registerCredentials(ui, kit);
  registerProjects(ui, kit);
  registerGrants(ui, kit);
  registerTokens(ui, kit);
  registerConnect(ui, kit);
  registerUsers(ui, kit);
  registerAudit(ui, kit);
  registerUsage(ui, kit);
}

export function createAdminUi(deps: AdminUiDeps): Hono {
  const kit = createUiKit(deps);
  const ui = new Hono();

  ui.get('/assets/:file', (c) => {
    const asset = findAsset(c.req.param('file'));
    if (asset === undefined) return errorPage(404, requestIdOf(c));
    return new Response(asset.body, {
      headers: { 'Content-Type': asset.type, 'Cache-Control': ASSET_CACHE_CONTROL },
    });
  });

  registerScreens(ui, kit);

  // Anything else under /admin: sign-in first (no page names leak to strangers), then a 404 page.
  ui.all(
    '/*',
    kit.page('member', (c, page) => errorPage(404, requestIdOf(c), page.principal)),
  );

  ui.onError((error, c) => {
    try {
      deps.onError?.(c, error);
    } catch {
      // never let logging change the answer
    }
    return errorPage(500, requestIdOf(c));
  });

  return ui;
}
