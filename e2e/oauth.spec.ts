// SPDX-License-Identifier: Apache-2.0
// P5-04: OAuth for MCP clients in a real Chromium, against the built `serve` with `RB_OAUTH=on`. A dynamically
// registered client with a loopback redirect (like Claude Code or an MCP inspector) authorizes: the browser is sent to
// sign-in, comes back to the consent page, approves, and lands on the client's callback with a code; the code becomes
// a token that lists the project's tools. Then the deny path, a remembered approval and forgetting it. Every page is
// checked for CSP violations (the consent form posts to us and is answered with a redirect to the client, which
// `form-action` must allow), console errors and horizontal overflow at 1280 px and 320 px. With RB_E2E_SCREENSHOTS=1
// the guide's consent screenshots are written to docs/guide/images.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { FAKE_KEY_US, OWNER_EMAIL, startServer, type TestServer } from './server.ts';
import { watch } from './watch.ts';

const IMAGES = fileURLToPath(new URL('../docs/guide/images/', import.meta.url));
const SHOOT = process.env['RB_E2E_SCREENSHOTS'] === '1';
const SLUG = 'phone-test';

let server: TestServer;
let callback: Server;
let callbackBase: string;
/** Query strings the client's callback received, newest last. */
const received: URLSearchParams[] = [];

test.beforeAll(async () => {
  server = await startServer({ RB_OAUTH: 'on' });
  callback = createServer((req, res) => {
    received.push(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="en"><title>Client callback</title><p>Back in the app.</p></html>');
  });
  await new Promise<void>((r) => callback.listen(0, '127.0.0.1', () => r()));
  callbackBase = `http://127.0.0.1:${(callback.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  await server?.stop();
  await new Promise<void>((r) => (callback ? callback.close(() => r()) : r()));
});

async function api(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${server.base}/api/admin/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${server.adminToken}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: unknown }).data;
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(0);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOOT) return;
  const mobile = (page.viewportSize()?.width ?? 1280) < 600;
  mkdirSync(IMAGES, { recursive: true });
  for (const scheme of mobile ? (['light'] as const) : (['light', 'dark'] as const)) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: join(IMAGES, `${name}${mobile ? '-phone' : ''}-${scheme}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const b64u = (b: Buffer): string => b.toString('base64url');

test('OAuth: sign-in, consent, code at a loopback callback, token, deny, remember and forget', async ({
  page,
}) => {
  const w = await watch(page);
  const redirectUri = `${callbackBase}/callback`;

  // Setup through the admin API: the owner signs in once (setup link), then a key, a project and their grant.
  await page.goto(await server.setupLink());
  await expect(page).toHaveURL(`${server.base}/auth/login?provider=oidc`);
  await page.getByRole('link', { name: /^Sign in with/ }).click();
  await expect(page).toHaveURL(`${server.base}/admin`);
  const users = (await api('/users')) as { id: string; email: string }[];
  const ownerId = users.find((u) => u.email === OWNER_EMAIL)?.id as string;
  const cred = (await api('/credentials', { label: 'Work US', region: 'US', apiKey: FAKE_KEY_US })) as {
    id: string;
  };
  const project = (await api('/projects', {
    slug: SLUG,
    name: 'Phone test',
    defaultAccountId: 1000001,
    allowedAccountIds: [1000001, 1000002],
    defaultCredentialId: cred.id,
  })) as { id: string };
  await api('/grants', { projectId: project.id, userId: ownerId, label: 'Read-only on Phone test' });
  // Signed out: the authorization starts from scratch, as on a phone.
  await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
  await page.waitForURL((u) => u.pathname !== '/admin');

  // The client registers itself (RFC 7591), like an MCP client that has no metadata document.
  const reg = await fetch(`${server.base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'E2E Inspector',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(reg.status).toBe(201);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const resource = `${server.base}/p/${SLUG}/mcp`;
  const authorizeUrl = (state: string) => {
    const verifier = b64u(randomBytes(32));
    const u = new URL(`${server.base}/oauth/authorize`);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: 'mcp:read offline_access',
      code_challenge: b64u(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      resource,
    }).toString();
    return { url: u.toString(), verifier };
  };

  await test.step('authorize → sign-in → consent page', async () => {
    const { url } = authorizeUrl('st-1');
    await page.goto(url);
    await expect(page).toHaveURL(/\/auth\/login\?next=%2Foauth%2Fauthorize/);
    await page.getByRole('link', { name: /^Sign in with/ }).click();
    await expect(page.getByRole('heading', { name: 'Connect an app', level: 1 })).toBeVisible();
    await expect(page.locator('.consent-client')).toHaveText('E2E Inspector');
    await expect(page.getByText('not verified')).toBeVisible();
    await expect(page.locator('.consent-host').first()).toHaveText(new URL(callbackBase).host);
    await expect(page.getByText('a program on the computer')).toBeVisible();
    await expect(page.getByText('Phone test (phone-test)')).toBeVisible();
    await expect(page.getByLabel('Read-only on Phone test')).toBeChecked();
    await expectNoHorizontalScroll(page);
    await shoot(page, 'oauth-consent');
  });

  let verifier = '';
  await test.step('allow: the client gets a code, the code a token, the token the project’s tools', async () => {
    // The step above opened the page from a fresh authorize URL; use its verifier by restarting signed in.
    const started = authorizeUrl('st-2');
    verifier = started.verifier;
    await page.goto(started.url);
    await page.getByLabel('Device name (optional)').fill('E2E laptop – inspector');
    await page.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL((u) => u.href.startsWith(redirectUri));
    const params = received.at(-1) as URLSearchParams;
    expect(params.get('state')).toBe('st-2');
    expect(params.get('iss')).toBe(server.base);
    const code = params.get('code') as string;
    expect(code).toBeTruthy();
    const tok = await fetch(`${server.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource,
      }).toString(),
    });
    expect(tok.status).toBe(200);
    const access = ((await tok.json()) as { access_token: string }).access_token;
    const list = await fetch(resource, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('run_nrql');
  });

  await test.step('deny: access_denied at the callback, no code', async () => {
    await page.goto(authorizeUrl('st-3').url);
    await page.getByRole('button', { name: 'Deny' }).click();
    await page.waitForURL((u) => u.href.startsWith(redirectUri));
    const params = received.at(-1) as URLSearchParams;
    expect(params.get('error')).toBe('access_denied');
    expect(params.get('state')).toBe('st-3');
    expect(params.get('code')).toBeNull();
  });

  await test.step('remember: the next authorization skips the page; forgetting brings it back', async () => {
    await page.goto(authorizeUrl('st-4').url);
    await page.getByLabel('Don’t ask again for this app').check();
    await page.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL((u) => u.href.startsWith(redirectUri));
    await page.goto(authorizeUrl('st-5').url);
    await page.waitForURL((u) => u.href.startsWith(redirectUri));
    expect(received.at(-1)?.get('state')).toBe('st-5');
    expect(received.at(-1)?.get('code')).toBeTruthy();

    await page.goto(`${server.base}/oauth/approvals`);
    await expect(page.getByRole('cell', { name: 'E2E Inspector not verified' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shoot(page, 'oauth-approvals');
    await page.getByRole('button', { name: 'Forget' }).click();
    await expect(page.getByText('The app will ask again next time.')).toBeVisible();
    await page.goto(authorizeUrl('st-6').url);
    await expect(page.getByRole('heading', { name: 'Connect an app', level: 1 })).toBeVisible();
  });

  w.assertClean();
});
