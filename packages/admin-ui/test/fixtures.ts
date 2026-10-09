// SPDX-License-Identifier: Apache-2.0
// A stand-in for the server side of the admin UI: sessions by cookie value, the P4-02 origin rules, a recorded admin
// API. The real wiring (`@relic-bridge/http-app`) is tested in the P2-12 matrix.
import { Hono } from 'hono';
import {
  type AdminCall,
  type AdminCallResult,
  type AdminUiDeps,
  ASSETS,
  createAdminUi,
  type UiPrincipal,
  type UiRole,
} from '../src/index.ts';

export const ORIGIN = 'http://localhost';
export const T: number = Date.UTC(2026, 9, 3, 12, 0, 0);

export function principalFor(role: UiRole, over: Partial<UiPrincipal> = {}): UiPrincipal {
  return Object.freeze({
    userId: `usr_${role}`,
    email: `${role}@example.com`,
    displayName: null,
    role,
    csrf: `${role.toUpperCase()}-${'c'.repeat(37)}`,
    expiresAt: T + 12 * 3600_000,
    idleExpiresAt: T + 30 * 60_000,
    ...over,
  });
}

export interface Fake {
  readonly deps: AdminUiDeps;
  readonly calls: AdminCall[];
  readonly forbidden: string[];
  readonly errors: unknown[];
  /** Principals by cookie value (`rb_session=<value>`). */
  readonly sessions: Map<string, UiPrincipal>;
  adminAnswer: (call: AdminCall) => AdminCallResult;
}

export function fakeDeps(over: Partial<AdminUiDeps> = {}): Fake {
  const sessions = new Map<string, UiPrincipal>([
    ['owner', principalFor('owner')],
    ['admin', principalFor('admin')],
    ['member', principalFor('member')],
  ]);
  const fake: Fake = {
    calls: [],
    forbidden: [],
    errors: [],
    sessions,
    adminAnswer: () => ({
      status: 200,
      body: {
        data: [
          { email: 'a@example.com', role: 'owner', disabledAt: null },
          { email: 'b@example.com', role: 'member', disabledAt: 1 },
        ],
        nextCursor: null,
      },
    }),
    deps: {
      secureCookies: false,
      clearSessionCookie: 'rb_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      async authenticate(c) {
        const cookie = /(?:^|;\s*)rb_session=([^;]*)/.exec(c.req.header('cookie') ?? '')?.[1];
        if (cookie === undefined) return { ok: false, presented: false };
        const principal = sessions.get(cookie);
        return principal ? { ok: true, principal } : { ok: false, presented: true };
      },
      checkFetchOrigin(c, unsafe) {
        const site = c.req.header('sec-fetch-site');
        if (site !== undefined && site !== 'same-origin' && !(site === 'none' && !unsafe))
          return 'cross_site';
        if (!unsafe) return null;
        const origin = c.req.header('origin');
        if (origin !== undefined) return origin === ORIGIN ? null : 'origin_mismatch';
        return site === 'same-origin' ? null : 'origin_missing';
      },
      csrfMatches: (p, presented) => presented === p.csrf,
      async callAdmin(_c, _p, call) {
        fake.calls.push(call);
        return fake.adminAnswer(call);
      },
      onForbidden: (_c, p, reason) => {
        fake.forbidden.push(`${p.role}:${reason}`);
      },
      onError: (_c, error) => {
        fake.errors.push(error);
      },
      ...over,
    },
  };
  return fake;
}

/** The UI mounted like the HTTP app mounts it (request id and log first). */
export function mount(ui: Hono): Hono {
  const app = new Hono<{ Variables: { requestId: string; log: Record<string, unknown> } }>();
  app.use('*', async (c, next) => {
    c.set('requestId', '00000000-0000-4000-8000-000000000000');
    c.set('log', {});
    await next();
  });
  app.route('/admin', ui);
  return app as unknown as Hono;
}

export const uiApp = (fake: Fake): Hono => mount(createAdminUi(fake.deps));

export const same = (session: string, extra: Record<string, string> = {}): Record<string, string> => ({
  cookie: `rb_session=${session}`,
  'sec-fetch-site': 'same-origin',
  ...extra,
});

/** Asset names change with their content: keep snapshots stable. */
export const stable = (html: string): string =>
  html
    .replaceAll(ASSETS.css.file, 'admin.<hash>.css')
    .replaceAll(ASSETS.js.file, 'admin.<hash>.js')
    .replaceAll(ASSETS.css.integrity, 'sha384-<css>')
    .replaceAll(ASSETS.js.integrity, 'sha384-<js>');
