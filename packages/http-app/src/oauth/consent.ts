// SPDX-License-Identifier: Apache-2.0
// The built-in sign-in and consent step of `/oauth/authorize` (P5-04, THREAT_MODEL T9/T10/T13). Web-standard only.
//
//   GET  /oauth/authorize?…           (validated by `server.ts`) → sign-in redirect, a remembered approval, or the page
//   POST /oauth/consent?…             the page's form: session + Origin + CSRF, then the request is validated again
//   GET  /oauth/approvals             the signed-in user's remembered approvals
//   POST /oauth/approvals/forget      forget one (CSRF)
//
// Stateless between steps: the authorization request travels in the URL (sign-in `next`, the form's `action`) and is
// re-validated by the provider every time, so nothing a page showed can differ from what is approved. The user can only
// pick one of their own grants on the project the `resource` names; `approve()` re-runs the access resolver anyway.
// Remembered approvals are `kv` rows per user + client + redirect URI + resource, written only after an explicit
// approval with the box ticked, and only for client ID metadata-document clients (a dynamically registered client's
// identity is not verified, P8-65); they still go through `approve()` (grant usable, CIMD document valid).
import {
  ApprovalsPage,
  CONSENT_FIELDS,
  CONSENT_LABEL_MAX,
  type ConsentGrantOption,
  ConsentPage,
  CSRF_FIELD,
  consentCsp,
  errorPage,
  formActionSource,
  htmlResponse,
  MessagePage,
  pageFetchProblem,
  type RememberedApproval,
  type UiAuthResult,
  type UiPrincipal,
} from '@relic-bridge/admin-ui';
import { resolveAccess } from '@relic-bridge/auth';
import { type Clock, type Logger, WRITE_TOOL_NAMES } from '@relic-bridge/core';
import type { KvRepository, Storage } from '@relic-bridge/storage';
import type { Context } from 'hono';
import type { AdminAuditEvent } from '../audit.ts';
import { isLoopbackHost } from './clients.ts';
import {
  MAX_REMEMBERED_APPROVALS,
  parseStored,
  REMEMBER_PREFIX,
  rememberKey,
  type StoredApproval,
} from './remembered.ts';
import {
  deviceLabel,
  MAX_DEVICE_LABEL_CHARS,
  MCP_WRITE_SCOPE,
  OAUTH_AUTHORIZE_PATH,
  type OAuthApproval,
  type OAuthConsentApi,
  type OAuthConsentHandler,
  type OAuthRuntime,
} from './server.ts';

export const OAUTH_CONSENT_PATH = '/oauth/consent';
export const OAUTH_APPROVALS_PATH = '/oauth/approvals';
export const OAUTH_APPROVALS_FORGET_PATH = '/oauth/approvals/forget';
/** How long "don't ask again" lasts. */
export const OAUTH_CONSENT_REMEMBER_TTL_S: number = 30 * 86_400;
export { MAX_REMEMBERED_APPROVALS } from './remembered.ts';
/** Longest `/oauth/authorize?…` a sign-in can return to (the sign-in `next` cap). */
export const MAX_AUTHORIZE_URL_CHARS = 2048;
/** Grants of one user on one project offered on the page. */
const MAX_OFFERED_GRANTS = 20;
const LOGIN_PATH = '/auth/login';
const DEFAULT_MAX_FORM_BYTES = 16 * 1024;
const FORM_TYPE = /^application\/x-www-form-urlencoded\s*(;|$)/i;
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** What the screen needs from the admin UI's session wiring (`adminUiDeps` in `app.ts`). */
export interface ConsentSessions {
  authenticate(c: Context): Promise<UiAuthResult>;
  checkFetchOrigin(c: Context, unsafe: boolean): string | null;
  csrfMatches(principal: UiPrincipal, presented: string | undefined): boolean;
  readonly clearSessionCookie: string;
  onForbidden?(c: Context, principal: UiPrincipal, reason: string): void;
}

export interface ConsentScreenDeps {
  readonly sessions: ConsentSessions;
  readonly storage: Pick<Storage, 'projects' | 'grants' | 'users' | 'credentials'>;
  readonly kv: Pick<KvRepository, 'get' | 'put' | 'delete' | 'list'>;
  readonly catalog: readonly string[];
  /** Tool name → title, for the access summary. */
  readonly toolTitles: ReadonlyMap<string, string>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `admin` audit rows (`oauth.consent.*`); never rejects. */
  readonly audit?: (event: AdminAuditEvent) => Promise<void>;
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
}

export interface ConsentScreen {
  /** The consent seam of `/oauth/authorize` (GET, request already validated). */
  readonly handler: OAuthConsentHandler;
  /** `POST /oauth/consent?…`. */
  decide(c: Context, runtime: OAuthRuntime): Promise<Response>;
  /** `GET /oauth/approvals`. */
  approvals(c: Context): Promise<Response>;
  /** `POST /oauth/approvals/forget`. */
  forget(c: Context): Promise<Response>;
}

function b64u(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The remembered-approval id of a request: SHA-256 of (client, redirect URI, resource), base64url. */
async function approvalId(api: OAuthConsentApi): Promise<string> {
  const material = JSON.stringify([api.request.clientId, api.request.redirectUri, api.request.resource]);
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))));
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

const requestIdOf = (c: Context): string | undefined => {
  const id = c.get('requestId') as unknown;
  return typeof id === 'string' ? id : undefined;
};

const logOf = (c: Context): Record<string, unknown> | undefined =>
  c.get('log') as Record<string, unknown> | undefined;

/** A page with fixed sentences only (plus the request id). */
function messagePage(
  c: Context,
  status: number,
  title: string,
  paragraphs: readonly string[],
  viewer?: UiPrincipal,
): Response {
  return htmlResponse(MessagePage({ title, paragraphs, viewer, requestId: requestIdOf(c) }), status);
}

/** The single value of a form field, or null when absent or repeated. */
function single(fields: URLSearchParams, name: string): string | null {
  const all = fields.getAll(name);
  return all.length === 1 ? (all[0] as string) : null;
}

export function createConsentScreen(deps: ConsentScreenDeps): ConsentScreen {
  const { sessions, storage, kv, clock } = deps;

  const audit = (c: Context, event: Omit<AdminAuditEvent, 'actor'> & { actor: AdminAuditEvent['actor'] }) => {
    if (!deps.audit) return;
    deps.runInBackground(c, deps.audit(event), 'admin_audit');
  };

  const consentAudit = (
    c: Context,
    action: 'oauth.consent.approve' | 'oauth.consent.deny',
    principal: UiPrincipal,
    api: OAuthConsentApi,
    extra: {
      readonly grantId?: string | null;
      readonly projectId?: string | null;
      readonly status?: 'ok' | 'denied';
      readonly errorCode?: string | null;
      readonly remembered?: 'used' | 'saved' | false;
      /** The scope the token was issued with (approvals only): shows whether `mcp:write` was granted. */
      readonly granted?: readonly string[];
    },
  ): void => {
    const r = api.request;
    audit(c, {
      actor: {
        requestId: requestIdOf(c) ?? null,
        userId: principal.userId,
        grantId: extra.grantId ?? null,
        clientId: r.clientId.slice(0, 200),
      },
      action,
      targetType: 'oauth_client',
      targetId: r.clientId.slice(0, 200),
      projectId: extra.projectId ?? null,
      status: extra.status ?? 'ok',
      errorCode: extra.errorCode ?? null,
      details: {
        project: r.projectSlug,
        clientKind: r.clientKind,
        clientHost: r.clientHost,
        redirectHost: r.redirectHost,
        scope: r.scope.join(' '),
        ...(extra.granted === undefined ? {} : { grantedScope: extra.granted.join(' ') }),
        ...(extra.remembered === undefined ? {} : { remembered: extra.remembered }),
      },
    });
  };

  const forbidden = (c: Context, principal: UiPrincipal, reason: string): Response => {
    const log = logOf(c);
    if (log) log['deny'] = reason;
    try {
      sessions.onForbidden?.(c, principal, reason);
    } catch {
      // auditing never changes the answer
    }
    return errorPage(403, requestIdOf(c), principal);
  };

  /** No usable session: back to sign-in, returning to `next` (a same-origin path). */
  const toLogin = (c: Context, auth: Extract<UiAuthResult, { ok: false }>, next: string): Response => {
    if (auth.response) return auth.response;
    if (next.length > MAX_AUTHORIZE_URL_CHARS) {
      return messagePage(c, 400, 'Request too long', [
        'This connection request is too long to continue after signing in. Ask the app to connect again.',
      ]);
    }
    const headers = new Headers({ Location: `${LOGIN_PATH}?${new URLSearchParams({ next })}` });
    if (auth.presented) headers.append('Set-Cookie', sessions.clearSessionCookie);
    return new Response(null, { status: 303, headers });
  };

  /** The user's own grants on the project that resolve now, as the page offers them. */
  const usableGrants = async (
    userId: string,
    slug: string,
  ): Promise<{ projectId: string | null; projectName: string | null; options: ConsentGrantOption[] }> => {
    const project = await storage.projects.getBySlug(slug);
    if (project === null || project.disabledAt !== null) {
      return { projectId: null, projectName: null, options: [] };
    }
    const grants = (await storage.grants.list({ projectId: project.id, userId }))
      .filter((g) => g.userId === userId && g.revokedAt === null)
      .slice(0, MAX_OFFERED_GRANTS);
    const options: ConsentGrantOption[] = [];
    for (const grant of grants) {
      const decision = await resolveAccess({
        storage,
        projectSlug: slug,
        principal: { grantId: grant.id, userId },
        catalog: deps.catalog,
        now: clock.now(),
      });
      if (!decision.ok || decision.access.userId !== userId) continue;
      const title = (t: string) => deps.toolTitles.get(t) ?? t;
      options.push({
        id: grant.id,
        label: grant.label ?? `Your access (${grant.id})`,
        tools: decision.access.tools.filter((t) => !WRITE_TOOL_NAMES.includes(t)).map(title),
        writeTools: decision.access.tools.filter((t) => WRITE_TOOL_NAMES.includes(t)).map(title),
        accounts: decision.access.accounts.allowed,
        expiresAt: decision.access.expiresAt,
      });
    }
    return {
      projectId: project.id,
      projectName: options.length > 0 ? project.name : null,
      options,
    };
  };

  /** The page itself, with `form-action` widened to the client's redirect origin (the post answers with a redirect). */
  const renderPage = async (
    c: Context,
    principal: UiPrincipal,
    api: OAuthConsentApi,
    status = 200,
    form: { readonly error?: string; readonly selected?: string; readonly label?: string } = {},
  ): Promise<Response> => {
    const r = api.request;
    const { projectName, options } = await usableGrants(principal.userId, r.projectSlug);
    const query = new URL(c.req.url).search;
    const response = htmlResponse(
      ConsentPage({
        viewer: principal,
        action: `${OAUTH_CONSENT_PATH}${query}`,
        client: {
          name: r.clientName,
          kind: r.clientKind,
          host: r.clientHost,
          redirectHost: r.redirectHost,
          loopback: isLoopbackHost(new URL(r.redirectUri).hostname),
        },
        project: { slug: r.projectSlug, name: projectName },
        grants: options,
        offline: r.scope.includes('offline_access'),
        writeRequested: r.scope.includes(MCP_WRITE_SCOPE),
        selected: form.selected,
        label: form.label,
        error: form.error,
        approvalsHref: OAUTH_APPROVALS_PATH,
        rememberDays: OAUTH_CONSENT_REMEMBER_TTL_S / 86_400,
      }),
      status,
    );
    const source = formActionSource(r.redirectUri);
    if (source !== null) response.headers.set('Content-Security-Policy', consentCsp(source));
    return response;
  };

  const clientRefusedPage = (c: Context, principal: UiPrincipal, api: OAuthConsentApi): Response =>
    messagePage(
      c,
      400,
      'This app can’t connect right now',
      [
        api.request.clientHost === null
          ? 'The app’s registration could not be used.'
          : `The app’s description at ${api.request.clientHost} could not be loaded or is not acceptable. Try again later.`,
      ],
      principal,
    );

  const redirectTo = (location: string): Response =>
    new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });

  /**
   * The answer to a consent post (P5-12). A redirect after a form post is subject to `form-action`, and no CSP source
   * can name `http://[::1]`; widening to `http:` would let any injected form post to any http site. So that one target
   * gets a same-origin page that navigates (`Refresh` plus a link: neither is governed by `form-action`).
   */
  const leaveTo = (c: Context, location: string): Response => {
    const target = new URL(location);
    if (target.protocol !== 'http:' || !target.hostname.startsWith('[')) return redirectTo(location);
    const response = htmlResponse(
      MessagePage({
        title: 'Return to the app',
        paragraphs: ['You are done here. Continue to the app on this computer.'],
        continueHref: target.href,
        requestId: requestIdOf(c),
      }),
    );
    response.headers.set('Refresh', `0; url=${target.href}`);
    return response;
  };

  /** "Don't ask again" is offered and honoured only for client ID metadata-document clients (P8-65). */
  const remembersClient = (api: OAuthConsentApi): boolean => api.request.clientKind === 'metadata_document';

  /** A remembered approval for this request, still in date and covering the requested scopes. */
  const remembered = async (
    userId: string,
    id: string,
    api: OAuthConsentApi,
  ): Promise<StoredApproval | null> => {
    const stored = parseStored(await kv.get(rememberKey(userId, id)));
    if (stored === null || stored.expiresAt <= clock.now()) return null;
    // Only metadata-document clients are identified (by their https client id). A dynamically registered client is
    // not, so it is never answered from memory; rows stored for one before P8-65 are dropped when met.
    if (!remembersClient(api) || stored.clientKind !== 'metadata_document') {
      await kv.delete(rememberKey(userId, id));
      return null;
    }
    if (stored.projectSlug !== api.request.projectSlug) return null;
    if (api.request.scope.includes(MCP_WRITE_SCOPE)) return null;
    return api.request.scope.every((s) => stored.scope.includes(s)) ? stored : null;
  };

  const remember = async (
    principal: UiPrincipal,
    api: OAuthConsentApi,
    grant: ConsentGrantOption,
    label: string | null,
  ): Promise<boolean> => {
    const prefix = `${REMEMBER_PREFIX}${principal.userId}:`;
    const id = await approvalId(api);
    const existing = await kv.list({ prefix, limit: MAX_REMEMBERED_APPROVALS });
    const key = rememberKey(principal.userId, id);
    if (existing.keys.length >= MAX_REMEMBERED_APPROVALS && !existing.keys.some((k) => k.name === key))
      return false;
    const r = api.request;
    const value: StoredApproval = {
      grantId: grant.id,
      clientId: r.clientId,
      scope: [...r.scope],
      label,
      clientName: r.clientName,
      clientKind: r.clientKind,
      clientHost: r.clientHost,
      redirectHost: r.redirectHost,
      projectSlug: r.projectSlug,
      grantLabel: grant.label,
      expiresAt: clock.now() + OAUTH_CONSENT_REMEMBER_TTL_S * 1000,
    };
    await kv.put(key, JSON.stringify(value), { expirationTtl: OAUTH_CONSENT_REMEMBER_TTL_S });
    return true;
  };

  return {
    async handler(c, api) {
      // Only top-level navigations from other sites (the client opening this page); no frames, fetches or subresources.
      if (pageFetchProblem(c) !== null) {
        const log = logOf(c);
        if (log) log['reject'] = 'cross_site';
        return errorPage(403, requestIdOf(c));
      }
      const auth = await sessions.authenticate(c);
      const url = new URL(c.req.url);
      // `prompt=none` (OIDC Core §3.1.2.6): never a page. Alone it may be answered silently; mixed with another value
      // it is invalid. Neither a sign-in nor a consent screen is shown.
      const prompt = (url.searchParams.get('prompt') ?? '').split(' ');
      const silent = prompt.includes('none');
      if (silent && prompt.length > 1) return redirectTo(api.refuseSilently('invalid_request'));
      if (!auth.ok) {
        return silent
          ? redirectTo(api.refuseSilently('login_required'))
          : toLogin(c, auth, `${OAUTH_AUTHORIZE_PATH}${url.search}`);
      }
      const principal = auth.principal;
      // A remembered approval answers at once (never for HEAD: nothing is issued for a request whose answer is
      // discarded; never when the client asks for the page with `prompt=consent` / `login`). It goes through
      // `approve()` like a click on Allow; if that fails the row is dropped and the page is shown.
      // A request for `mcp:write` (P7-09) is never answered from memory or silently: the user decides every time.
      const writeRequested = api.request.scope.includes(MCP_WRITE_SCOPE);
      if (silent && writeRequested) return redirectTo(api.refuseSilently('consent_required'));
      if (
        c.req.method === 'GET' &&
        !writeRequested &&
        !prompt.includes('consent') &&
        !prompt.includes('login')
      ) {
        const id = await approvalId(api);
        const stored = await remembered(principal.userId, id, api);
        if (stored !== null) {
          const result: OAuthApproval = await api.approve({
            userId: principal.userId,
            grantId: stored.grantId,
            label: stored.label,
          });
          if (result.ok) {
            consentAudit(c, 'oauth.consent.approve', principal, api, {
              grantId: stored.grantId,
              remembered: 'used',
              granted: result.scope,
            });
            return redirectTo(result.redirectTo);
          }
          await kv.delete(rememberKey(principal.userId, id));
          consentAudit(c, 'oauth.consent.approve', principal, api, {
            grantId: stored.grantId,
            status: 'denied',
            errorCode: result.reason,
            remembered: 'used',
          });
          if (result.reason === 'client_refused') return clientRefusedPage(c, principal, api);
        }
      }
      if (silent) return redirectTo(api.refuseSilently('consent_required'));
      return renderPage(c, principal, api);
    },

    async decide(c, runtime) {
      const url = new URL(c.req.url);
      const auth = await sessions.authenticate(c);
      if (!auth.ok) return toLogin(c, auth, `${OAUTH_AUTHORIZE_PATH}${url.search}`);
      const principal = auth.principal;
      // Origin and fetch metadata first: a cross-site post is refused before its body is read or the client resolved.
      const problem = sessions.checkFetchOrigin(c, true);
      if (problem !== null) return forbidden(c, principal, problem);
      if (!FORM_TYPE.test(c.req.header('content-type') ?? ''))
        return errorPage(415, requestIdOf(c), principal);
      const text = await readCapped(c.req.raw, DEFAULT_MAX_FORM_BYTES);
      if (text === null) return errorPage(413, requestIdOf(c), principal);
      const fields = new URLSearchParams(text);
      const tokens = fields.getAll(CSRF_FIELD);
      if (tokens.length !== 1 || !sessions.csrfMatches(principal, tokens[0])) {
        return forbidden(c, principal, 'csrf');
      }
      // The request is validated again from the URL the form posted to: client, redirect URI, PKCE, resource.
      const prepared = await runtime.prepare(c, url.searchParams);
      if (prepared instanceof Response) return prepared;
      const api = prepared;
      const decision = single(fields, CONSENT_FIELDS.decision);
      if (decision === 'deny') {
        await kv.delete(rememberKey(principal.userId, await approvalId(api)));
        consentAudit(c, 'oauth.consent.deny', principal, api, {});
        return leaveTo(c, api.deny());
      }
      if (decision !== 'approve') {
        return renderPage(c, principal, api, 422, { error: 'Choose Allow or Deny.' });
      }
      const grantId = single(fields, CONSENT_FIELDS.grant);
      const rawLabel = single(fields, CONSENT_FIELDS.label) ?? '';
      const labelText = rawLabel.trim();
      const label = labelText === '' ? null : deviceLabel(labelText);
      const keep = { ...(grantId === null ? {} : { selected: grantId }) };
      if (
        labelText !== '' &&
        (label === null || labelText.length > Math.min(CONSENT_LABEL_MAX, MAX_DEVICE_LABEL_CHARS))
      ) {
        return renderPage(c, principal, api, 422, {
          ...keep,
          error: `The device name must be at most ${CONSENT_LABEL_MAX} characters of plain text.`,
        });
      }
      // Only one of the user's own usable grants on this project: a forged or stale id never reaches `approve()`.
      const { projectId, options } = await usableGrants(principal.userId, api.request.projectSlug);
      const grant = options.find((g) => g.id === grantId);
      if (grant === undefined) {
        if (grantId !== null) {
          consentAudit(c, 'oauth.consent.approve', principal, api, {
            projectId,
            status: 'denied',
            errorCode: 'grant_not_offered',
          });
        }
        return renderPage(c, principal, api, 422, {
          ...(label === null ? {} : { label }),
          error: 'Choose one of your accesses on this project.',
        });
      }
      const writeRequested = api.request.scope.includes(MCP_WRITE_SCOPE);
      const result = await api.approve({
        userId: principal.userId,
        grantId: grant.id,
        label,
        write: writeRequested && single(fields, CONSENT_FIELDS.write) === '1',
      });
      if (!result.ok) {
        consentAudit(c, 'oauth.consent.approve', principal, api, {
          grantId: grant.id,
          projectId,
          status: 'denied',
          errorCode: result.reason,
        });
        if (result.reason === 'client_refused') return clientRefusedPage(c, principal, api);
        return messagePage(
          c,
          409,
          'Access can’t be used',
          ['This access can no longer be used (it may have been revoked). Connect the app again.'],
          principal,
        );
      }
      // An approval that involved `mcp:write` is never remembered (P7-09), nor one for a dynamic client (P8-65).
      const saved =
        !writeRequested &&
        remembersClient(api) &&
        single(fields, CONSENT_FIELDS.remember) === '1' &&
        (await remember(principal, api, grant, label));
      consentAudit(c, 'oauth.consent.approve', principal, api, {
        grantId: grant.id,
        projectId,
        remembered: saved ? 'saved' : false,
        granted: result.scope,
      });
      return leaveTo(c, result.redirectTo);
    },

    async approvals(c) {
      if (pageFetchProblem(c) !== null) return errorPage(403, requestIdOf(c));
      const auth = await sessions.authenticate(c);
      if (!auth.ok) return toLogin(c, auth, OAUTH_APPROVALS_PATH);
      const principal = auth.principal;
      const prefix = `${REMEMBER_PREFIX}${principal.userId}:`;
      const keys = (await kv.list({ prefix, limit: MAX_REMEMBERED_APPROVALS })).keys;
      const rows: RememberedApproval[] = [];
      for (const k of keys) {
        const stored = parseStored(await kv.get(k.name));
        const id = k.name.slice(prefix.length);
        // Rows of dynamic clients (stored before P8-65) are no longer honoured, so they are not listed either.
        if (
          stored === null ||
          stored.expiresAt <= clock.now() ||
          stored.clientKind !== 'metadata_document' ||
          !APPROVAL_ID_RE.test(id)
        )
          continue;
        rows.push({
          id,
          client: {
            name: stored.clientName,
            kind: stored.clientKind,
            host: stored.clientHost,
            redirectHost: stored.redirectHost,
          },
          projectSlug: stored.projectSlug,
          grantLabel: stored.grantLabel,
          expiresAt: stored.expiresAt,
        });
      }
      return htmlResponse(
        ApprovalsPage({
          viewer: principal,
          approvals: rows,
          forgetAction: OAUTH_APPROVALS_FORGET_PATH,
          notice: c.req.query('forgotten') === '1' ? 'The app will ask again next time.' : undefined,
        }),
      );
    },

    async forget(c) {
      const auth = await sessions.authenticate(c);
      if (!auth.ok) return toLogin(c, auth, OAUTH_APPROVALS_PATH);
      const principal = auth.principal;
      const problem = sessions.checkFetchOrigin(c, true);
      if (problem !== null) return forbidden(c, principal, problem);
      if (!FORM_TYPE.test(c.req.header('content-type') ?? ''))
        return errorPage(415, requestIdOf(c), principal);
      const text = await readCapped(c.req.raw, DEFAULT_MAX_FORM_BYTES);
      if (text === null) return errorPage(413, requestIdOf(c), principal);
      const fields = new URLSearchParams(text);
      const tokens = fields.getAll(CSRF_FIELD);
      if (tokens.length !== 1 || !sessions.csrfMatches(principal, tokens[0])) {
        return forbidden(c, principal, 'csrf');
      }
      const id = single(fields, 'id');
      // Only the caller's own rows exist under their prefix: any other id is simply not there.
      if (id === null || !APPROVAL_ID_RE.test(id)) return errorPage(404, requestIdOf(c), principal);
      const key = rememberKey(principal.userId, id);
      if ((await kv.get(key)) === null) return errorPage(404, requestIdOf(c), principal);
      await kv.delete(key);
      audit(c, {
        actor: { requestId: requestIdOf(c) ?? null, userId: principal.userId },
        action: 'oauth.consent.forget',
        targetType: 'oauth_approval',
        targetId: id,
      });
      return new Response(null, {
        status: 303,
        headers: { Location: `${OAUTH_APPROVALS_PATH}?forgotten=1` },
      });
    },
  };
}
