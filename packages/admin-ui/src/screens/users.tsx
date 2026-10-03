// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Users (P4-04): who may sign in, with which role. Adding a user is the invitation: the user row is the explicit allow
// for sign-in (P4-01), whatever the self-sign-up allowlist says. Nobody changes their own role or disables themselves
// here; only owners create or change owners (the admin API enforces both, the page hides what would be refused).
//
//   GET  /admin/users                  list (cursor pages)
//   GET  /admin/users/new              add form
//   POST /admin/users                  add
//   GET  /admin/users/:id              detail: name and role, keys, grants, sign-out, disable
//   POST /admin/users/:id              save name and role
//   POST /admin/users/:id/disable      disable (needs confirm=yes): sessions end, grants and personal keys stop
//   POST /admin/users/:id/enable
//   POST /admin/users/:id/signout      end every session (needs confirm=yes)
import type { Context, Hono } from 'hono';
import {
  Button,
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
import { adminPath, type UiKit, type UiPrincipal } from '../kit.ts';
import { htmlResponse } from '../pages.tsx';
import { maskedKey, validationBadge } from './credentials.tsx';
import {
  isId,
  one,
  parseCredential,
  parseGrant,
  parseProject,
  parseUser,
  ROLES,
  type Role,
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
  lifecycle,
  listAll,
  listOne,
  loadFailed,
  problemOf,
  StatusBadge,
  When,
  withQuery,
} from './shared.tsx';

const BASE = '/admin/users';
/** Route paths inside the `/admin` sub-app. */
const ROUTE = '/users';
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,255}$/;

const ROLE_TEXT: Readonly<Record<Role, string>> = {
  owner: 'Owner: everything, including other owners and the master key',
  admin: 'Admin: keys, projects, grants, devices and users (not owners)',
  member: 'Member: signs in; self-service comes in a later release',
};

const roleOptions = (viewer: UiPrincipal) =>
  ROLES.filter((r) => r !== 'owner' || viewer.role === 'owner').map((r) => ({
    value: r,
    label: ROLE_TEXT[r],
  }));

const statusOf = (u: User) =>
  u.disabledAt === null ? (
    <StatusBadge tone="ok" text="active" />
  ) : (
    <StatusBadge tone="error" text="disabled" />
  );

function addPage(
  viewer: UiPrincipal,
  values: { email: string; displayName: string; role: string },
  errors: Readonly<Record<string, string>>,
  message?: string,
  flash: FlashMessage | null = null,
) {
  return (
    <Layout title="Add a user" viewer={viewer} current={BASE} flash={flash}>
      <p>
        Adding someone is their invitation: they can then sign in with any configured provider that confirms
        this email address. Tell them the address of this panel; no email is sent.
      </p>
      <FormError message={message} />
      <Form action={BASE} csrf={viewer.csrf} label="Add a user">
        <TextField
          name="email"
          label="Email"
          type="email"
          autocomplete="off"
          spellcheck={false}
          value={values.email}
          required
          maxlength={320}
          error={errors['email']}
        />
        <TextField
          name="displayName"
          label="Name (optional)"
          value={values.displayName}
          maxlength={100}
          error={errors['displayName']}
        />
        <SelectField
          name="role"
          label="Role"
          value={values.role}
          error={errors['role']}
          options={roleOptions(viewer)}
        />
        <div class="actions">
          <Button>Add user</Button>
          <LinkButton href={BASE} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

export function registerUsers(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();
  const load = async (c: Context, principal: UiPrincipal, id: string) => {
    const res = await kit.callAdmin(c, principal, { method: 'GET', path: adminPath`/users/${id}` });
    return { res, user: isOk(res) ? one(res.body, parseUser) : null };
  };

  const detail = async (
    c: Context,
    viewer: UiPrincipal,
    user: User,
    opts: {
      readonly flash?: FlashMessage | null;
      readonly errors?: Readonly<Record<string, string>>;
      readonly message?: string | undefined;
      readonly displayName?: string;
    } = {},
  ) => {
    const [keys, grants, projects] = await Promise.all([
      listAll(kit, c, viewer, '/credentials', parseCredential, { ownerUserId: user.id }),
      listAll(kit, c, viewer, '/grants', parseGrant, { userId: user.id }),
      listAll(kit, c, viewer, '/projects', parseProject),
    ]);
    const slugs = new Map((projects ?? []).map((p) => [p.id, p.slug]));
    const self = `${BASE}${adminPath`/${user.id}`}`;
    const isSelf = user.id === viewer.userId;
    const ownerOnly = user.role === 'owner' && viewer.role !== 'owner';
    const t = now();
    return (
      <Layout title={`User: ${user.email}`} viewer={viewer} current={BASE} flash={opts.flash ?? null}>
        <section class="card" aria-labelledby="facts-heading">
          <h2 id="facts-heading">Summary</h2>
          <Facts
            items={[
              ['Email', user.email],
              ['Name', user.displayName ?? '—'],
              ['Role', user.role],
              ['Signs in with', user.idp ?? 'not signed in yet'],
              ['Status', statusOf(user)],
              ['Added', <When at={user.createdAt} />],
            ]}
          />
        </section>

        <section aria-labelledby="edit-heading">
          <h2 id="edit-heading">Name and role</h2>
          {ownerOnly ? (
            <p>Only an owner can change an owner.</p>
          ) : (
            <>
              <FormError message={opts.message} />
              <Form action={self} csrf={viewer.csrf} label="Name and role">
                <TextField
                  name="displayName"
                  label="Name"
                  hint="Blank: none."
                  value={opts.displayName ?? user.displayName ?? ''}
                  maxlength={100}
                  error={opts.errors?.['displayName']}
                />
                {isSelf ? (
                  <p class="hint">You cannot change your own role; ask another owner.</p>
                ) : (
                  <SelectField
                    name="role"
                    label="Role"
                    hint="A role change signs them out everywhere."
                    value={user.role}
                    error={opts.errors?.['role']}
                    options={roleOptions(viewer)}
                  />
                )}
                <Button>Save</Button>
              </Form>
            </>
          )}
        </section>

        <section aria-labelledby="keys-heading">
          <h2 id="keys-heading">Personal New Relic keys</h2>
          {keys === null ? (
            <p class="muted">The keys could not be loaded.</p>
          ) : (
            <DataTable
              caption={`Keys owned by ${user.email}`}
              empty="No personal keys."
              rows={keys}
              columns={[
                {
                  header: 'Name',
                  cell: (k) => <a href={adminPath`/admin/credentials/${k.id}`}>{k.label}</a>,
                },
                { header: 'Region', cell: (k) => k.region },
                { header: 'Key', cell: (k) => <code>{maskedKey(k.keyHint)}</code> },
                { header: 'Status', cell: (k) => validationBadge(k) },
              ]}
            />
          )}
        </section>

        <section aria-labelledby="grants-heading">
          <h2 id="grants-heading">Grants</h2>
          <div class="actions page-actions">
            <LinkButton href="/admin/grants/new" variant="secondary">
              New grant
            </LinkButton>
          </div>
          {grants === null ? (
            <p class="muted">The grants could not be loaded.</p>
          ) : (
            <DataTable
              caption={`Grants of ${user.email}`}
              empty="No grants: this user cannot use any project."
              rows={grants}
              columns={[
                {
                  header: 'Project',
                  cell: (g) => (
                    <a href={adminPath`/admin/grants/${g.id}`}>{slugs.get(g.projectId) ?? g.projectId}</a>
                  ),
                },
                { header: 'Status', cell: (g) => <StatusBadge {...lifecycle(g, t)} /> },
                { header: 'Expires', cell: (g) => <When at={g.expiresAt} none="never" /> },
              ]}
            />
          )}
        </section>

        {isSelf || ownerOnly ? null : (
          <section aria-labelledby="danger-heading">
            <h2 id="danger-heading">Sign out or disable</h2>
            <ConfirmAction
              action={`${self}/signout`}
              csrf={viewer.csrf}
              summary="Sign this user out everywhere…"
              confirm="Sign out everywhere"
            >
              <p>Every admin session of this user ends at once. Their device tokens keep working.</p>
            </ConfirmAction>
            {user.disabledAt === null ? (
              <ConfirmAction
                action={`${self}/disable`}
                csrf={viewer.csrf}
                summary="Disable this user…"
                confirm={`Disable ${user.email}`}
              >
                <p>
                  They are signed out and cannot sign in. Their grants and personal keys stop working until
                  you enable them again.
                </p>
              </ConfirmAction>
            ) : (
              <Form action={`${self}/enable`} csrf={viewer.csrf} label="Enable">
                <Button variant="secondary">Enable this user</Button>
              </Form>
            )}
          </section>
        )}
      </Layout>
    );
  };

  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      const cursor = validCursor(c.req.query('cursor'));
      const list = await listOne(kit, c, page.principal, '/users', parseUser, {
        ...(cursor ? { cursor } : {}),
      });
      if (!('rows' in list)) return loadFailed(c, list, page.principal);
      return page.html(
        <Layout title="Users" viewer={page.principal} current={BASE} flash={page.flash}>
          <p>People who may sign in to this panel, and whose grants and personal keys are managed here.</p>
          <div class="actions page-actions">
            <LinkButton href={`${BASE}/new`}>Add a user</LinkButton>
          </div>
          <DataTable
            caption="Users"
            empty="No users yet."
            rows={list.rows}
            columns={[
              { header: 'Email', cell: (u) => <a href={`${BASE}${adminPath`/${u.id}`}`}>{u.email}</a> },
              { header: 'Name', cell: (u) => u.displayName ?? '—' },
              { header: 'Role', cell: (u) => u.role },
              { header: 'Signs in with', cell: (u) => u.idp ?? '—' },
              { header: 'Status', cell: (u) => statusOf(u) },
            ]}
          />
          <Pager
            label="User pages"
            next={list.nextCursor === null ? null : withQuery(BASE, { cursor: list.nextCursor })}
            first={cursor === undefined ? undefined : BASE}
          />
        </Layout>,
      );
    }),
  );

  ui.get(
    `${ROUTE}/new`,
    kit.page('admin', (_c, page) =>
      page.html(
        addPage(page.principal, { email: '', displayName: '', role: 'member' }, {}, undefined, page.flash),
      ),
    ),
  );

  ui.post(
    ROUTE,
    kit.form('admin', async (c, principal, form) => {
      const email = field(form, 'email');
      const displayName = field(form, 'displayName');
      const role = form.fields.get('role') ?? 'member';
      const values = { email: email ?? '', displayName: displayName ?? '', role };
      const errors: Record<string, string> = {};
      if (email === null || email.length > 320 || !EMAIL_RE.test(email))
        errors['email'] = 'Enter an email address.';
      if (displayName !== null && displayName.length > 100) errors['displayName'] = 'At most 100 characters.';
      if (!roleOptions(principal).some((o) => o.value === role))
        errors['role'] = 'Choose a role from the list.';
      if (Object.keys(errors).length > 0) return htmlResponse(addPage(principal, values, errors), 422);
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: '/users', body: { email, displayName, role } },
        form,
      );
      if (isOk(res)) {
        const user = one(res.body, parseUser);
        return kit.redirect(user ? `${BASE}${adminPath`/${user.id}`}` : BASE, 'user_added');
      }
      const problem = problemOf(res);
      if (problem.code === 'conflict') {
        return htmlResponse(
          addPage(principal, values, { email: 'A user with this email already exists.' }),
          422,
        );
      }
      if (problem.status === 400 && (problem.field === 'email' || problem.field === 'displayName')) {
        return htmlResponse(addPage(principal, values, { [problem.field]: problem.message }), 422);
      }
      return htmlResponse(addPage(principal, values, {}, formMessage(problem)), 422);
    }),
  );

  ui.get(
    `${ROUTE}/:id`,
    kit.page('admin', async (c, page) => {
      const id = c.req.param('id');
      if (!isId(id)) return loadFailed(c, { status: 404, body: null }, page.principal);
      const { res, user } = await load(c, page.principal, id);
      if (user === null) return loadFailed(c, res, page.principal);
      return page.html(await detail(c, page.principal, user, { flash: page.flash }));
    }),
  );

  ui.post(
    `${ROUTE}/:id`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const { res: got, user } = await load(c, principal, id);
      if (user === null) return kit.redirect(BASE, flashFor(problemOf(got)));
      const displayName = field(form, 'displayName');
      const role = form.fields.get('role');
      const errors: Record<string, string> = {};
      if (displayName !== null && displayName.length > 100) errors['displayName'] = 'At most 100 characters.';
      if (role !== null && !roleOptions(principal).some((o) => o.value === role)) {
        errors['role'] = 'Choose a role from the list.';
      }
      if (Object.keys(errors).length > 0) {
        return htmlResponse(
          await detail(c, principal, user, { errors, displayName: displayName ?? '' }),
          422,
        );
      }
      // Only what changed: sending the unchanged role of oneself would be refused as a self-change.
      const body: Record<string, unknown> = {};
      if (displayName !== user.displayName) body['displayName'] = displayName;
      if (role !== null && role !== user.role) body['role'] = role;
      const self = `${BASE}${adminPath`/${id}`}`;
      if (Object.keys(body).length === 0) return kit.redirect(self, 'saved');
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/users/${id}`, body },
        form,
      );
      if (isOk(res)) return kit.redirect(self, 'saved');
      const problem = problemOf(res);
      if (problem.status === 400 && problem.field === 'displayName') {
        return htmlResponse(
          await detail(c, principal, user, {
            errors: { displayName: problem.message },
            displayName: displayName ?? '',
          }),
          422,
        );
      }
      return kit.redirect(problem.status === 404 ? BASE : self, flashFor(problem));
    }),
  );

  const action = (kind: 'disable' | 'enable' | 'signout') =>
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id') ?? '';
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const self = `${BASE}${adminPath`/${id}`}`;
      if (kind !== 'enable' && !confirmed(form)) {
        const { res: got, user } = await load(c, principal, id);
        if (user === null) return kit.redirect(BASE, flashFor(problemOf(got)));
        return confirmPage({
          viewer: principal,
          current: BASE,
          title: kind === 'disable' ? `Disable ${user.email}?` : `Sign ${user.email} out everywhere?`,
          paragraphs:
            kind === 'disable'
              ? ['They are signed out and cannot sign in. Their grants and personal keys stop working.']
              : ['Every admin session of this user ends at once.'],
          action: `${self}/${kind}`,
          confirm: kind === 'disable' ? `Disable ${user.email}` : 'Sign out everywhere',
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        kind === 'signout'
          ? { method: 'POST', path: adminPath`/users/${id}/sessions/revoke` }
          : { method: 'PATCH', path: adminPath`/users/${id}`, body: { disabled: kind === 'disable' } },
        form,
      );
      if (isOk(res)) {
        return kit.redirect(
          self,
          kind === 'signout' ? 'signed_out_everywhere' : kind === 'disable' ? 'disabled' : 'enabled',
        );
      }
      const problem = problemOf(res);
      return kit.redirect(problem.status === 404 ? BASE : self, flashFor(problem));
    });
  ui.post(`${ROUTE}/:id/disable`, action('disable'));
  ui.post(`${ROUTE}/:id/enable`, action('enable'));
  ui.post(`${ROUTE}/:id/signout`, action('signout'));
}
