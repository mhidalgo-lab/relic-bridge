// SPDX-License-Identifier: Apache-2.0
// The request side of the admin UI (P4-03, THREAT_MODEL T13/T14): page and form guards, the CSRF-checked form reader,
// in-process calls to the admin API, redirects with flash messages. One kit per app instance; nothing about a request
// outlives it (T21).
import type { Context } from 'hono';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { CSRF_FIELD, localHref, UI_ROLE_RANK, type UiRole, type UiViewer } from './components.tsx';
import { clearFlashCookie, type FlashCode, type FlashMessage, flashCookie, readFlash } from './flash.ts';
import { errorPage, htmlResponse } from './pages.tsx';

/** The signed-in person behind a UI request (from the admin session; the role is re-read on every request). */
export interface UiPrincipal extends UiViewer {
  readonly userId: string;
  /** Absolute end of the session (epoch ms). */
  readonly expiresAt: number;
  /** End of the session if no request comes before then (epoch ms). */
  readonly idleExpiresAt: number;
}

export type UiAuthResult =
  | { readonly ok: true; readonly principal: UiPrincipal }
  /**
   * `presented`: the request carried a session cookie (dead or broken): the page clears it. `response`: send this
   * instead of the sign-in redirect (the failed-authentication throttle's 429).
   */
  | { readonly ok: false; readonly presented: boolean; readonly response?: Response };

/** One admin API call (`path` relative to `/api/admin/v1`; build it with {@link adminPath}). */
export interface AdminCall {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** JSON body for POST/PATCH. */
  readonly body?: unknown;
}

export interface AdminCallResult {
  readonly status: number;
  /** Parsed JSON body (null when there is none). On errors: `{ error: { code, message, … } }`. */
  readonly body: unknown;
}

/** One tool of the catalogue, as the project and grant screens list it (P4-04). */
export interface UiTool {
  readonly name: string;
  readonly title: string;
  /** Catalogue group (`query`, `entities`, …): the checklist is grouped by it. */
  readonly group: string;
  /** `read` tools have no side effects in New Relic; `write` and `destructive` ones do. */
  readonly kind: 'read' | 'write' | 'destructive';
}

/** What the admin UI needs from the server (`@relic-bridge/http-app` provides it from the P4-02 sessions). */
export interface AdminUiDeps {
  /** Every built-in tool (projects and grants choose from it). Default: none (tool lists are then all-or-nothing). */
  readonly tools?: readonly UiTool[];
  /** `RB_PUBLIC_URL`, to show full MCP endpoint URLs. Without it, pages show paths. */
  readonly publicUrl?: string;
  /** The server clock (epoch ms) for "expired" labels. Default `Date.now`. */
  readonly now?: () => number;
  /** https public URL: `__Host-` cookie names and `Secure`. */
  readonly secureCookies: boolean;
  /** Load and check the admin session of this request. Never looks at `Authorization`. */
  authenticate(c: Context): Promise<UiAuthResult>;
  /** Fetch-metadata and `Origin` checks for a cookie-authenticated request (null when fine). */
  checkFetchOrigin(c: Context, unsafe: boolean): string | null;
  /** Constant-time check of the presented CSRF token against the session's. */
  csrfMatches(principal: UiPrincipal, presented: string | undefined): boolean;
  /** `Set-Cookie` value that removes the session cookie. */
  readonly clearSessionCookie: string;
  /** Run an admin API request in-process as this principal (cookie, CSRF token and our own Origin attached). */
  callAdmin(c: Context, principal: UiPrincipal, call: AdminCall): Promise<AdminCallResult>;
  /** A refused UI request of a signed-in user (CSRF, origin, role): audit it. Must not throw. */
  onForbidden?(c: Context, principal: UiPrincipal, reason: string): void;
  /** Before the session is looked up (per-IP rate limit). A Response stops the request. */
  beforeAuth?(c: Context): Promise<Response | undefined> | Response | undefined;
  /** An unexpected error (logged without its message). */
  onError?(c: Context, error: unknown): void;
  /** Largest form body. Default 16 KiB. */
  readonly maxFormBytes?: number;
}

/** A form body that passed the origin and CSRF checks, for this principal only. */
export interface VerifiedForm {
  readonly fields: URLSearchParams;
  readonly principal: UiPrincipal;
}

export interface PageContext {
  readonly principal: UiPrincipal;
  /** The flash message to show (cleared from the browser by `html`). */
  readonly flash: FlashMessage | null;
  /** Render a page (and clear a shown flash). */
  html(node: JSX.Element, status?: number): Response;
}

export type PageHandler = (c: Context, page: PageContext) => Response | Promise<Response>;
export type FormHandler = (
  c: Context,
  principal: UiPrincipal,
  form: VerifiedForm,
) => Response | Promise<Response>;

export interface UiKit {
  readonly deps: AdminUiDeps;
  /** A GET page for `minRole` and above. */
  page(minRole: UiRole, handler: PageHandler): (c: Context) => Promise<Response>;
  /** A POST form target for `minRole` and above: origin, CSRF token and size are checked before `handler` runs. */
  form(minRole: UiRole, handler: FormHandler): (c: Context) => Promise<Response>;
  /** Call the admin API as `principal`. Unsafe methods need the verified form of this request. */
  callAdmin(
    c: Context,
    principal: UiPrincipal,
    call: AdminCall,
    form?: VerifiedForm,
  ): Promise<AdminCallResult>;
  /** `303` to a same-origin path, optionally with a flash message on the next page. */
  redirect(path: string, flash?: FlashCode): Response;
}

export const DEFAULT_MAX_FORM_BYTES: number = 16 * 1024;
const FORM_TYPE = /^application\/x-www-form-urlencoded\s*(;|$)/i;
const LOGIN_PATH = '/auth/login';

/**
 * An admin API path with every interpolated value percent-encoded as one path segment (ids from a form can't add
 * segments, a query or a fragment): adminPath`/users/${id}/sessions/revoke`. Empty, `.` and `..` values throw: URL
 * parsing would turn them into another route.
 */
export function adminPath(strings: TemplateStringsArray, ...values: readonly (string | number)[]): string {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    const segment = String(v);
    if (segment === '' || segment === '.' || segment === '..')
      throw new TypeError('invalid admin API path segment');
    out += encodeURIComponent(segment) + (strings[i + 1] ?? '');
  });
  return out;
}

/**
 * Cross-site requests a page may serve: only top-level navigations (a link from mail or chat). Subresource loads,
 * `fetch`, frames and anything else from another site are refused before the session is looked at.
 */
export function pageFetchProblem(c: Context): string | null {
  const site = c.req.header('sec-fetch-site');
  if (site === undefined || site === 'same-origin' || site === 'none') return null;
  const method = c.req.method;
  if (
    (method === 'GET' || method === 'HEAD') &&
    c.req.header('sec-fetch-mode') === 'navigate' &&
    c.req.header('sec-fetch-dest') === 'document'
  ) {
    return null;
  }
  return 'cross_site';
}

/** Read at most `max` bytes of the body (declared length or not); null when it is larger. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,15}$/.test(declared) || Number(declared) > max)) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export const requestIdOf = (c: Context): string | undefined => {
  const id = c.get('requestId') as unknown;
  return typeof id === 'string' ? id : undefined;
};

export function createUiKit(deps: AdminUiDeps): UiKit {
  const maxFormBytes = deps.maxFormBytes ?? DEFAULT_MAX_FORM_BYTES;
  if (!Number.isSafeInteger(maxFormBytes) || maxFormBytes < 1024 || maxFormBytes > 1024 * 1024) {
    throw new RangeError('maxFormBytes must be between 1024 and 1048576');
  }
  // Forms verified by this kit. A WeakSet, not module state: entries die with their request.
  const verified = new WeakSet<VerifiedForm>();

  const toLogin = (c: Context, presented: boolean): Response => {
    const target =
      c.req.method === 'GET' || c.req.method === 'HEAD' ? `${c.req.path}${queryOf(c)}` : '/admin';
    const headers = new Headers({ Location: `${LOGIN_PATH}?${new URLSearchParams({ next: target })}` });
    if (presented) headers.append('Set-Cookie', deps.clearSessionCookie);
    return new Response(null, { status: 303, headers });
  };

  const forbidden = (c: Context, principal: UiPrincipal, reason: string): Response => {
    const log = c.get('log') as Record<string, unknown> | undefined;
    if (log) log['deny'] = reason;
    try {
      deps.onForbidden?.(c, principal, reason);
    } catch {
      // auditing never changes the answer
    }
    return errorPage(403, requestIdOf(c), principal);
  };

  /** Fetch metadata, pre-auth hook, session. A Response means stop. */
  const enter = async (c: Context, unsafe: boolean): Promise<UiPrincipal | Response> => {
    if (!unsafe && pageFetchProblem(c) !== null) {
      const log = c.get('log') as Record<string, unknown> | undefined;
      if (log) log['reject'] = 'cross_site';
      return errorPage(403, requestIdOf(c));
    }
    const stop = await deps.beforeAuth?.(c);
    if (stop) return stop;
    const auth = await deps.authenticate(c);
    if (!auth.ok) return auth.response ?? toLogin(c, auth.presented);
    return auth.principal;
  };

  const allowed = (principal: UiPrincipal, minRole: UiRole) =>
    UI_ROLE_RANK[principal.role] >= UI_ROLE_RANK[minRole];

  return {
    deps,

    page: (minRole, handler) => async (c) => {
      const entered = await enter(c, false);
      if (entered instanceof Response) return entered;
      const principal = entered;
      if (!allowed(principal, minRole)) return forbidden(c, principal, 'role');
      const flash = readFlash(c.req.header('cookie'), deps.secureCookies);
      return handler(c, {
        principal,
        flash: flash.message,
        html: (node, status = 200) =>
          htmlResponse(
            node,
            status,
            flash.present ? [['Set-Cookie', clearFlashCookie(deps.secureCookies)]] : [],
          ),
      });
    },

    form: (minRole, handler) => async (c) => {
      const entered = await enter(c, true);
      if (entered instanceof Response) return entered;
      const principal = entered;
      // Origin and fetch metadata first: a cross-site post is refused before its body is read.
      const problem = deps.checkFetchOrigin(c, true);
      if (problem !== null) return forbidden(c, principal, problem);
      if (!FORM_TYPE.test(c.req.header('content-type') ?? ''))
        return errorPage(415, requestIdOf(c), principal);
      const text = await readCapped(c.req.raw, maxFormBytes);
      if (text === null) return errorPage(413, requestIdOf(c), principal);
      const fields = new URLSearchParams(text);
      const tokens = fields.getAll(CSRF_FIELD);
      if (tokens.length !== 1 || !deps.csrfMatches(principal, tokens[0]))
        return forbidden(c, principal, 'csrf');
      fields.delete(CSRF_FIELD);
      if (!allowed(principal, minRole)) return forbidden(c, principal, 'role');
      const form: VerifiedForm = Object.freeze({ fields, principal });
      verified.add(form);
      return handler(c, principal, form);
    },

    async callAdmin(c, principal, call, form) {
      if (
        call.method !== 'GET' &&
        (form === undefined || !verified.has(form) || form.principal !== principal)
      ) {
        throw new TypeError('admin API changes from the UI need the verified form of the same request');
      }
      if (!call.path.startsWith('/') || call.path.startsWith('//')) {
        throw new TypeError('admin API paths start with one /');
      }
      return deps.callAdmin(c, principal, call);
    },

    redirect(path, flash) {
      const headers = new Headers({ Location: localHref(path) });
      if (flash !== undefined) headers.append('Set-Cookie', flashCookie(flash, deps.secureCookies));
      return new Response(null, { status: 303, headers });
    },
  };
}

function queryOf(c: Context): string {
  const url = new URL(c.req.url);
  return url.search;
}
