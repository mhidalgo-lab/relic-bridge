// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Projects (P4-04): one MCP endpoint (`/p/<slug>/mcp`) with its accounts, tools, limits and default key.
//
//   GET  /admin/projects                 list (cursor pages)
//   GET  /admin/projects/new             step 1: choose the default key (its region and accounts drive step 2)
//   GET  /admin/projects/new?credential= step 2: slug, accounts, tools, limits
//   POST /admin/projects                 create
//   GET  /admin/projects/:id             detail, edit form, grants
//   POST /admin/projects/:id             save changes
//   POST /admin/projects/:id/disable     disable (needs confirm=yes)
//   POST /admin/projects/:id/enable
//   POST /admin/projects/:id/delete      delete with its grants and tokens (needs confirm=yes)
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
  QueryForm,
  SelectField,
  TextField,
} from '../components.tsx';
import { FLASH_MESSAGES, type FlashMessage } from '../flash.ts';
import { adminPath, type UiKit, type UiPrincipal, type UiTool, type VerifiedForm } from '../kit.ts';
import { htmlResponse } from '../pages.tsx';
import { endpointFor } from '../snippets.ts';
import { credentialOption } from './credentials.tsx';
import {
  type Credential,
  type Grant,
  isId,
  type Limits,
  one,
  type Project,
  parseCredential,
  parseGrant,
  parseProject,
  parseUser,
  validCursor,
} from './data.ts';
import {
  AccountChecklist,
  accountList,
  accountsFrom,
  confirmed,
  confirmPage,
  FormError,
  field,
  flashFor,
  formMessage,
  isOk,
  LimitsFields,
  LimitsText,
  lifecycle,
  limitFieldOf,
  limitsFrom,
  listAll,
  listOne,
  loadFailed,
  Notes,
  problemOf,
  StatusBadge,
  ToolChecklist,
  toolsFrom,
  unionAccounts,
  When,
  withQuery,
} from './shared.tsx';

const BASE = '/admin/projects';
/** Route paths inside the `/admin` sub-app. */
const ROUTE = '/projects';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NO_KEY = 'none';

export const endpointOf: (publicUrl: string | undefined, slug: string) => string = endpointFor;

const toolsText = (tools: readonly string[] | null): string =>
  tools === null ? 'all (including later ones)' : `${tools.length}: ${tools.join(', ')}`;

// ---------------------------------------------------------------------------------------------------------------
// The project form (create and edit)
// ---------------------------------------------------------------------------------------------------------------

interface ProjectValues {
  readonly slug: string;
  readonly name: string;
  /** Default key id; null = none. */
  readonly credentialId: string | null;
  readonly accounts: readonly number[];
  readonly defaultAccountId: number | null;
  readonly tools: readonly string[] | null;
  readonly limits: Limits;
}

interface ProjectFormProps {
  readonly viewer: UiPrincipal;
  readonly mode: 'create' | 'edit';
  readonly action: string;
  readonly values: ProjectValues;
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
  readonly credentials: readonly Credential[];
  readonly tools: readonly UiTool[];
}

function ProjectForm(props: ProjectFormProps) {
  const v = props.values;
  const cred = props.credentials.find((c) => c.id === v.credentialId) ?? null;
  const reachable = cred?.reachableAccountIds ?? [];
  const candidates = unionAccounts(reachable, v.accounts);
  const notes = new Map<number, string>();
  if (cred !== null) {
    for (const a of candidates)
      if (!reachable.includes(a)) notes.set(a, 'not reachable with the default key');
  }
  return (
    <>
      <FormError message={props.message} />
      <Form
        action={props.action}
        csrf={props.viewer.csrf}
        label={props.mode === 'create' ? 'New project' : 'Edit project'}
      >
        <TextField
          name="slug"
          label="Slug"
          hint="Lowercase letters, digits and dashes. The MCP endpoint is /p/<slug>/mcp."
          value={v.slug}
          required
          maxlength={63}
          spellcheck={false}
          autocomplete="off"
          error={props.errors['slug']}
        />
        <TextField
          name="name"
          label="Display name (optional)"
          value={v.name}
          maxlength={100}
          error={props.errors['name']}
        />
        {props.mode === 'create' ? (
          <div class="field">
            <input type="hidden" name="credentialId" value={v.credentialId ?? NO_KEY} />
            <p>
              <strong>Default key:</strong>{' '}
              {cred === null ? 'none (every grant names its own key)' : credentialOption(cred)}{' '}
              <a href={`${BASE}/new`}>Choose another key</a>
            </p>
            {props.errors['credentialId'] ? <p class="error">{props.errors['credentialId']}</p> : null}
          </div>
        ) : (
          <SelectField
            name="credentialId"
            label="Default key"
            hint="Grants that name no key use this one. Its region is the project's region. Accounts below come from it."
            value={v.credentialId ?? NO_KEY}
            error={props.errors['credentialId']}
            options={[
              { value: NO_KEY, label: 'None: every grant names its own key' },
              ...props.credentials.map((c) => ({ value: c.id, label: credentialOption(c) })),
            ]}
          />
        )}
        <AccountChecklist
          name="accounts"
          legend="Allowed accounts"
          hint={
            cred === null
              ? 'Add account ids below.'
              : `Accounts the ${cred.region} key ${cred.label} can reach. Tools can only use the accounts ticked here.`
          }
          accounts={candidates}
          selected={v.accounts}
          notes={notes}
          error={props.errors['accounts']}
        />
        <TextField
          name="accounts_other"
          label="Other account ids (optional)"
          hint="Comma-separated, for accounts the key does not list yet."
          inputmode="numeric"
          maxlength={2000}
          error={props.errors['accounts_other']}
        />
        {candidates.length > 0 ? (
          <SelectField
            name="defaultAccountId"
            label="Default account"
            hint="Used when a tool call names no account. Must be one of the allowed accounts."
            value={v.defaultAccountId === null ? '' : String(v.defaultAccountId)}
            error={props.errors['defaultAccountId']}
            options={[
              { value: '', label: 'The first allowed account' },
              ...candidates.map((a) => ({ value: String(a), label: `Account ${a}` })),
            ]}
          />
        ) : (
          <TextField
            name="defaultAccountId"
            label="Default account (optional)"
            hint="Blank: the first allowed account."
            type="number"
            inputmode="numeric"
            min={1}
            value={v.defaultAccountId ?? undefined}
            error={props.errors['defaultAccountId']}
          />
        )}
        <ToolChecklist
          tools={props.tools}
          selected={v.tools}
          legend="Tools"
          allLabel="All tools, including tools added in later versions"
          allHint="Untick to choose tools one by one below."
          error={props.errors['tools']}
        />
        <LimitsFields limits={v.limits} errors={props.errors} />
        <div class="actions">
          <Button>{props.mode === 'create' ? 'Create project' : 'Save changes'}</Button>
        </div>
      </Form>
    </>
  );
}

/** Read the project form: the admin API body, the values to show again, and field errors. */
function readProjectForm(form: VerifiedForm): {
  body: Record<string, unknown>;
  values: ProjectValues;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const slug = (field(form, 'slug') ?? '').toLowerCase();
  if (!SLUG_RE.test(slug))
    errors['slug'] = 'Use 1-63 lowercase letters, digits and dashes (not at the ends).';
  const name = field(form, 'name');
  if (name !== null && name.length > 100) errors['name'] = 'At most 100 characters.';
  const rawCred = field(form, 'credentialId');
  const credentialId = rawCred === null || rawCred === NO_KEY ? null : rawCred;
  if (credentialId !== null && !isId(credentialId)) errors['credentialId'] = 'Choose a key from the list.';
  const accounts = unionAccounts(accountsFrom(form, 'accounts'), accountsFrom(form, 'accounts_other'));
  const otherRaw = field(form, 'accounts_other');
  if (otherRaw !== null && !/^[\d\s,]*$/.test(otherRaw)) {
    errors['accounts_other'] = 'Only account ids (digits), separated by commas.';
  }
  if (accounts.length === 0) errors['accounts'] = 'Allow at least one account.';
  const rawDefault = field(form, 'defaultAccountId');
  let defaultAccountId: number | null = null;
  if (rawDefault !== null) {
    if (!/^\d{1,15}$/.test(rawDefault) || Number(rawDefault) < 1) {
      errors['defaultAccountId'] = 'Choose an account id.';
    } else defaultAccountId = Number(rawDefault);
  }
  if (defaultAccountId !== null && accounts.length > 0 && !accounts.includes(defaultAccountId)) {
    errors['defaultAccountId'] = 'The default account must be one of the allowed accounts.';
  }
  const tools = toolsFrom(form);
  if ('error' in tools) errors['tools'] = tools.error;
  const limits = limitsFrom(form);
  if ('errors' in limits) Object.assign(errors, limits.errors);
  const values: ProjectValues = {
    slug,
    name: name ?? '',
    credentialId,
    accounts,
    defaultAccountId,
    tools: 'value' in tools ? tools.value : [],
    limits: 'limits' in limits ? limits.limits : {},
  };
  const body = {
    slug,
    name,
    defaultCredentialId: credentialId,
    allowedAccountIds: accounts,
    defaultAccountId: defaultAccountId ?? accounts[0],
    enabledTools: values.tools,
    limits: values.limits,
  };
  return { body, values, errors };
}

/** An admin API refusal of the project form → field errors or a message. */
function projectProblem(res: { status: number; body: unknown }): {
  errors: Record<string, string>;
  message?: string;
} {
  const problem = problemOf(res);
  if (problem.status === 400 || (problem.status === 404 && problem.field === 'defaultCredentialId')) {
    const f = problem.field ?? '';
    const map: Record<string, string> = {
      slug: 'slug',
      name: 'name',
      allowedAccountIds: 'accounts',
      defaultAccountId: 'defaultAccountId',
      enabledTools: 'tools',
      defaultCredentialId: 'credentialId',
    };
    const at = map[f.split('.')[0] ?? ''] ?? limitFieldOf(f);
    if (at !== undefined) return { errors: { [at]: problem.message } };
  }
  if (problem.status === 409 && problem.code === 'conflict') {
    return { errors: { slug: 'A project with this slug already exists.' } };
  }
  return { errors: {}, message: formMessage(problem) };
}

// ---------------------------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------------------------

function chooseKeyPage(viewer: UiPrincipal, credentials: readonly Credential[], flash: FlashMessage | null) {
  return (
    <Layout title="New project" viewer={viewer} current={BASE} flash={flash}>
      <p>
        Step 1 of 2: choose the project's default New Relic key. Its region is the project's region, and the
        accounts it can reach are offered in the next step.
      </p>
      {credentials.length === 0 ? (
        <p class="card">
          There are no keys yet. <a href="/admin/credentials/new">Add a New Relic key</a> first, or continue
          without one (every grant then names its own key).
        </p>
      ) : null}
      <QueryForm action={`${BASE}/new`} label="Choose the default key">
        <SelectField
          name="credential"
          label="Default key"
          options={[
            ...credentials.map((c) => ({ value: c.id, label: credentialOption(c) })),
            { value: NO_KEY, label: 'No default key: every grant names its own' },
          ]}
        />
        <div class="actions">
          <Button>Next</Button>
          <LinkButton href={BASE} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </QueryForm>
    </Layout>
  );
}

function createPage(props: Omit<ProjectFormProps, 'mode' | 'action'>) {
  return (
    <Layout title="New project" viewer={props.viewer} current={BASE}>
      <p>Step 2 of 2: name the endpoint and choose what it may reach.</p>
      <ProjectForm {...props} mode="create" action={BASE} />
    </Layout>
  );
}

interface DetailData {
  readonly project: Project;
  readonly credentials: readonly Credential[];
  readonly grants: readonly Grant[] | null;
  readonly userEmails: ReadonlyMap<string, string>;
}

function detailPage(
  viewer: UiPrincipal,
  data: DetailData,
  ctx: { readonly publicUrl: string | undefined; readonly tools: readonly UiTool[]; readonly now: number },
  opts: {
    readonly flash?: FlashMessage | null;
    readonly values?: ProjectValues;
    readonly errors?: Readonly<Record<string, string>>;
    readonly message?: string | undefined;
    readonly notes?: readonly string[];
  } = {},
) {
  const p = data.project;
  const self = `${BASE}${adminPath`/${p.id}`}`;
  const cred = data.credentials.find((c) => c.id === p.defaultCredentialId) ?? null;
  const values: ProjectValues = opts.values ?? {
    slug: p.slug,
    name: p.name ?? '',
    credentialId: p.defaultCredentialId,
    accounts: p.allowedAccountIds,
    defaultAccountId: p.defaultAccountId,
    tools: p.enabledTools,
    limits: p.limits,
  };
  return (
    <Layout title={`Project: ${p.slug}`} viewer={viewer} current={BASE} flash={opts.flash ?? null}>
      <Notes title="Notes about this change" items={opts.notes ?? []} />
      <section class="card" aria-labelledby="facts-heading">
        <h2 id="facts-heading">Summary</h2>
        <Facts
          items={[
            ['MCP endpoint', <code>{endpointOf(ctx.publicUrl, p.slug)}</code>],
            ['Name', p.name ?? '—'],
            [
              'Status',
              p.disabledAt === null ? (
                <StatusBadge tone="ok" text="enabled" />
              ) : (
                <StatusBadge tone="error" text="disabled" />
              ),
            ],
            [
              'Default key',
              cred === null ? (
                p.defaultCredentialId === null ? (
                  'none'
                ) : (
                  p.defaultCredentialId
                )
              ) : (
                <a href={adminPath`/admin/credentials/${cred.id}`}>{credentialOption(cred)}</a>
              ),
            ],
            ['Default account', String(p.defaultAccountId)],
            ['Allowed accounts', accountList(p.allowedAccountIds)],
            ['Tools', toolsText(p.enabledTools)],
            ['Query limits', <LimitsText limits={p.limits} />],
            ['Created', <When at={p.createdAt} />],
          ]}
        />
      </section>

      <section aria-labelledby="grants-heading">
        <h2 id="grants-heading">Grants</h2>
        <p>A grant gives a person or a service access to this project; devices connect with its tokens.</p>
        <div class="actions page-actions">
          <LinkButton href={withQuery('/admin/grants/new', { project: p.id })}>New grant</LinkButton>
        </div>
        {data.grants === null ? (
          <p class="muted">The grants could not be loaded.</p>
        ) : (
          <DataTable
            caption={`Grants of ${p.slug}`}
            empty="No grants yet: nobody can use this project."
            rows={data.grants}
            columns={[
              {
                header: 'For',
                cell: (g) => (
                  <a href={adminPath`/admin/grants/${g.id}`}>
                    {g.userId === null
                      ? `service: ${g.label ?? g.id}`
                      : (data.userEmails.get(g.userId) ?? g.userId)}
                  </a>
                ),
              },
              { header: 'Status', cell: (g) => <StatusBadge {...lifecycle(g, ctx.now)} /> },
              { header: 'Expires', cell: (g) => <When at={g.expiresAt} none="never" /> },
            ]}
          />
        )}
      </section>

      <section aria-labelledby="edit-heading">
        <h2 id="edit-heading">Edit</h2>
        <p>Narrowing a project narrows every grant on it at once.</p>
        <ProjectForm
          viewer={viewer}
          mode="edit"
          action={self}
          values={values}
          errors={opts.errors ?? {}}
          message={opts.message}
          credentials={data.credentials}
          tools={ctx.tools}
        />
      </section>

      <section aria-labelledby="danger-heading">
        <h2 id="danger-heading">Disable or delete</h2>
        {p.disabledAt === null ? (
          <ConfirmAction
            action={`${self}/disable`}
            csrf={viewer.csrf}
            summary="Disable this project…"
            confirm={`Disable ${p.slug}`}
          >
            <p>
              Every request to the endpoint is refused until you enable it again. Grants and tokens are kept.
            </p>
          </ConfirmAction>
        ) : (
          <Form action={`${self}/enable`} csrf={viewer.csrf} label="Enable">
            <Button variant="secondary">Enable this project</Button>
          </Form>
        )}
        <ConfirmAction
          action={`${self}/delete`}
          csrf={viewer.csrf}
          summary="Delete this project…"
          confirm={`Delete ${p.slug} for good`}
        >
          <p>Its grants and device tokens are deleted with it. This cannot be undone.</p>
        </ConfirmAction>
      </section>
    </Layout>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

export function registerProjects(ui: Hono, kit: UiKit): void {
  const tools = kit.deps.tools ?? [];
  const now = () => (kit.deps.now ?? Date.now)();
  const ctx = () => ({ publicUrl: kit.deps.publicUrl, tools, now: now() });

  const credentialsOf = async (c: Context, principal: UiPrincipal) =>
    ((await listAll(kit, c, principal, '/credentials', parseCredential)) ?? []).filter(
      (k) => k.revokedAt === null,
    );

  const detailData = async (c: Context, principal: UiPrincipal, project: Project): Promise<DetailData> => {
    const [credentials, grants, users] = await Promise.all([
      credentialsOf(c, principal),
      listAll(kit, c, principal, '/grants', parseGrant, { projectId: project.id }),
      listAll(kit, c, principal, '/users', parseUser),
    ]);
    return {
      project,
      credentials,
      grants,
      userEmails: new Map((users ?? []).map((u) => [u.id, u.email])),
    };
  };

  const load = async (c: Context, principal: UiPrincipal, id: string) => {
    const res = await kit.callAdmin(c, principal, { method: 'GET', path: adminPath`/projects/${id}` });
    return { res, project: isOk(res) ? one(res.body, parseProject) : null };
  };

  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      const cursor = validCursor(c.req.query('cursor'));
      const list = await listOne(kit, c, page.principal, '/projects', parseProject, {
        ...(cursor ? { cursor } : {}),
      });
      if (!('rows' in list)) return loadFailed(c, list, page.principal);
      return page.html(
        <Layout title="Projects" viewer={page.principal} current={BASE} flash={page.flash}>
          <p>Each project is one MCP endpoint with its own accounts, tools and limits.</p>
          <div class="actions page-actions">
            <LinkButton href={`${BASE}/new`}>New project</LinkButton>
          </div>
          <DataTable
            caption="Projects"
            empty="No projects yet. Create one to get an MCP endpoint."
            rows={list.rows}
            columns={[
              { header: 'Slug', cell: (p) => <a href={`${BASE}${adminPath`/${p.id}`}`}>{p.slug}</a> },
              { header: 'Endpoint', cell: (p) => <code>{endpointOf(undefined, p.slug)}</code> },
              { header: 'Accounts', cell: (p) => accountList(p.allowedAccountIds) },
              {
                header: 'Tools',
                cell: (p) => (p.enabledTools === null ? 'all' : String(p.enabledTools.length)),
              },
              {
                header: 'Status',
                cell: (p) =>
                  p.disabledAt === null ? (
                    <StatusBadge tone="ok" text="enabled" />
                  ) : (
                    <StatusBadge tone="error" text="disabled" />
                  ),
              },
            ]}
          />
          <Pager
            label="Project pages"
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
      const credentials = await credentialsOf(c, page.principal);
      const chosen = c.req.query('credential');
      const cred = chosen === undefined ? undefined : credentials.find((k) => k.id === chosen);
      if (chosen === undefined || (chosen !== NO_KEY && cred === undefined)) {
        return page.html(chooseKeyPage(page.principal, credentials, page.flash));
      }
      const accounts = cred?.reachableAccountIds ?? [];
      return page.html(
        createPage({
          viewer: page.principal,
          values: {
            slug: '',
            name: '',
            credentialId: cred?.id ?? null,
            accounts,
            defaultAccountId: accounts[0] ?? null,
            tools: null,
            limits: {},
          },
          errors: {},
          credentials,
          tools,
        }),
      );
    }),
  );

  ui.post(
    ROUTE,
    kit.form('admin', async (c, principal, form) => {
      const { body, values, errors } = readProjectForm(form);
      const again = async (errs: Record<string, string>, message?: string, status = 422) =>
        htmlResponse(
          createPage({
            viewer: principal,
            values,
            errors: errs,
            message,
            credentials: await credentialsOf(c, principal),
            tools,
          }),
          status,
        );
      if (Object.keys(errors).length > 0) return again(errors);
      const res = await kit.callAdmin(c, principal, { method: 'POST', path: '/projects', body }, form);
      if (isOk(res)) {
        const project = one(res.body, parseProject);
        return kit.redirect(project ? `${BASE}${adminPath`/${project.id}`}` : BASE, 'created');
      }
      const { errors: errs, message } = projectProblem(res);
      return again(errs, message);
    }),
  );

  ui.get(
    `${ROUTE}/:id`,
    kit.page('admin', async (c, page) => {
      const id = c.req.param('id');
      if (!isId(id)) return loadFailed(c, { status: 404, body: null }, page.principal);
      const { res, project } = await load(c, page.principal, id);
      if (project === null) return loadFailed(c, res, page.principal);
      return page.html(
        detailPage(page.principal, await detailData(c, page.principal, project), ctx(), {
          flash: page.flash,
        }),
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const { res: got, project } = await load(c, principal, id);
      if (project === null) return kit.redirect(BASE, flashFor(problemOf(got)));
      const { body, values, errors } = readProjectForm(form);
      const show = async (opts: Parameters<typeof detailPage>[3], status: number) =>
        htmlResponse(detailPage(principal, await detailData(c, principal, project), ctx(), opts), status);
      if (Object.keys(errors).length > 0) return show({ values, errors }, 422);
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/projects/${id}`, body },
        form,
      );
      if (!isOk(res)) {
        const problem = problemOf(res);
        if (problem.status === 404 && problem.field !== 'defaultCredentialId')
          return kit.redirect(BASE, 'not_found');
        if (problem.status === 403) return kit.redirect(`${BASE}${adminPath`/${id}`}`, 'not_allowed');
        const { errors: errs, message } = projectProblem(res);
        return show({ values, errors: errs, message }, 422);
      }
      const warnings = (res.body as { warnings?: unknown } | null)?.warnings;
      const notes = Array.isArray(warnings) ? warnings.filter((w): w is string => typeof w === 'string') : [];
      if (notes.length === 0) return kit.redirect(`${BASE}${adminPath`/${id}`}`, 'saved');
      // Saved with notes: shown on this answer (saving again changes nothing, so a reload is harmless).
      const updated = one(res.body, parseProject) ?? project;
      return htmlResponse(
        detailPage(principal, await detailData(c, principal, updated), ctx(), {
          flash: FLASH_MESSAGES.saved,
          notes,
        }),
      );
    }),
  );

  const toggle = (disabled: boolean) =>
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id') ?? '';
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const self = `${BASE}${adminPath`/${id}`}`;
      if (disabled && !confirmed(form)) {
        const { res: got, project } = await load(c, principal, id);
        if (project === null) return kit.redirect(BASE, flashFor(problemOf(got)));
        return confirmPage({
          viewer: principal,
          current: BASE,
          title: `Disable ${project.slug}?`,
          paragraphs: ['Every request to its MCP endpoint is refused until you enable it again.'],
          action: `${self}/disable`,
          confirm: `Disable ${project.slug}`,
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/projects/${id}`, body: { disabled } },
        form,
      );
      if (isOk(res)) return kit.redirect(self, disabled ? 'disabled' : 'enabled');
      const problem = problemOf(res);
      return kit.redirect(problem.status === 404 ? BASE : self, flashFor(problem));
    });
  ui.post(`${ROUTE}/:id/disable`, toggle(true));
  ui.post(`${ROUTE}/:id/enable`, toggle(false));

  ui.post(
    `${ROUTE}/:id/delete`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const self = `${BASE}${adminPath`/${id}`}`;
      if (!confirmed(form)) {
        const { res: got, project } = await load(c, principal, id);
        if (project === null) return kit.redirect(BASE, flashFor(problemOf(got)));
        return confirmPage({
          viewer: principal,
          current: BASE,
          title: `Delete ${project.slug}?`,
          paragraphs: [
            'The project is deleted with all its grants and device tokens. Clients using it stop working at once.',
            'This cannot be undone.',
          ],
          action: `${self}/delete`,
          confirm: `Delete ${project.slug} for good`,
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'DELETE', path: adminPath`/projects/${id}` },
        form,
      );
      if (isOk(res)) return kit.redirect(BASE, 'deleted');
      const problem = problemOf(res);
      return kit.redirect(problem.status === 404 ? BASE : self, flashFor(problem));
    }),
  );
}
