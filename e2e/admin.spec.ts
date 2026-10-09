// SPDX-License-Identifier: Apache-2.0
// P4-11: the admin panel in a real Chromium. The same personal setup as the HTTP test of P4-04 (2 keys US/EU,
// 2 projects, 3 device tokens), done by clicking, at 1280 px and at 320 px. Every page load is checked for CSP and
// Trusted Types violations, console errors and uncaught errors. With RB_E2E_SCREENSHOTS=1 (desktop run only) the
// admin guide's screenshots are written to docs/guide/images, in light and dark.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  FAKE_KEY_EU,
  FAKE_KEY_MEMBER,
  FAKE_KEY_US,
  MEMBER_EMAIL,
  OWNER_EMAIL,
  startServer,
  type TestServer,
} from './server.ts';
import { watch } from './watch.ts';

const IMAGES = fileURLToPath(new URL('../docs/guide/images/', import.meta.url));
/** Pages also shown at phone width in the guide. */
const PHONE_SHOTS = new Set(['overview', 'token-once', 'projects']);
const SHOOT = process.env['RB_E2E_SCREENSHOTS'] === '1';

/** A page whose layout fits the viewport: nothing wider than the screen. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(0);
}

/** Opens a page and checks it fits the viewport (the 320 px promise). */
async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path.startsWith('/') ? `${server.base}${path}` : path);
  await expectNoHorizontalScroll(page);
}

/** Chooses the option whose text matches (option texts carry key suffixes and ids). */
async function pick(select: Locator, text: RegExp): Promise<void> {
  const options = await select.locator('option').allInnerTexts();
  const hit = options.find((o) => text.test(o));
  if (hit === undefined) throw new Error(`no option matches ${text}: ${options.join(' | ')}`);
  await select.selectOption({ label: hit });
}

/** Light and dark screenshots for the guide. `hide` masks anything that looks like a secret, even a fake one. */
async function shoot(page: Page, name: string, hide: Locator[] = []): Promise<void> {
  if (!SHOOT) return;
  const mobile = (page.viewportSize()?.width ?? 1280) < 600;
  if (mobile && !PHONE_SHOTS.has(name)) return;
  mkdirSync(IMAGES, { recursive: true });
  const schemes = mobile ? (['light'] as const) : (['light', 'dark'] as const);
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: join(IMAGES, `${name}${mobile ? '-phone' : ''}-${scheme}.png`),
      fullPage: true,
      animations: 'disabled',
      mask: hide,
      maskColor: '#7a7a7a',
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

let server: TestServer;
test.beforeAll(async () => {
  server = await startServer();
});
test.afterAll(async () => {
  await server?.stop();
});

test('owner: sign-in, keys, projects, grants, tokens, connect, audit, my access, unbind', async ({
  page,
  context,
}, info) => {
  const w = await watch(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
  const rel = (path: string) => `${server.base}${path}`;
  const mobile = info.project.name.startsWith('mobile');

  await test.step('setup link makes the first sign-in the owner', async () => {
    await page.goto(await server.setupLink());
    await expect(page).toHaveURL(rel('/admin'));
    await expect(page.getByText(OWNER_EMAIL).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shoot(page, 'overview');
  });

  await test.step('sign out, then sign in again from the login page', async () => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
    await page.waitForURL((u) => u.pathname !== '/admin');
    await visit(page, '/admin');
    await expect(page).toHaveURL(/\/auth\/login/);
    await shoot(page, 'sign-in');
    await page.getByRole('link', { name: /^Sign in with/ }).click();
    await expect(page).toHaveURL(rel('/admin'));
  });

  const keys: string[] = [];
  await test.step('two keys: Work US and Work EU', async () => {
    for (const [name, region, key] of [
      ['Work US', 'US', FAKE_KEY_US],
      ['Work EU', 'EU', FAKE_KEY_EU],
    ] as const) {
      await visit(page, '/admin/credentials/new');
      if (name === 'Work US') await shoot(page, 'key-add');
      await page.getByLabel('Name', { exact: true }).fill(name);
      await page.getByLabel('Region', { exact: true }).selectOption(region);
      await page.getByLabel('User API key', { exact: true }).fill(key);
      await page.getByRole('button', { name: 'Check and add' }).click();
      await expect(page.getByText('Key added. New Relic accepted it.')).toBeVisible();
      await expect(page.getByText(`•••• ${key.slice(-4)}`).first()).toBeVisible();
      await expect(page.getByText(key)).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      keys.push(page.url());
      if (name === 'Work US') await shoot(page, 'key-detail');
    }
    await visit(page, '/admin/credentials');
    await expect(page.getByRole('link', { name: 'Work US' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Work EU' })).toBeVisible();
    await shoot(page, 'keys');
  });

  await test.step('two projects', async () => {
    await visit(page, '/admin/projects/new');
    await pick(page.getByLabel('Default key', { exact: true }), /Work US/);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Allowed accounts', { exact: true })).toBeVisible();
    await page.getByLabel('Slug', { exact: true }).fill('work-us');
    await page.getByLabel('Display name (optional)', { exact: true }).fill('Work (US)');
    await page.locator('input[name="accounts"][value="1000001"]').check();
    await page.locator('input[name="accounts"][value="1000002"]').check();
    await page.getByLabel('Default account', { exact: true }).selectOption('1000001');
    await shoot(page, 'project-new');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByText(rel('/p/work-us/mcp')).first()).toBeVisible();
    await shoot(page, 'project-detail');

    await visit(page, '/admin/projects/new');
    await pick(page.getByLabel('Default key', { exact: true }), /Work EU/);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Slug', { exact: true }).fill('work-eu');
    await page.locator('input[name="accounts"][value="2000001"]').check();
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByText(rel('/p/work-eu/mcp')).first()).toBeVisible();
    await visit(page, '/admin/projects');
    await shoot(page, 'projects');
  });

  const grantUrls: string[] = [];
  await test.step('a grant for the owner on each project', async () => {
    for (const slug of ['work-us', 'work-eu']) {
      await visit(page, '/admin/grants/new');
      await pick(page.getByLabel('Project', { exact: true }), new RegExp(slug));
      await page.getByRole('button', { name: 'Next' }).click();
      await pick(page.getByLabel('For', { exact: true }), new RegExp(OWNER_EMAIL));
      await page.getByLabel('Label', { exact: true }).fill(`me on ${slug}`);
      if (slug === 'work-us') await shoot(page, 'grant-new');
      await page.getByRole('button', { name: 'Create grant' }).click();
      await expect(page.getByText(`me on ${slug}`).first()).toBeVisible();
      grantUrls.push(page.url());
    }
    await visit(page, '/admin/grants');
    await shoot(page, 'grants');
  });

  const tokens: string[] = [];
  await test.step('three device tokens, each shown once; the copy button works', async () => {
    for (const [i, device] of ['laptop', 'phone', 'laptop'].entries()) {
      await visit(page, `/admin/tokens/new?grant=${grantUrls[i === 2 ? 1 : 0]?.split('/').pop()}`);
      await page.getByLabel('Device name', { exact: true }).fill(device);
      if (i === 0) await shoot(page, 'token-new');
      await page.getByRole('button', { name: 'Create token' }).click();
      const token = (await page.locator('#token').innerText()).trim();
      expect(token).toMatch(/^rb_/);
      tokens.push(token);
      await expectNoHorizontalScroll(page);
      if (i === 0) {
        const copy = page.getByRole('button', { name: 'Copy' }).first();
        await expect(copy).toBeVisible();
        await copy.click();
        await expect(page.getByRole('button', { name: 'Copied' }).first()).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
        // Screenshot: the real value is masked, so no token (even a throw-away one) ends up in the repository.
        await shoot(page, 'token-once', [page.locator('#token'), page.locator('pre')]);
      }
      // Reloading re-sends the form: no second token, and the token is not shown again.
      await page.reload().catch(() => undefined);
    }
    expect(new Set(tokens).size).toBe(3);
    await visit(page, '/admin/tokens');
    await expect(page.getByText(tokens[0] as string)).toHaveCount(0);
    await shoot(page, 'tokens');
  });

  await test.step('the connect page lists client snippets', async () => {
    await visit(page, '/admin/connect');
    await expect(page.getByText(rel('/p/work-us/mcp')).first()).toBeVisible();
    await shoot(page, 'connect', [page.locator('pre')]);
  });

  await test.step('the audit viewer shows what happened', async () => {
    await visit(page, '/admin/audit');
    await expect(page.locator('body')).toContainText(/login/i);
    await shoot(page, 'audit');
    await visit(page, '/admin/usage');
  });

  await test.step('my access (the owner is a user too)', async () => {
    await visit(page, '/admin/me');
    await shoot(page, 'my-access');
  });

  let memberUserPage = '';
  await test.step('invite a member and give them a grant', async () => {
    await visit(page, '/admin/users/new');
    await page.getByLabel('Email', { exact: true }).fill(MEMBER_EMAIL);
    await page.getByLabel('Name (optional)', { exact: true }).fill('Mia Member');
    await page.getByLabel('Role', { exact: true }).selectOption('member');
    await page.getByRole('button', { name: 'Add user' }).click();
    await expect(page.getByText(MEMBER_EMAIL).first()).toBeVisible();
    memberUserPage = page.url();
    await visit(page, '/admin/grants/new');
    await pick(page.getByLabel('Project', { exact: true }), /work-us/);
    await page.getByRole('button', { name: 'Next' }).click();
    await pick(page.getByLabel('For', { exact: true }), new RegExp(MEMBER_EMAIL));
    await page.getByRole('button', { name: 'Create grant' }).click();
    await expect(page.getByText(MEMBER_EMAIL).first()).toBeVisible();
    await visit(page, '/admin/users');
    await shoot(page, 'users');
  });

  await test.step('a member signs in: own keys, grants and tokens only', async () => {
    const memberCtx = await page
      .context()
      .browser()
      ?.newContext({
        viewport: page.viewportSize(),
        ...(mobile ? { isMobile: true, hasTouch: true } : {}),
      });
    if (!memberCtx) throw new Error('no browser');
    await memberCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
    const mp = await memberCtx.newPage();
    const mw = await watch(mp);
    server.idp.user = { sub: 'member-sub', email: MEMBER_EMAIL, email_verified: true, name: 'Mia Member' };
    try {
      await mp.goto(rel('/auth/login'));
      await mp.getByRole('link', { name: /^Sign in with/ }).click();
      await expect(mp).toHaveURL(rel('/admin'));
      await visit(mp, '/admin/me');
      await shoot(mp, 'member-my-access');
      await expect(mp.getByText('Work')).not.toHaveCount(0);

      await visit(mp, '/admin/me/keys/new');
      await mp.getByLabel('Name', { exact: true }).fill('My key');
      await mp.getByLabel('Region', { exact: true }).selectOption('US');
      await mp.getByLabel('User API key', { exact: true }).fill(FAKE_KEY_MEMBER);
      await mp.getByRole('button', { name: 'Check and add' }).click();
      await expect(mp.getByText('Key added. New Relic accepted it.')).toBeVisible();
      await shoot(mp, 'member-key');

      // Admin screens answer 403 to a member.
      const denied = await mp.goto(rel('/admin/credentials'));
      expect(denied?.status()).toBe(403);
      mw.expectStatus(403); // the browser logs the deliberate 403 as a console error
      mw.assertClean();
    } finally {
      server.idp.user = { sub: 'owner-sub', email: OWNER_EMAIL, email_verified: true, name: 'Olive Owner' };
      await memberCtx.close();
    }
  });

  await test.step('unbind needs a confirmation with the typed email and warns about takeover', async () => {
    await page.goto(`${memberUserPage}/unbind`);
    await expect(page.getByText(/take ?over/i).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shoot(page, 'unbind');
    await page
      .getByLabel("Type the user's email address to confirm", { exact: true })
      .fill('wrong@example.com');
    await page.getByRole('button', { name: 'Clear sign-in identity' }).click();
    await expect(page.getByText('That is not this user’s email address.')).toBeVisible();
    w.expectStatus(422); // the deliberate refusal
    await page.getByLabel("Type the user's email address to confirm", { exact: true }).fill(MEMBER_EMAIL);
    await page.getByRole('button', { name: 'Clear sign-in identity' }).click();
    await expect(page).toHaveURL(memberUserPage);
  });

  // The whole run: no CSP or Trusted Types violation, no console error, no uncaught error.
  expect(w.problems).toEqual([]);
});
