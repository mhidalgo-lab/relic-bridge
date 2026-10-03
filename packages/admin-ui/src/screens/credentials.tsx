// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// New Relic keys (P4-04, THREAT_MODEL T8): list (masked), add, rename, check again, replace, delete.
//
//   GET  /admin/credentials                 list (cursor pages)
//   GET  /admin/credentials/new             add form
//   POST /admin/credentials                 add (the admin API validates the key with New Relic first)
//   GET  /admin/credentials/:id             detail
//   POST /admin/credentials/:id/rename
//   POST /admin/credentials/:id/revalidate  check again with New Relic
//   GET  /admin/credentials/:id/rotate      replace-key form
//   POST /admin/credentials/:id/rotate      replace (needs the confirmation box)
//   POST /admin/credentials/:id/delete      delete (needs confirm=yes)
//
// A key is only ever read from a POST body and passed on to the admin API. It is never rendered again (not even in a
// form shown again after an error), never put in a URL, a flash or a log line. Pages show the last 4 characters.
import type { Context, Hono } from 'hono';
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  Button,
  Checkbox,
  ConfirmAction,
  DataTable,
  Facts,
  Form,
  Layout,
  LinkButton,
  Pager,
  SelectField,
  TextField,
} from '../components.tsx';
import type { FlashMessage } from '../flash.ts';
import { adminPath, type UiKit, type UiPrincipal, type VerifiedForm } from '../kit.ts';
import { htmlResponse } from '../pages.tsx';
import {
  type Credential,
  type Grant,
  isId,
  one,
  type Project,
  parseCredential,
  parseGrant,
  parseProject,
  parseUser,
  REGIONS,
  type User,
  validCursor,
} from './data.ts';
import {
  confirmed,
  confirmPage,
  FormError,
  field,
  flashFor,
  formMessage,
  isOk,
  listAll,
  listOne,
  loadFailed,
  problemOf,
  StatusBadge,
  When,
  withQuery,
} from './shared.tsx';

const BASE = '/admin/credentials';
/** Route paths inside the `/admin` sub-app. */
const ROUTE = '/credentials';
const MAX_KEY_CHARS = 200;

/** `•••• abcd`: the only part of a key a page shows. */
export const maskedKey = (hint: string | null): string => (hint === null ? '(hidden)' : `•••• ${hint}`);

export function validationBadge(c: Credential): JSX.Element {
  if (c.revokedAt !== null) return <StatusBadge tone="error" text="revoked" />;
  if (c.validationStatus === 'valid') return <StatusBadge tone="ok" text="valid" />;
  if (c.validationStatus === 'invalid')
    return (
      <StatusBadge
        tone="error"
        text={`refused${c.validationErrorCode ? ` (${c.validationErrorCode})` : ''}`}
      />
    );
  return <StatusBadge tone="muted" text="not checked" />;
}

const ownerText = (c: Credential, users: ReadonlyMap<string, User>): string =>
  c.ownerUserId === null ? 'shared' : (users.get(c.ownerUserId)?.email ?? c.ownerUserId);

/** `label (region, •••• abcd)` for selects on other screens. */
export const credentialOption = (c: Credential): string =>
  `${c.label} (${c.region}, ${maskedKey(c.keyHint)})${c.validationStatus === 'invalid' ? ' refused' : ''}`;

async function usersById(kit: UiKit, c: Context, principal: UiPrincipal): Promise<Map<string, User>> {
  const users = (await listAll(kit, c, principal, '/users', parseUser)) ?? [];
  return new Map(users.map((u) => [u.id, u]));
}

// ---------------------------------------------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------------------------------------------

interface AddValues {
  readonly label?: string;
  readonly region?: string;
  readonly owner?: string;
}

function addPage(
  viewer: UiPrincipal,
  users: readonly User[],
  values: AddValues,
  errors: Readonly<Record<string, string>>,
  message: string | undefined,
  flash: FlashMessage | null = null,
) {
  return (
    <Layout title="Add a New Relic key" viewer={viewer} current={BASE} flash={flash}>
      <p>
        The key is checked with New Relic before it is saved, then stored encrypted. It is never shown again:
        pages show its last 4 characters only.
      </p>
      <FormError message={message} />
      <Form action={BASE} csrf={viewer.csrf} label="Add a New Relic key">
        <TextField
          name="label"
          label="Name"
          hint="Something you recognise, e.g. Work US."
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
        <SelectField
          name="owner"
          label="Owner"
          hint="Shared keys can back any project; a personal key only that person's grants (bring your own key)."
          value={values.owner ?? ''}
          error={errors['owner']}
          options={[
            { value: '', label: 'Shared' },
            ...users
              .filter((u) => u.disabledAt === null)
              .map((u) => ({ value: u.id, label: `Personal: ${u.email}` })),
          ]}
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

// ---------------------------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------------------------

interface Usage {
  readonly projects: readonly Project[];
  readonly grants: readonly Grant[];
}

function detailPage(
  viewer: UiPrincipal,
  cred: Credential,
  owner: string,
  usage: Usage | null,
  opts: {
    readonly flash?: FlashMessage | null;
    readonly renameError?: string | undefined;
    readonly label?: string | undefined;
  } = {},
) {
  const self = `${BASE}${adminPath`/${cred.id}`}`;
  const stored = cred.keyStorage === 'encrypted';
  return (
    <Layout title={`Key: ${cred.label}`} viewer={viewer} current={BASE} flash={opts.flash ?? null}>
      <section class="card" aria-labelledby="facts-heading">
        <h2 id="facts-heading">About this key</h2>
        <Facts
          items={[
            ['Name', cred.label],
            ['Region', cred.region],
            ['Key', <code>{maskedKey(cred.keyHint)}</code>],
            ['Stored', stored ? 'encrypted in the database' : `from ${cred.keyStorage}`],
            ['Owner', owner],
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
        {stored ? (
          <div class="actions">
            <Form action={`${self}/revalidate`} csrf={viewer.csrf} label="Check again">
              <Button variant="secondary">Check again with New Relic</Button>
            </Form>
            <LinkButton href={`${self}/rotate`} variant="secondary">
              Replace the key
            </LinkButton>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="usage-heading">
        <h2 id="usage-heading">Used by</h2>
        {usage === null ? (
          <p class="muted">Usage could not be loaded.</p>
        ) : usage.projects.length + usage.grants.length === 0 ? (
          <p>Nothing uses this key yet.</p>
        ) : (
          <ul>
            {usage.projects.map((p) => (
              <li>
                Default key of project <a href={adminPath`/admin/projects/${p.id}`}>{p.slug}</a>
              </li>
            ))}
            {usage.grants.map((g) => (
              <li>
                Grant <a href={adminPath`/admin/grants/${g.id}`}>{g.label ?? g.id}</a>
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
        <p>Deleting removes the encrypted key. It is refused while a project or grant still uses it.</p>
        <ConfirmAction
          action={`${self}/delete`}
          csrf={viewer.csrf}
          summary="Delete this key…"
          confirm={`Delete ${cred.label} for good`}
        >
          <p>Clients using it stop working at once. This cannot be undone.</p>
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
  const self = `${BASE}${adminPath`/${cred.id}`}`;
  return (
    <Layout title={`Replace the key: ${cred.label}`} viewer={viewer} current={BASE}>
      <p>
        The new key is checked with New Relic first. If New Relic accepts it, it replaces{' '}
        <code>{maskedKey(cred.keyHint)}</code> everywhere at once; the old key is no longer used by this
        server. Revoke the old key in New Relic afterwards.
      </p>
      <FormError message={message} />
      <Form action={`${self}/rotate`} csrf={viewer.csrf} label="Replace the key">
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
            label="Replace the key for every project and grant that uses it"
          />
        </div>
        <div class="actions">
          <Button variant="danger">Check and replace</Button>
          <LinkButton href={self} variant="secondary">
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

export function registerCredentials(ui: Hono, kit: UiKit): void {
  const load = async (c: Context, principal: UiPrincipal, id: string) => {
    const res = await kit.callAdmin(c, principal, { method: 'GET', path: adminPath`/credentials/${id}` });
    return { res, cred: isOk(res) ? one(res.body, parseCredential) : null };
  };

  const usageOf = async (c: Context, principal: UiPrincipal, id: string): Promise<Usage | null> => {
    const [projects, grants] = await Promise.all([
      listAll(kit, c, principal, '/projects', parseProject),
      listAll(kit, c, principal, '/grants', parseGrant),
    ]);
    if (projects === null || grants === null) return null;
    return {
      projects: projects.filter((p) => p.defaultCredentialId === id),
      grants: grants.filter((g) => g.credentialId === id),
    };
  };

  const showDetail = async (
    c: Context,
    principal: UiPrincipal,
    cred: Credential,
    opts: Parameters<typeof detailPage>[4],
    status = 200,
  ) => {
    const users = await usersById(kit, c, principal);
    const usage = await usageOf(c, principal, cred.id);
    return htmlResponse(detailPage(principal, cred, ownerText(cred, users), usage, opts), status);
  };

  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      const cursor = validCursor(c.req.query('cursor'));
      const list = await listOne(kit, c, page.principal, '/credentials', parseCredential, {
        ...(cursor ? { cursor } : {}),
      });
      if (!('rows' in list)) return loadFailed(c, list, page.principal);
      const users = await usersById(kit, c, page.principal);
      return page.html(
        <Layout title="New Relic keys" viewer={page.principal} current={BASE} flash={page.flash}>
          <p>
            User API keys this server calls New Relic with. Projects use one as their default; a grant may use
            its own.
          </p>
          <div class="actions page-actions">
            <LinkButton href={`${BASE}/new`}>Add a key</LinkButton>
          </div>
          <DataTable
            caption="Keys"
            empty="No keys yet. Add your New Relic User key to start."
            rows={list.rows}
            columns={[
              { header: 'Name', cell: (k) => <a href={`${BASE}${adminPath`/${k.id}`}`}>{k.label}</a> },
              { header: 'Region', cell: (k) => k.region },
              { header: 'Key', cell: (k) => <code>{maskedKey(k.keyHint)}</code> },
              { header: 'Owner', cell: (k) => ownerText(k, users) },
              { header: 'Status', cell: (k) => validationBadge(k) },
              { header: 'New Relic user', cell: (k) => k.nrUserEmail ?? '—' },
              {
                header: 'Accounts',
                cell: (k) => (k.reachableAccountIds === null ? '—' : String(k.reachableAccountIds.length)),
              },
            ]}
          />
          <Pager
            label="Key pages"
            next={list.nextCursor === null ? null : withQuery(BASE, { cursor: list.nextCursor })}
            first={cursor === undefined ? undefined : BASE}
          />
        </Layout>,
      );
    }),
  );

  ui.get(
    `${ROUTE}/new`,
    kit.page('admin', async (c, page) => {
      const users = (await listAll(kit, c, page.principal, '/users', parseUser)) ?? [];
      return page.html(addPage(page.principal, users, {}, {}, undefined, page.flash));
    }),
  );

  ui.post(
    ROUTE,
    kit.form('admin', async (c, principal, form) => {
      // Never copy the key into `values`: a form shown again starts with an empty key field.
      const values: AddValues = {
        label: form.fields.get('label') ?? '',
        region: form.fields.get('region') ?? '',
        owner: form.fields.get('owner') ?? '',
      };
      const again = async (errors: Record<string, string>, message?: string) => {
        const users = (await listAll(kit, c, principal, '/users', parseUser)) ?? [];
        return htmlResponse(addPage(principal, users, values, errors, message), 422);
      };
      const errors: Record<string, string> = {};
      const label = field(form, 'label');
      if (label === null) errors['label'] = 'Enter a name.';
      const region = values.region ?? '';
      if (!(REGIONS as readonly string[]).includes(region)) errors['region'] = 'Choose US, EU or JP.';
      const owner = field(form, 'owner');
      if (owner !== null && !isId(owner)) errors['owner'] = 'Choose an owner from the list.';
      const apiKey = keyOf(form);
      if (apiKey === null) errors['apiKey'] = 'Paste the key.';
      else if (apiKey.length > MAX_KEY_CHARS) errors['apiKey'] = 'That is too long for a New Relic key.';
      if (Object.keys(errors).length > 0) return again(errors);

      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: '/credentials',
          body: { label, region, apiKey, ...(owner === null ? {} : { ownerUserId: owner }) },
        },
        form,
      );
      if (isOk(res)) {
        const cred = one(res.body, parseCredential);
        return kit.redirect(cred ? `${BASE}${adminPath`/${cred.id}`}` : BASE, 'key_added');
      }
      const problem = problemOf(res);
      const fields: Readonly<Record<string, string>> = {
        label: 'label',
        region: 'region',
        ownerUserId: 'owner',
        apiKey: 'apiKey',
      };
      const at = fields[problem.field ?? ''];
      if (problem.code === 'key_rejected') return again({ apiKey: formMessage(problem) });
      if (at !== undefined && problem.status === 400) return again({ [at]: problem.message });
      if (problem.status === 404 && at === 'owner') return again({ owner: 'That user no longer exists.' });
      return again({}, formMessage(problem));
    }),
  );

  ui.get(
    `${ROUTE}/:id`,
    kit.page('admin', async (c, page) => {
      const id = c.req.param('id');
      if (!isId(id)) return loadFailed(c, { status: 404, body: null }, page.principal);
      const { res, cred } = await load(c, page.principal, id);
      if (cred === null) return loadFailed(c, res, page.principal);
      const users = await usersById(kit, c, page.principal);
      const usage = await usageOf(c, page.principal, cred.id);
      return page.html(
        detailPage(page.principal, cred, ownerText(cred, users), usage, { flash: page.flash }),
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id/rename`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const label = field(form, 'label');
      if (label === null || label.length > 100) {
        const { res, cred } = await load(c, principal, id);
        if (cred === null) return kit.redirect(BASE, flashFor(problemOf(res)));
        return showDetail(
          c,
          principal,
          cred,
          { renameError: 'Enter a name of up to 100 characters.', label: form.fields.get('label') ?? '' },
          422,
        );
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/credentials/${id}`, body: { label } },
        form,
      );
      if (isOk(res)) return kit.redirect(`${BASE}${adminPath`/${id}`}`, 'saved');
      const problem = problemOf(res);
      if (problem.status === 400) {
        const { cred } = await load(c, principal, id);
        if (cred !== null) {
          return showDetail(c, principal, cred, { renameError: problem.message, label }, 422);
        }
      }
      return kit.redirect(problem.status === 404 ? BASE : `${BASE}${adminPath`/${id}`}`, flashFor(problem));
    }),
  );

  ui.post(
    `${ROUTE}/:id/revalidate`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/credentials/${id}/revalidate` },
        form,
      );
      const back = `${BASE}${adminPath`/${id}`}`;
      if (!isOk(res)) {
        const problem = problemOf(res);
        return kit.redirect(problem.status === 404 ? BASE : back, flashFor(problem));
      }
      const outcome = (res.body as { data?: { outcome?: unknown } } | null)?.data?.outcome;
      return kit.redirect(
        back,
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
    `${ROUTE}/:id/rotate`,
    kit.page('admin', async (c, page) => {
      const id = c.req.param('id');
      if (!isId(id)) return loadFailed(c, { status: 404, body: null }, page.principal);
      const { res, cred } = await load(c, page.principal, id);
      if (cred === null) return loadFailed(c, res, page.principal);
      return page.html(rotatePage(page.principal, cred, {}));
    }),
  );

  ui.post(
    `${ROUTE}/:id/rotate`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const { res: got, cred } = await load(c, principal, id);
      if (cred === null) return kit.redirect(BASE, flashFor(problemOf(got)));
      const errors: Record<string, string> = {};
      const apiKey = keyOf(form);
      if (apiKey === null) errors['apiKey'] = 'Paste the new key.';
      else if (apiKey.length > MAX_KEY_CHARS) errors['apiKey'] = 'That is too long for a New Relic key.';
      if (!confirmed(form)) errors['confirm'] = 'Tick the box to confirm the replacement.';
      if (Object.keys(errors).length > 0) {
        // The key field starts empty again: a key is never written back into a page.
        if (apiKey !== null && errors['apiKey'] === undefined) errors['apiKey'] = 'Paste the new key again.';
        return htmlResponse(rotatePage(principal, cred, errors), 422);
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/credentials/${id}/rotate`, body: { apiKey } },
        form,
      );
      const back = `${BASE}${adminPath`/${id}`}`;
      if (isOk(res)) {
        const warnings = (res.body as { warnings?: unknown } | null)?.warnings;
        const otherUser = Array.isArray(warnings) && warnings.includes('nr_user_changed');
        return kit.redirect(back, otherUser ? 'key_rotated_other_user' : 'key_rotated');
      }
      const problem = problemOf(res);
      if (problem.code === 'key_rejected' || problem.status === 400) {
        return htmlResponse(rotatePage(principal, cred, { apiKey: formMessage(problem) }), 422);
      }
      if (problem.status === 404) return kit.redirect(BASE, 'not_found');
      if (problem.status === 403) return kit.redirect(back, 'not_allowed');
      return htmlResponse(rotatePage(principal, cred, {}, formMessage(problem)), problem.status);
    }),
  );

  ui.post(
    `${ROUTE}/:id/delete`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const back = `${BASE}${adminPath`/${id}`}`;
      if (!confirmed(form)) {
        const { res: got, cred } = await load(c, principal, id);
        if (cred === null) return kit.redirect(BASE, flashFor(problemOf(got)));
        return confirmPage({
          viewer: principal,
          current: BASE,
          title: `Delete the key ${cred.label}?`,
          paragraphs: [
            'The encrypted key is removed from this server. Deleting is refused while a project or grant uses it.',
            'This cannot be undone.',
          ],
          action: `${back}/delete`,
          confirm: `Delete ${cred.label} for good`,
          cancel: back,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'DELETE', path: adminPath`/credentials/${id}` },
        form,
      );
      if (isOk(res)) return kit.redirect(BASE, 'deleted');
      const problem = problemOf(res);
      if (problem.code === 'conflict') return kit.redirect(back, 'key_in_use');
      return kit.redirect(problem.status === 404 ? BASE : back, flashFor(problem));
    }),
  );
}

/** The posted key, trimmed (null when blank). Only ever passed to the admin API. */
function keyOf(form: VerifiedForm): string | null {
  return field(form, 'apiKey');
}
