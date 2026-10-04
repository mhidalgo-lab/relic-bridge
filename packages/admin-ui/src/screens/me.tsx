// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// "My access" (P4-15, THREAT_MODEL T3/T13/T14): the signed-in person's own New Relic keys (bring your own key), grants
// and device tokens, on top of the P4-10 `/me/*` API. Every role may use these pages. They hold no ownership logic:
// each call goes to the `/me/*` API, which looks rows up as the session user, and a page or form naming an id that is
// not in the caller's own lists gets the 404 page before (and again at) the API. Nothing here reads another user's rows.
//
//   GET  /admin/me                      overview: my grants, keys and device tokens
//   GET  /admin/me/keys/new             add a key (password field, never shown again)
//   POST /admin/me/keys                 add
//   GET  /admin/me/keys/:id             one key
//   POST /admin/me/keys/:id/rename|revalidate|delete
//   GET|POST /admin/me/keys/:id/rotate  replace the key (needs the confirmation box)
//   GET|POST /admin/me/grants/:id       choose which of my keys the grant uses (or the project default)
//   GET  /admin/me/tokens/new[?grant=]  step 1: choose the grant, step 2: device name and lifetime
//   POST /admin/me/tokens               issue → the one-time page (single-use form handle)
//   POST /admin/me/tokens/:id/revoke    revoke (needs confirm=yes)
import type { Context, Hono } from 'hono';
import {
  Button,
  Checkbox,
  ConfirmAction,
  DataTable,
  Facts,
  Form,
  Layout,
  LinkButton,
  QueryForm,
  SelectField,
  TextField,
} from '../components.tsx';
import type { FlashMessage } from '../flash.ts';
import { adminPath, ONCE_FIELD, requestIdOf, type UiKit, type UiPrincipal } from '../kit.ts';
import { errorPage, htmlResponse } from '../pages.tsx';
import { maskedKey, validationBadge } from './credentials.tsx';
import {
  type Credential,
  isId,
  type MyGrant,
  one,
  parseCredential,
  parseMyGrant,
  parseToken,
  REGIONS,
  type Token,
} from './data.ts';
import { endpointOf } from './projects.tsx';
import {
  confirmed,
  confirmPage,
  FormError,
  field,
  flashFor,
  formMessage,
  isOk,
  lifecycle,
  listAll,
  problemOf,
  RowAction,
  StatusBadge,
  When,
  withQuery,
} from './shared.tsx';
import { IssuedTokenPage, LIFETIMES } from './tokens.tsx';

const idOf = (c: Context): string => c.req.param('id') ?? '';

const BASE = '/admin/me';
const ROUTE = '/me';
const KEYS = `${BASE}/keys`;
const MAX_KEY_CHARS = 200;
/** Mirrors the P4-10 caps (the API enforces them; these only explain them). */
export const MAX_OWN_KEYS = 10;
export const MAX_LIVE_TOKENS_PER_GRANT = 20;

const keyPath = (id: string): string => `${KEYS}${adminPath`/${id}`}`;

/** A key a grant can use: not revoked and not refused by New Relic. */
const usable = (c: Credential): boolean => c.revokedAt === null && c.validationStatus !== 'invalid';

const projectText = (g: MyGrant): string => g.project?.name ?? g.project?.slug ?? g.projectId;

function grantStatus(g: MyGrant, now: number) {
  const base = lifecycle(g, now);
  if (base.text === 'active' && g.project?.disabled === true)
    return { tone: 'muted' as const, text: 'project disabled' };
  return base;
}

// ---------------------------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------------------------

function addKeyPage(
  viewer: UiPrincipal,
  values: { label?: string; region?: string },
  errors: Readonly<Record<string, string>>,
  message?: string,
) {
  return (
    <Layout title="Add my New Relic key" viewer={viewer} current={BASE}>
      <p>
        This key is yours: only you can see it listed or use it, and only on grants assigned to you. It is
        checked with New Relic before it is saved, then stored encrypted. It is never shown again: pages show
        its last 4 characters only. You can keep up to {MAX_OWN_KEYS} keys.
      </p>
      <FormError message={message} />
      <Form action={KEYS} csrf={viewer.csrf} label="Add my New Relic key">
        <TextField
          name="label"
          label="Name"
          hint="Something you recognise, e.g. My work account."
          value={values.label}
          required
          maxlength={100}
          error={errors['label']}
        />
        <SelectField
          name="region"
          label="Region"
          hint="Where the New Relic account lives (US, EU or JP data center)."
          value={values.region ?? 'US'}
          required
          error={errors['region']}
          options={REGIONS.map((r) => ({ value: r, label: r }))}
        />
        <TextField
          name="apiKey"
          label="User API key"
          hint="A New Relic User key (it starts with NRAK-). Paste it here only; it is never shown again."
          type="password"
          autocomplete="off"
          spellcheck={false}
          required
          maxlength={MAX_KEY_CHARS}
          error={errors['apiKey']}
        />
        <div class="actions">
          <Button>Check and add</Button>
          <LinkButton href={BASE} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

function keyPage(
  viewer: UiPrincipal,
  cred: Credential,
  grants: readonly MyGrant[],
  opts: { flash?: FlashMessage | null; renameError?: string | undefined; label?: string | undefined } = {},
) {
  const self = keyPath(cred.id);
  const using = grants.filter((g) => g.credentialId === cred.id);
  return (
    <Layout title={`My key: ${cred.label}`} viewer={viewer} current={BASE} flash={opts.flash ?? null}>
      <section class="card" aria-labelledby="facts-heading">
        <h2 id="facts-heading">About this key</h2>
        <Facts
          items={[
            ['Name', cred.label],
            ['Region', cred.region],
            ['Key', <code>{maskedKey(cred.keyHint)}</code>],
            ['Status', validationBadge(cred)],
            ['Last checked', <When at={cred.validatedAt} none="never" />],
            ['New Relic user', cred.nrUserEmail ?? '—'],
            [
              'Reachable accounts',
              cred.reachableAccountIds === null
                ? 'unknown (not checked yet)'
                : cred.reachableAccountIds.length === 0
                  ? 'none'
                  : cred.reachableAccountIds.join(', '),
            ],
            ['Added', <When at={cred.createdAt} />],
          ]}
        />
        <div class="actions">
          <Form action={`${self}/revalidate`} csrf={viewer.csrf} label="Check again">
            <Button variant="secondary">Check again with New Relic</Button>
          </Form>
          <LinkButton href={`${self}/rotate`} variant="secondary">
            Replace the key
          </LinkButton>
        </div>
      </section>

      <section aria-labelledby="usage-heading">
        <h2 id="usage-heading">Used by</h2>
        {using.length === 0 ? (
          <p>None of your grants uses this key.</p>
        ) : (
          <ul>
            {using.map((g) => (
              <li>
                <a href={adminPath`/admin/me/grants/${g.id}`}>{g.label ?? projectText(g)}</a> on{' '}
                {projectText(g)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="rename-heading">
        <h2 id="rename-heading">Rename</h2>
        <Form action={`${self}/rename`} csrf={viewer.csrf} label="Rename">
          <TextField
            name="label"
            label="Name"
            value={opts.label ?? cred.label}
            required
            maxlength={100}
            error={opts.renameError}
          />
          <Button>Save name</Button>
        </Form>
      </section>

      <section aria-labelledby="delete-heading">
        <h2 id="delete-heading">Delete</h2>
        <p>Deleting removes the encrypted key. It is refused while one of your grants still uses it.</p>
        <ConfirmAction
          action={`${self}/delete`}
          csrf={viewer.csrf}
          summary="Delete this key…"
          confirm={`Delete ${cred.label} for good`}
        >
          <p>This cannot be undone.</p>
        </ConfirmAction>
      </section>
    </Layout>
  );
}

function rotatePage(
  viewer: UiPrincipal,
  cred: Credential,
  errors: Readonly<Record<string, string>>,
  message?: string,
) {
  return (
    <Layout title={`Replace my key: ${cred.label}`} viewer={viewer} current={BASE}>
      <p>
        The new key is checked with New Relic first. If New Relic accepts it, it replaces{' '}
        <code>{maskedKey(cred.keyHint)}</code> on every grant of yours that uses it. Revoke the old key in New
        Relic afterwards.
      </p>
      <FormError message={message} />
      <Form action={`${keyPath(cred.id)}/rotate`} csrf={viewer.csrf} label="Replace my key">
        <TextField
          name="apiKey"
          label="New User API key"
          hint="Starts with NRAK-. It is never shown again."
          type="password"
          autocomplete="off"
          spellcheck={false}
          required
          maxlength={MAX_KEY_CHARS}
          error={errors['apiKey']}
        />
        <div class="field">
          {errors['confirm'] ? (
            <p class="error" id="confirm-error">
              {errors['confirm']}
            </p>
          ) : null}
          <Checkbox
            name="confirm"
            id="confirm"
            value="yes"
            label="Replace the key on every grant of mine that uses it"
          />
        </div>
        <div class="actions">
          <Button variant="danger">Check and replace</Button>
          <LinkButton href={keyPath(cred.id)} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

function grantPage(
  viewer: UiPrincipal,
  grant: MyGrant,
  keys: readonly Credential[],
  error?: string,
  message?: string,
) {
  const choices = keys.filter((k) => usable(k) || k.id === grant.credentialId);
  return (
    <Layout title={`My grant: ${grant.label ?? projectText(grant)}`} viewer={viewer} current={BASE}>
      <p>
        Project <strong>{projectText(grant)}</strong>. An administrator decides which tools and accounts this
        grant allows. You choose which New Relic key it uses: your own, or the project's default.
      </p>
      <FormError message={message} />
      <Form action={adminPath`/admin/me/grants/${grant.id}`} csrf={viewer.csrf} label="Key for this grant">
        <SelectField
          name="credentialId"
          label="Key"
          value={grant.credentialId ?? ''}
          error={error}
          hint={
            keys.length === 0
              ? 'You have no keys yet: add one first.'
              : 'Keys New Relic refused cannot be chosen: replace them first.'
          }
          options={[
            { value: '', label: 'The project default' },
            ...choices.map((k) => ({
              value: k.id,
              label: `${k.label} (${k.region}, ${maskedKey(k.keyHint)})`,
            })),
          ]}
        />
        <div class="actions">
          <Button>Save</Button>
          <LinkButton href={BASE} variant="secondary">
            Cancel
          </LinkButton>
          <LinkButton href={`${KEYS}/new`} variant="secondary">
            Add a key
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

function newTokenPage(
  viewer: UiPrincipal,
  grant: MyGrant,
  values: { label: string; lifetime: string },
  errors: Readonly<Record<string, string>>,
  once: string,
  message?: string,
) {
  return (
    <Layout title="New device token" viewer={viewer} current={BASE}>
      <p>
        For <strong>{grant.label ?? projectText(grant)}</strong> on {projectText(grant)}. One token per
        device, so you can revoke a lost laptop or phone alone (up to {MAX_LIVE_TOKENS_PER_GRANT} live tokens
        per grant). <a href={`${BASE}/tokens/new`}>Choose another grant</a>
      </p>
      <FormError message={message} />
      <Form action={`${BASE}/tokens`} csrf={viewer.csrf} label="New device token">
        <input type="hidden" name="grantId" value={grant.id} />
        <input type="hidden" name={ONCE_FIELD} value={once} />
        <TextField
          name="label"
          label="Device name"
          hint="e.g. laptop, work-pc, phone."
          value={values.label}
          required
          maxlength={100}
          error={errors['label']}
        />
        <SelectField
          name="lifetime"
          label="Lifetime"
          value={values.lifetime}
          error={errors['lifetime']}
          options={LIFETIMES.map(([value, label]) => ({ value, label }))}
        />
        <div class="actions">
          <Button>Create token</Button>
          <LinkButton href={BASE} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

export function registerMe(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();
  /** The answer for any id that is not the caller's own (and for one that does not exist: the same page). */
  const missing = (c: Context, principal: UiPrincipal): Response => errorPage(404, requestIdOf(c), principal);
  const failed = (c: Context, principal: UiPrincipal): Response => errorPage(503, requestIdOf(c), principal);

  const myKeys = (c: Context, principal: UiPrincipal) =>
    listAll(kit, c, principal, '/me/credentials', parseCredential);
  const myGrants = (c: Context, principal: UiPrincipal) =>
    listAll(kit, c, principal, '/me/grants', parseMyGrant);
  const myTokens = (c: Context, principal: UiPrincipal) =>
    listAll(kit, c, principal, '/me/tokens', parseToken);

  const findKey = async (c: Context, principal: UiPrincipal, id: string) =>
    isId(id) ? ((await myKeys(c, principal)) ?? []).find((k) => k.id === id) : undefined;

  ui.get(
    ROUTE,
    kit.page('member', async (c, page) => {
      const { principal } = page;
      const [keys, grants, tokens] = await Promise.all([
        myKeys(c, principal),
        myGrants(c, principal),
        myTokens(c, principal),
      ]);
      if (keys === null || grants === null || tokens === null) return failed(c, principal);
      const t = now();
      const keyName = new Map(keys.map((k) => [k.id, k.label]));
      const grantName = new Map(grants.map((g) => [g.id, `${projectText(g)}: ${g.label ?? 'grant'}`]));
      return page.html(
        <Layout title="My access" viewer={principal} current={BASE} flash={page.flash}>
          <p>
            Your own New Relic keys, the projects an administrator granted you, and the device tokens you
            connect with. Nothing here shows anyone else's.
          </p>

          <section aria-labelledby="grants-heading">
            <h2 id="grants-heading">My grants</h2>
            <DataTable
              caption="My grants"
              empty="No grants yet. Ask an administrator to give you access to a project."
              rows={grants}
              columns={[
                { header: 'Project', cell: (g) => projectText(g) },
                { header: 'Grant', cell: (g) => g.label ?? '—' },
                {
                  header: 'Key used',
                  cell: (g) =>
                    g.credentialId === null
                      ? 'project default'
                      : (keyName.get(g.credentialId) ?? 'a key of yours'),
                },
                { header: 'Status', cell: (g) => <StatusBadge {...grantStatus(g, t)} /> },
                {
                  header: 'Actions',
                  cell: (g) =>
                    g.revokedAt === null ? (
                      <span class="actions">
                        <a href={adminPath`/admin/me/grants/${g.id}`}>Change key</a>
                        <a href={withQuery(`${BASE}/tokens/new`, { grant: g.id })}>New device token</a>
                      </span>
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
          </section>

          <section aria-labelledby="keys-heading">
            <h2 id="keys-heading">My New Relic keys</h2>
            <div class="actions page-actions">
              <LinkButton href={`${KEYS}/new`}>Add a key</LinkButton>
            </div>
            <DataTable
              caption="My keys"
              empty="No keys yet. Add your New Relic User key to use it instead of the project's."
              rows={keys}
              columns={[
                { header: 'Name', cell: (k) => <a href={keyPath(k.id)}>{k.label}</a> },
                { header: 'Region', cell: (k) => k.region },
                { header: 'Key', cell: (k) => <code>{maskedKey(k.keyHint)}</code> },
                { header: 'Status', cell: (k) => validationBadge(k) },
                {
                  header: 'Accounts',
                  cell: (k) => (k.reachableAccountIds === null ? '—' : String(k.reachableAccountIds.length)),
                },
              ]}
            />
          </section>

          <section aria-labelledby="tokens-heading">
            <h2 id="tokens-heading">My device tokens</h2>
            <div class="actions page-actions">
              <LinkButton href={`${BASE}/tokens/new`}>New device token</LinkButton>
            </div>
            <DataTable
              caption="My device tokens"
              empty="No device tokens yet."
              rows={tokens}
              columns={[
                { header: 'Device', cell: (k) => k.label },
                { header: 'Token', cell: (k) => <code>{`${k.prefix}…`}</code> },
                { header: 'Grant', cell: (k) => grantName.get(k.grantId) ?? '—' },
                { header: 'Status', cell: (k) => <StatusBadge {...lifecycle(k, t)} /> },
                { header: 'Last used', cell: (k) => <When at={k.lastUsedAt} none="never" /> },
                { header: 'Expires', cell: (k) => <When at={k.expiresAt} none="never" /> },
                {
                  header: 'Action',
                  cell: (k) =>
                    k.revokedAt === null ? (
                      <RowAction
                        action={`${BASE}${adminPath`/tokens/${k.id}/revoke`}`}
                        csrf={principal.csrf}
                        label="Revoke…"
                        name={`Revoke ${k.label}`}
                      />
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
          </section>
        </Layout>,
      );
    }),
  );

  // ------------------------------------------------------------------------------------------------------ keys

  ui.get(
    `${ROUTE}/keys/new`,
    kit.page('member', (_c, page) => page.html(addKeyPage(page.principal, {}, {}))),
  );

  ui.post(
    `${ROUTE}/keys`,
    kit.form('member', async (c, principal, form) => {
      // Never copy the key into `values`: a form shown again starts with an empty key field.
      const values = { label: form.fields.get('label') ?? '', region: form.fields.get('region') ?? '' };
      const again = (errors: Record<string, string>, message?: string, status = 422) =>
        htmlResponse(addKeyPage(principal, values, errors, message), status);
      const errors: Record<string, string> = {};
      const label = field(form, 'label');
      if (label === null || label.length > 100) errors['label'] = 'Enter a name of up to 100 characters.';
      if (!(REGIONS as readonly string[]).includes(values.region)) errors['region'] = 'Choose US, EU or JP.';
      const apiKey = field(form, 'apiKey');
      if (apiKey === null) errors['apiKey'] = 'Paste the key.';
      else if (apiKey.length > MAX_KEY_CHARS) errors['apiKey'] = 'That is too long for a New Relic key.';
      if (Object.keys(errors).length > 0) return again(errors);

      // No owner field: the API makes the key the caller's and refuses a body that names one.
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: '/me/credentials', body: { label, region: values.region, apiKey } },
        form,
      );
      if (isOk(res)) {
        const cred = one(res.body, parseCredential);
        return kit.redirect(cred ? keyPath(cred.id) : BASE, 'key_added');
      }
      const problem = problemOf(res);
      if (problem.code === 'key_rejected') return again({ apiKey: formMessage(problem) });
      const at = ({ label: 'label', region: 'region', apiKey: 'apiKey' } as Record<string, string>)[
        problem.field ?? ''
      ];
      if (at !== undefined && problem.status === 400) return again({ [at]: problem.message });
      return again({}, formMessage(problem), problem.status === 409 ? 409 : 422);
    }),
  );

  ui.get(
    `${ROUTE}/keys/:id`,
    kit.page('member', async (c, page) => {
      const key = await findKey(c, page.principal, idOf(c));
      if (key === undefined) return missing(c, page.principal);
      const grants = (await myGrants(c, page.principal)) ?? [];
      return page.html(keyPage(page.principal, key, grants, { flash: page.flash }));
    }),
  );

  ui.post(
    `${ROUTE}/keys/:id/rename`,
    kit.form('member', async (c, principal, form) => {
      const id = idOf(c);
      const key = await findKey(c, principal, id);
      if (key === undefined) return missing(c, principal);
      const label = field(form, 'label');
      const showError = async (message: string, typed: string) =>
        htmlResponse(
          keyPage(principal, key, (await myGrants(c, principal)) ?? [], {
            renameError: message,
            label: typed,
          }),
          422,
        );
      if (label === null || label.length > 100)
        return showError('Enter a name of up to 100 characters.', form.fields.get('label') ?? '');
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/me/credentials/${id}`, body: { label } },
        form,
      );
      if (isOk(res)) return kit.redirect(keyPath(id), 'saved');
      const problem = problemOf(res);
      if (problem.status === 404) return missing(c, principal);
      if (problem.status === 400) return showError(problem.message, label);
      return kit.redirect(keyPath(id), flashFor(problem));
    }),
  );

  ui.post(
    `${ROUTE}/keys/:id/revalidate`,
    kit.form('member', async (c, principal, form) => {
      const id = idOf(c);
      if ((await findKey(c, principal, id)) === undefined) return missing(c, principal);
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/me/credentials/${id}/revalidate` },
        form,
      );
      if (!isOk(res)) {
        const problem = problemOf(res);
        return problem.status === 404 ? missing(c, principal) : kit.redirect(keyPath(id), flashFor(problem));
      }
      const outcome = (res.body as { data?: { outcome?: unknown } } | null)?.data?.outcome;
      return kit.redirect(
        keyPath(id),
        outcome === 'valid'
          ? 'key_valid'
          : outcome === 'invalid'
            ? 'key_invalid'
            : outcome === 'skipped'
              ? 'key_not_checkable'
              : 'key_check_failed',
      );
    }),
  );

  ui.get(
    `${ROUTE}/keys/:id/rotate`,
    kit.page('member', async (c, page) => {
      const key = await findKey(c, page.principal, idOf(c));
      if (key === undefined) return missing(c, page.principal);
      return page.html(rotatePage(page.principal, key, {}));
    }),
  );

  ui.post(
    `${ROUTE}/keys/:id/rotate`,
    kit.form('member', async (c, principal, form) => {
      const id = idOf(c);
      const key = await findKey(c, principal, id);
      if (key === undefined) return missing(c, principal);
      const errors: Record<string, string> = {};
      const apiKey = field(form, 'apiKey');
      if (apiKey === null) errors['apiKey'] = 'Paste the new key.';
      else if (apiKey.length > MAX_KEY_CHARS) errors['apiKey'] = 'That is too long for a New Relic key.';
      if (!confirmed(form)) errors['confirm'] = 'Tick the box to confirm the replacement.';
      if (Object.keys(errors).length > 0) {
        // The key field starts empty again: a key is never written back into a page.
        if (apiKey !== null && errors['apiKey'] === undefined) errors['apiKey'] = 'Paste the new key again.';
        return htmlResponse(rotatePage(principal, key, errors), 422);
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/me/credentials/${id}/rotate`, body: { apiKey } },
        form,
      );
      if (isOk(res)) {
        const warnings = (res.body as { warnings?: unknown } | null)?.warnings;
        const otherUser = Array.isArray(warnings) && warnings.includes('nr_user_changed');
        return kit.redirect(keyPath(id), otherUser ? 'key_rotated_other_user' : 'key_rotated');
      }
      const problem = problemOf(res);
      if (problem.status === 404) return missing(c, principal);
      if (problem.code === 'key_rejected' || problem.status === 400) {
        return htmlResponse(rotatePage(principal, key, { apiKey: formMessage(problem) }), 422);
      }
      return htmlResponse(rotatePage(principal, key, {}, formMessage(problem)), 422);
    }),
  );

  ui.post(
    `${ROUTE}/keys/:id/delete`,
    kit.form('member', async (c, principal, form) => {
      const id = idOf(c);
      const key = await findKey(c, principal, id);
      if (key === undefined) return missing(c, principal);
      if (!confirmed(form)) {
        return confirmPage({
          viewer: principal,
          current: BASE,
          title: `Delete the key ${key.label}?`,
          paragraphs: [
            'The encrypted key is removed from this server. Deleting is refused while one of your grants uses it.',
            'This cannot be undone.',
          ],
          action: `${keyPath(id)}/delete`,
          confirm: `Delete ${key.label} for good`,
          cancel: keyPath(id),
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'DELETE', path: adminPath`/me/credentials/${id}` },
        form,
      );
      if (isOk(res)) return kit.redirect(BASE, 'deleted');
      const problem = problemOf(res);
      if (problem.status === 404) return missing(c, principal);
      if (problem.code === 'conflict') return kit.redirect(keyPath(id), 'key_in_use');
      return kit.redirect(keyPath(id), flashFor(problem));
    }),
  );

  // ---------------------------------------------------------------------------------------------------- grants

  const findGrant = async (c: Context, principal: UiPrincipal, id: string) =>
    isId(id) ? ((await myGrants(c, principal)) ?? []).find((g) => g.id === id) : undefined;

  ui.get(
    `${ROUTE}/grants/:id`,
    kit.page('member', async (c, page) => {
      const grant = await findGrant(c, page.principal, idOf(c));
      if (grant === undefined || grant.revokedAt !== null) return missing(c, page.principal);
      return page.html(grantPage(page.principal, grant, (await myKeys(c, page.principal)) ?? []));
    }),
  );

  ui.post(
    `${ROUTE}/grants/:id`,
    kit.form('member', async (c, principal, form) => {
      const id = idOf(c);
      const grant = await findGrant(c, principal, id);
      if (grant === undefined) return missing(c, principal);
      const chosen = form.fields.get('credentialId') ?? '';
      const again = async (error?: string, message?: string) =>
        htmlResponse(grantPage(principal, grant, (await myKeys(c, principal)) ?? [], error, message), 422);
      if (chosen !== '' && !isId(chosen)) return again('Choose a key from the list.');
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'PATCH',
          path: adminPath`/me/grants/${id}`,
          body: { credentialId: chosen === '' ? null : chosen },
        },
        form,
      );
      if (isOk(res)) return kit.redirect(BASE, 'saved');
      const problem = problemOf(res);
      if (problem.status === 404) {
        // The grant, or the key named in the form, is not the caller's: nothing changed.
        return missing(c, principal);
      }
      if (problem.field === 'credentialId') return again(problem.message);
      return again(undefined, formMessage(problem));
    }),
  );

  // ---------------------------------------------------------------------------------------------------- tokens

  ui.get(
    `${ROUTE}/tokens/new`,
    kit.page('member', async (c, page) => {
      const { principal } = page;
      const grants = await myGrants(c, principal);
      if (grants === null) return failed(c, principal);
      const chosen = c.req.query('grant');
      if (chosen !== undefined) {
        const grant = grants.find((g) => g.id === chosen);
        if (grant === undefined || grant.revokedAt !== null) return missing(c, principal);
        return page.html(
          newTokenPage(principal, grant, { label: '', lifetime: '90' }, {}, await kit.issueOnce(principal)),
        );
      }
      const t = now();
      const live = grants.filter((g) => lifecycle(g, t).text === 'active');
      return page.html(
        <Layout title="New device token" viewer={principal} current={BASE} flash={page.flash}>
          <p>Step 1 of 2: choose the grant the device connects with.</p>
          {live.length === 0 ? (
            <p class="card">
              You have no active grant. Ask an administrator to give you access to a project.
            </p>
          ) : (
            <QueryForm action={`${BASE}/tokens/new`} label="Choose the grant">
              <SelectField
                name="grant"
                label="Grant"
                options={live.map((g) => ({
                  value: g.id,
                  label: `${projectText(g)}: ${g.label ?? 'grant'}`,
                }))}
              />
              <div class="actions">
                <Button>Next</Button>
                <LinkButton href={BASE} variant="secondary">
                  Cancel
                </LinkButton>
              </div>
            </QueryForm>
          )}
        </Layout>,
      );
    }),
  );

  ui.post(
    `${ROUTE}/tokens`,
    kit.form('member', async (c, principal, form) => {
      const grantId = field(form, 'grantId') ?? '';
      const grant = await findGrant(c, principal, grantId);
      if (grant === undefined || grant.revokedAt !== null) return missing(c, principal);
      const label = field(form, 'label');
      const lifetime = form.fields.get('lifetime') ?? '90';
      const values = { label: form.fields.get('label') ?? '', lifetime };
      const errors: Record<string, string> = {};
      if (label === null || label.length > 100)
        errors['label'] = 'Enter a device name of up to 100 characters.';
      if (!LIFETIMES.some(([v]) => v === lifetime)) errors['lifetime'] = 'Choose a lifetime from the list.';
      const again = async (errs: Record<string, string>, message?: string, status = 422) =>
        htmlResponse(
          newTokenPage(principal, grant, values, errs, await kit.issueOnce(principal), message),
          status,
        );
      if (Object.keys(errors).length > 0) return again(errors);
      // A re-sent form (reload or back on the one-time page) must not issue another token (P4-07).
      if (!(await kit.claimOnce(form))) return kit.redirect(BASE, 'token_form_used');

      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: '/me/tokens',
          body: { grantId, label, ttlSeconds: lifetime === 'never' ? 'never' : Number(lifetime) * 86_400 },
        },
        form,
      );
      if (!isOk(res)) {
        const problem = problemOf(res);
        if (problem.status === 404) return missing(c, principal);
        if (problem.field === 'label' && problem.status === 400) return again({ label: problem.message });
        return again({}, formMessage(problem));
      }
      const body = res.body as { token?: unknown; warnings?: unknown } | null;
      const token = typeof body?.token === 'string' ? body.token : null;
      const record: Token | null = one(res.body, parseToken);
      if (token === null || record === null)
        return again({}, 'The token could not be shown. Revoke it and try again.');
      const warnings = Array.isArray(body?.warnings)
        ? body.warnings.filter((w): w is string => typeof w === 'string')
        : [];
      const slug = grant.project?.slug;
      // The one place a token is ever rendered. The page is `no-store`; the token is not kept anywhere.
      return htmlResponse(
        <IssuedTokenPage
          viewer={principal}
          current={BASE}
          record={record}
          token={token}
          warnings={warnings}
          endpoint={endpointOf(kit.deps.publicUrl, slug ?? '<project>')}
          slug={slug ?? 'project'}
          done={BASE}
        />,
      );
    }),
  );

  ui.post(
    `${ROUTE}/tokens/:id/revoke`,
    kit.form('member', async (c, principal, form) => {
      const id = idOf(c);
      const token = isId(id) ? ((await myTokens(c, principal)) ?? []).find((k) => k.id === id) : undefined;
      if (token === undefined) return missing(c, principal);
      if (!confirmed(form)) {
        return confirmPage({
          viewer: principal,
          current: BASE,
          title: `Revoke the token of ${token.label}?`,
          paragraphs: [
            `The device using ${token.prefix}… loses access at once. Other devices keep working.`,
            'A revoked token cannot be restored: the device needs a new token.',
          ],
          action: `${BASE}${adminPath`/tokens/${id}/revoke`}`,
          confirm: `Revoke ${token.label}`,
          cancel: BASE,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/me/tokens/${id}/revoke` },
        form,
      );
      if (isOk(res)) return kit.redirect(BASE, 'revoked');
      const problem = problemOf(res);
      return problem.status === 404 ? missing(c, principal) : kit.redirect(BASE, flashFor(problem));
    }),
  );
}
