// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Grants (P4-04): who may use a project (a person or a service), with which key, tools, accounts, rate and expiry.
// Access is always the intersection of the grant and its project; the API has no general grant update (revoke and
// recreate). The one change in place is the usage quota (P7-12).
//
//   GET  /admin/grants                    list (filters: project, user; cursor pages)
//   GET  /admin/grants/new                step 1: choose the project
//   GET  /admin/grants/new?project=<id>   step 2: the grant form
//   POST /admin/grants                    create
//   GET  /admin/grants/:id                detail with its device tokens
//   POST /admin/grants/:id/quota          set or remove the usage quota (blank fields remove it)
//   POST /admin/grants/:id/revoke         revoke (needs confirm=yes): every token of it stops
//   POST /admin/grants/:id/delete         delete with its tokens (needs confirm=yes)
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
  QueryForm,
  SelectField,
  TextField,
} from '../components.tsx';
import { adminPath, type UiKit, type UiPrincipal, type UiTool, type VerifiedForm } from '../kit.ts';
import { htmlResponse } from '../pages.tsx';
import { credentialOption } from './credentials.tsx';
import {
  type Credential,
  type Grant,
  isId,
  one,
  type Project,
  parseCredential,
  parseGrant,
  parseProject,
  parseToken,
  parseUser,
  type Quota,
  type Token,
  type User,
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
  lifecycle,
  listAll,
  listOne,
  loadFailed,
  Notes,
  OwnerOnlyNote,
  ownerLock,
  positiveInt,
  problemOf,
  RowAction,
  StatusBadge,
  ToolChecklist,
  toolsFrom,
  When,
  withQuery,
} from './shared.tsx';

const BASE = '/admin/grants';
/** Route paths inside the `/admin` sub-app. */
const ROUTE = '/grants';
const SERVICE = 'service';
const DAY = 86_400_000;
const MAX_EXPIRY_DAYS = 3650;

/** Who a grant is for, in words. */
export const grantFor = (g: Grant, emails: ReadonlyMap<string, string>): string =>
  g.userId === null
    ? `service: ${g.label ?? g.id}`
    : `${emails.get(g.userId) ?? g.userId}${g.label ? ` (${g.label})` : ''}`;

/** Parts of a grant its project does not allow: stored, but without effect. */
export function noEffect(g: Grant, p: Project): string[] {
  const out: string[] = [];
  if (g.tools !== null && p.enabledTools !== null) {
    const outside = g.tools.filter((t) => !p.enabledTools?.includes(t));
    if (outside.length > 0) out.push(`Tools not enabled on the project: ${outside.join(', ')}.`);
  }
  if (g.accountIds !== null) {
    const outside = g.accountIds.filter((a) => !p.allowedAccountIds.includes(a));
    if (outside.length > 0) out.push(`Accounts not allowed on the project: ${outside.join(', ')}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The grant form
// ---------------------------------------------------------------------------------------------------------------

interface GrantValues {
  readonly userId: string;
  readonly label: string;
  readonly credentialId: string;
  readonly tools: readonly string[] | null;
  readonly accounts: readonly number[] | null;
  readonly requests: string;
  readonly perSeconds: string;
  readonly expiresDays: string;
}

interface GrantFormProps {
  readonly viewer: UiPrincipal;
  readonly project: Project;
  readonly users: readonly User[];
  readonly credentials: readonly Credential[];
  readonly tools: readonly UiTool[];
  readonly values: GrantValues;
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
}

/**
 * The tools a grant on `p` can choose from: what the project enables. A project with every tool (`null`) enables the read
 * tools only: write tools must be named by the project first (P7-09).
 */
function toolsOfProject(p: { readonly enabledTools: readonly string[] | null }, tools: readonly UiTool[]) {
  return p.enabledTools === null
    ? tools.filter((t) => t.kind === 'read')
    : tools.filter((t) => p.enabledTools?.includes(t.name));
}

function grantFormPage(props: GrantFormProps) {
  const p = props.project;
  const v = props.values;
  const projectTools = toolsOfProject(p, props.tools);
  const def = props.credentials.find((c) => c.id === p.defaultCredentialId);
  const emails = new Map(props.users.map((u) => [u.id, u.email]));
  return (
    <Layout title={`New grant on ${p.slug}`} viewer={props.viewer} current={BASE}>
      <p>
        Step 2 of 2. The grant can only narrow what the project allows. Device tokens are issued for it
        afterwards. <a href={`${BASE}/new`}>Choose another project</a>
      </p>
      <FormError message={props.message} />
      <Form action={BASE} csrf={props.viewer.csrf} label="New grant">
        <input type="hidden" name="projectId" value={p.id} />
        <SelectField
          name="userId"
          label="For"
          hint="A person (their sign-in user) or a service such as a CI job."
          value={v.userId}
          error={props.errors['userId']}
          options={[
            ...props.users
              .filter((u) => u.disabledAt === null && !ownerLock(props.viewer, props.users)(u.id))
              .map((u) => ({
                value: u.id,
                label: u.displayName ? `${u.displayName} <${u.email}>` : u.email,
              })),
            { value: SERVICE, label: 'A service (no person)' },
          ]}
        />
        <TextField
          name="label"
          label="Label"
          hint="Required for a service, e.g. ci-nightly. Optional for a person."
          value={v.label}
          maxlength={100}
          error={props.errors['label']}
        />
        <SelectField
          name="credentialId"
          label="New Relic key"
          hint="The project default, a shared key, or the person's own key (bring your own key). Not another person's key."
          value={v.credentialId}
          error={props.errors['credentialId']}
          options={[
            {
              value: '',
              label: def
                ? `Project default: ${credentialOption(def)}`
                : 'Project default (the project has none)',
            },
            ...props.credentials
              .filter((c) => !ownerLock(props.viewer, props.users)(c.ownerUserId))
              .map((c) => ({
                value: c.id,
                label: `${c.ownerUserId === null ? 'Shared' : `Personal (${emails.get(c.ownerUserId) ?? c.ownerUserId})`}: ${credentialOption(c)}`,
              })),
          ]}
        />
        <ToolChecklist
          tools={projectTools}
          selected={v.tools}
          legend="Tools"
          allLabel="Every tool the project enables"
          allHint="Untick to choose a subset below."
          error={props.errors['tools']}
        />
        <fieldset class="field">
          <legend>Accounts</legend>
          <Checkbox
            name="accounts_all"
            id="accounts-all"
            label="Every account the project allows"
            hint="Untick to choose a subset below."
            checked={v.accounts === null}
          />
          <AccountChecklist
            name="accounts"
            legend="Only these accounts"
            accounts={p.allowedAccountIds}
            selected={v.accounts ?? []}
            error={props.errors['accounts']}
          />
        </fieldset>
        <fieldset class="field">
          <legend>Rate limit (optional)</legend>
          <p class="hint">Both blank: no grant-specific limit.</p>
          <TextField
            name="rate_requests"
            label="Requests"
            type="number"
            inputmode="numeric"
            min={1}
            max={1000000}
            value={v.requests}
            error={props.errors['rate_requests']}
          />
          <TextField
            name="rate_seconds"
            label="Per seconds"
            type="number"
            inputmode="numeric"
            min={1}
            max={86400}
            value={v.perSeconds}
            error={props.errors['rate_seconds']}
          />
        </fieldset>
        <TextField
          name="expires_days"
          label="Expires after (days, optional)"
          hint="Blank: never. The grant and its tokens stop working then."
          type="number"
          inputmode="numeric"
          min={1}
          max={MAX_EXPIRY_DAYS}
          value={v.expiresDays}
          error={props.errors['expires_days']}
        />
        <div class="actions">
          <Button>Create grant</Button>
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

export function registerGrants(ui: Hono, kit: UiKit): void {
  const catalog = kit.deps.tools ?? [];
  const now = () => (kit.deps.now ?? Date.now)();

  const loadProject = async (c: Context, principal: UiPrincipal, id: string) => {
    const res = await kit.callAdmin(c, principal, { method: 'GET', path: adminPath`/projects/${id}` });
    return { res, project: isOk(res) ? one(res.body, parseProject) : null };
  };
  const loadGrant = async (c: Context, principal: UiPrincipal, id: string) => {
    const res = await kit.callAdmin(c, principal, { method: 'GET', path: adminPath`/grants/${id}` });
    return { res, grant: isOk(res) ? one(res.body, parseGrant) : null };
  };
  const pickers = async (c: Context, principal: UiPrincipal) => {
    const [users, credentials] = await Promise.all([
      listAll(kit, c, principal, '/users', parseUser),
      listAll(kit, c, principal, '/credentials', parseCredential),
    ]);
    return { users: users ?? [], credentials: (credentials ?? []).filter((k) => k.revokedAt === null) };
  };

  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const cursor = validCursor(c.req.query('cursor'));
      const project = c.req.query('project');
      const user = c.req.query('user');
      const filter = {
        ...(isId(project) ? { projectId: project } : {}),
        ...(isId(user) ? { userId: user } : {}),
      };
      const list = await listOne(kit, c, principal, '/grants', parseGrant, {
        ...filter,
        ...(cursor ? { cursor } : {}),
      });
      if (!('rows' in list)) return loadFailed(c, list, principal);
      const [projects, users] = await Promise.all([
        listAll(kit, c, principal, '/projects', parseProject),
        listAll(kit, c, principal, '/users', parseUser),
      ]);
      const slugs = new Map((projects ?? []).map((p) => [p.id, p.slug]));
      const emails = new Map((users ?? []).map((u) => [u.id, u.email]));
      const t = now();
      const here = withQuery(BASE, { project: filter.projectId, user: filter.userId });
      return page.html(
        <Layout title="Grants" viewer={principal} current={BASE} flash={page.flash}>
          <p>A grant lets a person or a service use one project. Devices connect with the grant's tokens.</p>
          <div class="actions page-actions">
            <LinkButton href={withQuery(`${BASE}/new`, { project: filter.projectId })}>New grant</LinkButton>
          </div>
          <QueryForm action={BASE} label="Filter grants">
            <SelectField
              name="project"
              label="Project"
              value={filter.projectId ?? ''}
              options={[
                { value: '', label: 'All projects' },
                ...(projects ?? []).map((p) => ({ value: p.id, label: p.slug })),
              ]}
            />
            <SelectField
              name="user"
              label="Person"
              value={filter.userId ?? ''}
              options={[
                { value: '', label: 'Everyone' },
                ...(users ?? []).map((u) => ({ value: u.id, label: u.email })),
              ]}
            />
            <Button variant="secondary">Filter</Button>
          </QueryForm>
          <DataTable
            caption="Grants"
            empty={
              Object.keys(filter).length > 0
                ? 'No grants match this filter.'
                : 'No grants yet. Create one to connect a device.'
            }
            rows={list.rows}
            columns={[
              {
                header: 'For',
                cell: (g) => <a href={`${BASE}${adminPath`/${g.id}`}`}>{grantFor(g, emails)}</a>,
              },
              { header: 'Project', cell: (g) => slugs.get(g.projectId) ?? g.projectId },
              { header: 'Status', cell: (g) => <StatusBadge {...lifecycle(g, t)} /> },
              { header: 'Expires', cell: (g) => <When at={g.expiresAt} none="never" /> },
              { header: 'Created', cell: (g) => <When at={g.createdAt} /> },
            ]}
          />
          <Pager
            label="Grant pages"
            next={
              list.nextCursor === null
                ? null
                : withQuery(BASE, { project: filter.projectId, user: filter.userId, cursor: list.nextCursor })
            }
            first={cursor === undefined ? undefined : here}
          />
        </Layout>,
      );
    }),
  );

  ui.get(
    `${ROUTE}/new`,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const chosen = c.req.query('project');
      const { project } = isId(chosen) ? await loadProject(c, principal, chosen) : { project: null };
      if (project === null) {
        const projects = (await listAll(kit, c, principal, '/projects', parseProject)) ?? [];
        return page.html(
          <Layout title="New grant" viewer={principal} current={BASE} flash={page.flash}>
            <p>Step 1 of 2: choose the project the grant is for.</p>
            {projects.length === 0 ? (
              <p class="card">
                There are no projects yet. <a href="/admin/projects/new">Create a project</a> first.
              </p>
            ) : (
              <QueryForm action={`${BASE}/new`} label="Choose the project">
                <SelectField
                  name="project"
                  label="Project"
                  options={projects.map((p) => ({ value: p.id, label: p.slug }))}
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
      }
      const { users, credentials } = await pickers(c, principal);
      return page.html(
        grantFormPage({
          viewer: principal,
          project,
          users,
          credentials,
          tools: catalog,
          values: {
            userId: users.find((u) => u.id === principal.userId)?.id ?? SERVICE,
            label: '',
            credentialId: '',
            tools: null,
            accounts: null,
            requests: '',
            perSeconds: '',
            expiresDays: '',
          },
          errors: {},
        }),
      );
    }),
  );

  ui.post(
    ROUTE,
    kit.form('admin', async (c, principal, form) => {
      const projectId = field(form, 'projectId');
      if (!isId(projectId)) return kit.redirect(`${BASE}/new`, 'not_found');
      const { res: got, project } = await loadProject(c, principal, projectId);
      if (project === null) return kit.redirect(`${BASE}/new`, flashFor(problemOf(got)));

      const errors: Record<string, string> = {};
      const rawUser = field(form, 'userId') ?? SERVICE;
      const userId = rawUser === SERVICE ? null : rawUser;
      if (userId !== null && !isId(userId)) errors['userId'] = 'Choose a person from the list.';
      const label = field(form, 'label');
      if (label !== null && label.length > 100) errors['label'] = 'At most 100 characters.';
      if (userId === null && label === null) errors['label'] = 'A service grant needs a label.';
      const credentialId = field(form, 'credentialId');
      if (credentialId !== null && !isId(credentialId))
        errors['credentialId'] = 'Choose a key from the list.';
      const tools = toolsFrom(form, toolsOfProject(project, catalog));
      if ('error' in tools) errors['tools'] = tools.error;
      const allAccounts = form.fields.get('accounts_all') !== null;
      const accounts = allAccounts ? null : accountsFrom(form, 'accounts');
      if (accounts !== null && accounts.length === 0) {
        errors['accounts'] = 'Choose at least one account, or every account the project allows.';
      }
      const requests = positiveInt(form, 'rate_requests', 1_000_000);
      const perSeconds = positiveInt(form, 'rate_seconds', 86_400);
      if (requests === null) errors['rate_requests'] = 'A whole number from 1 to 1000000.';
      if (perSeconds === null) errors['rate_seconds'] = 'A whole number from 1 to 86400.';
      if (
        (requests === undefined) !== (perSeconds === undefined) &&
        requests !== null &&
        perSeconds !== null
      ) {
        errors[requests === undefined ? 'rate_requests' : 'rate_seconds'] = 'Fill in both, or neither.';
      }
      const days = positiveInt(form, 'expires_days', MAX_EXPIRY_DAYS);
      if (days === null) errors['expires_days'] = `A whole number of days from 1 to ${MAX_EXPIRY_DAYS}.`;

      const values: GrantValues = {
        userId: rawUser,
        label: label ?? '',
        credentialId: credentialId ?? '',
        tools: 'value' in tools ? tools.value : [],
        accounts,
        requests: form.fields.get('rate_requests') ?? '',
        perSeconds: form.fields.get('rate_seconds') ?? '',
        expiresDays: form.fields.get('expires_days') ?? '',
      };
      const again = async (errs: Record<string, string>, message?: string) => {
        const { users, credentials } = await pickers(c, principal);
        return htmlResponse(
          grantFormPage({
            viewer: principal,
            project,
            users,
            credentials,
            tools: catalog,
            values,
            errors: errs,
            message,
          }),
          422,
        );
      };
      if (Object.keys(errors).length > 0) return again(errors);

      const body = {
        projectId,
        userId,
        label,
        credentialId,
        tools: values.tools,
        accountIds: accounts,
        ...(typeof requests === 'number' && typeof perSeconds === 'number'
          ? { rateLimit: { requests, perSeconds } }
          : {}),
        ...(typeof days === 'number' ? { expiresAt: now() + days * DAY } : {}),
      };
      const res = await kit.callAdmin(c, principal, { method: 'POST', path: '/grants', body }, form);
      if (isOk(res)) {
        const grant = one(res.body, parseGrant);
        const warnings = (res.body as { warnings?: unknown } | null)?.warnings;
        const noted = Array.isArray(warnings) && warnings.length > 0;
        return kit.redirect(
          grant ? `${BASE}${adminPath`/${grant.id}`}` : BASE,
          noted ? 'created_with_notes' : 'created',
        );
      }
      const problem = problemOf(res);
      const at = (
        {
          userId: 'userId',
          label: 'label',
          credentialId: 'credentialId',
          tools: 'tools',
          accountIds: 'accounts',
          rateLimit: 'rate_requests',
          expiresAt: 'expires_days',
        } as Record<string, string>
      )[(problem.field ?? '').split('.')[0] ?? ''];
      if (problem.status === 404 && problem.field === 'projectId')
        return kit.redirect(`${BASE}/new`, 'not_found');
      if (at !== undefined && [400, 404, 422].includes(problem.status)) {
        return again({
          [at]: problem.status === 404 ? 'That no longer exists: choose again.' : problem.message,
        });
      }
      return again({}, formMessage(problem));
    }),
  );

  ui.get(
    `${ROUTE}/:id`,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return loadFailed(c, { status: 404, body: null }, principal);
      const { res, grant } = await loadGrant(c, principal, id);
      if (grant === null) return loadFailed(c, res, principal);
      const [{ project }, tokens, users, credentials] = await Promise.all([
        loadProject(c, principal, grant.projectId),
        listAll(kit, c, principal, '/tokens', parseToken, { grantId: grant.id }),
        listAll(kit, c, principal, '/users', parseUser),
        listAll(kit, c, principal, '/credentials', parseCredential),
      ]);
      const emails = new Map((users ?? []).map((u) => [u.id, u.email]));
      const cred = (credentials ?? []).find(
        (k) => k.id === (grant.credentialId ?? project?.defaultCredentialId),
      );
      const t = now();
      const self = `${BASE}${adminPath`/${grant.id}`}`;
      const active = grant.revokedAt === null;
      // An administrator gets `403 owner` on an owner's grant or on a grant using an owner's key: no controls then.
      const credentialOwner = (credentials ?? []).find((k) => k.id === grant.credentialId)?.ownerUserId;
      const locked = ownerLock(principal, users)(grant.userId, credentialOwner);
      return page.html(
        <Layout
          title={`Grant: ${grantFor(grant, emails)}`}
          viewer={principal}
          current={BASE}
          flash={page.flash}
        >
          {project === null ? null : <Notes title="Parts with no effect" items={noEffect(grant, project)} />}
          <section class="card" aria-labelledby="facts-heading">
            <h2 id="facts-heading">Summary</h2>
            <Facts
              items={[
                ['For', grantFor(grant, emails)],
                [
                  'Project',
                  project === null ? (
                    grant.projectId
                  ) : (
                    <a href={adminPath`/admin/projects/${project.id}`}>{project.slug}</a>
                  ),
                ],
                ['Status', <StatusBadge {...lifecycle(grant, t)} />],
                [
                  'New Relic key',
                  cred === undefined ? (
                    grant.credentialId === null ? (
                      'project default (none set)'
                    ) : (
                      grant.credentialId
                    )
                  ) : (
                    <>
                      {grant.credentialId === null ? 'project default: ' : ''}
                      <a href={adminPath`/admin/credentials/${cred.id}`}>{credentialOption(cred)}</a>
                    </>
                  ),
                ],
                ['Tools', grant.tools === null ? 'every tool the project enables' : grant.tools.join(', ')],
                ['Accounts', accountList(grant.accountIds, 'every account the project allows')],
                [
                  'Rate limit',
                  grant.rateLimit === null
                    ? 'none of its own'
                    : `${grant.rateLimit.requests} requests per ${grant.rateLimit.perSeconds} s`,
                ],
                ['Usage quota', quotaSummary(grant.quota)],
                ['Expires', <When at={grant.expiresAt} none="never" />],
                ['Created', <When at={grant.createdAt} />],
                ...(grant.revokedAt === null ? [] : [['Revoked', <When at={grant.revokedAt} />] as const]),
              ]}
            />
          </section>

          <section aria-labelledby="tokens-heading">
            <h2 id="tokens-heading">Device tokens</h2>
            {active && !locked ? (
              <div class="actions page-actions">
                <LinkButton href={withQuery('/admin/tokens/new', { grant: grant.id })}>
                  New device token
                </LinkButton>
              </div>
            ) : null}
            {tokens === null ? (
              <p class="muted">The tokens could not be loaded.</p>
            ) : (
              <TokenTable tokens={tokens} viewer={principal} now={t} locked={locked} />
            )}
          </section>

          <section aria-labelledby="quota-heading">
            <h2 id="quota-heading">Usage quota</h2>
            <p>
              Caps what this grant may spend of the shared New Relic key per UTC day and month. Only real New
              Relic calls count (a result served from the query cache is free). Past a cap the connection gets
              a clear error until the period ends; before that, results carry a warning.{' '}
              <a href="/admin/usage#quotas-heading">See current usage</a>
            </p>
            {active && !locked ? (
              <QuotaForm action={`${self}/quota`} csrf={principal.csrf} values={quotaValues(grant.quota)} />
            ) : (
              <p class="muted">
                {locked ? 'Only an owner changes this grant.' : 'A revoked grant has no use to cap.'}
              </p>
            )}
          </section>

          <section aria-labelledby="danger-heading">
            <h2 id="danger-heading">Revoke or delete</h2>
            <p>
              Apart from its quota, a grant cannot be changed: to change anything else, create a new one and
              revoke this one.
            </p>
            {locked ? <OwnerOnlyNote /> : null}
            {active && !locked ? (
              <ConfirmAction
                action={`${self}/revoke`}
                csrf={principal.csrf}
                summary="Revoke this grant…"
                confirm="Revoke the grant"
              >
                <p>
                  Every device token of this grant stops working at once. The grant stays listed as revoked.
                </p>
              </ConfirmAction>
            ) : null}
            {locked ? null : (
              <ConfirmAction
                action={`${self}/delete`}
                csrf={principal.csrf}
                summary="Delete this grant…"
                confirm="Delete the grant for good"
              >
                <p>The grant and its device tokens are deleted. This cannot be undone.</p>
              </ConfirmAction>
            )}
          </section>
        </Layout>,
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id/quota`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id') ?? '';
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const self = `${BASE}${adminPath`/${id}`}`;
      const parsed = quotaFrom(form);
      if ('errors' in parsed) {
        const { res, grant } = await loadGrant(c, principal, id);
        if (grant === null) return kit.redirect(BASE, flashFor(problemOf(res)));
        return htmlResponse(
          <Layout title="Usage quota" viewer={principal} current={BASE}>
            <p>
              <a href={self}>Back to the grant</a>
            </p>
            <QuotaForm
              action={`${self}/quota`}
              csrf={principal.csrf}
              values={parsed.values}
              errors={parsed.errors}
            />
          </Layout>,
          422,
        );
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PUT', path: adminPath`/grants/${id}/quota`, body: { quota: parsed.quota } },
        form,
      );
      if (isOk(res)) return kit.redirect(self, parsed.quota === null ? 'quota_removed' : 'saved');
      const problem = problemOf(res);
      return kit.redirect(problem.status === 404 ? BASE : self, flashFor(problem));
    }),
  );

  const destructive = (kind: 'revoke' | 'delete') =>
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id') ?? '';
      if (!isId(id)) return kit.redirect(BASE, 'not_found');
      const self = `${BASE}${adminPath`/${id}`}`;
      if (!confirmed(form)) {
        const { res: got, grant } = await loadGrant(c, principal, id);
        if (grant === null) return kit.redirect(BASE, flashFor(problemOf(got)));
        return confirmPage({
          viewer: principal,
          current: BASE,
          title: kind === 'revoke' ? 'Revoke this grant?' : 'Delete this grant?',
          paragraphs:
            kind === 'revoke'
              ? ['Every device token of this grant stops working at once.']
              : ['The grant and its device tokens are deleted. This cannot be undone.'],
          action: `${self}/${kind}`,
          confirm: kind === 'revoke' ? 'Revoke the grant' : 'Delete the grant for good',
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        kind === 'revoke'
          ? { method: 'POST', path: adminPath`/grants/${id}/revoke` }
          : { method: 'DELETE', path: adminPath`/grants/${id}` },
        form,
      );
      if (isOk(res))
        return kit.redirect(kind === 'revoke' ? self : BASE, kind === 'revoke' ? 'revoked' : 'deleted');
      const problem = problemOf(res);
      return kit.redirect(problem.status === 404 ? BASE : self, flashFor(problem));
    });
  ui.post(`${ROUTE}/:id/revoke`, destructive('revoke'));
  ui.post(`${ROUTE}/:id/delete`, destructive('delete'));
}

// ---------------------------------------------------------------------------------------------------------------
// Usage quota (P7-12)
// ---------------------------------------------------------------------------------------------------------------

const QUOTA_MAX = 9_999_999_999_999;
const QUOTA_FIELDS = ['day_queries', 'day_events', 'month_queries', 'month_events', 'warn'] as const;
type QuotaField = (typeof QUOTA_FIELDS)[number];
type QuotaValues = Readonly<Record<QuotaField, string>>;

const capText = (n: number | null): string => (n === null ? '' : String(n));

export function quotaValues(q: Quota | null): QuotaValues {
  return {
    day_queries: capText(q?.day?.queries ?? null),
    day_events: capText(q?.day?.inspectedEvents ?? null),
    month_queries: capText(q?.month?.queries ?? null),
    month_events: capText(q?.month?.inspectedEvents ?? null),
    warn: q === null ? '' : String(q.warnPercent),
  };
}

/** The quota in words, for the grant summary. */
export function quotaSummary(q: Quota | null): string {
  if (q === null) return 'none';
  const part = (name: string, caps: { queries: number | null; inspectedEvents: number | null } | null) => {
    if (caps === null) return null;
    const items = [
      caps.queries === null ? null : `${caps.queries.toLocaleString('en-US')} calls`,
      caps.inspectedEvents === null ? null : `${caps.inspectedEvents.toLocaleString('en-US')} events`,
    ].filter((x): x is string => x !== null);
    return items.length === 0 ? null : `per ${name}: ${items.join(', ')}`;
  };
  const parts = [part('day', q.day), part('month', q.month)].filter((x): x is string => x !== null);
  return `${parts.join('; ')} (warning at ${q.warnPercent}%)`;
}

/** The form's quota: caps per period; blank everywhere removes the quota. Errors name fields, never echo input. */
function quotaFrom(
  form: VerifiedForm,
): { quota: object | null } | { errors: Record<string, string>; values: QuotaValues } {
  const errors: Record<string, string> = {};
  const numbers: Partial<Record<QuotaField, number>> = {};
  for (const name of QUOTA_FIELDS) {
    const max = name === 'warn' ? 99 : QUOTA_MAX;
    const n = positiveInt(form, name, max);
    if (n === null) errors[name] = `A whole number from 1 to ${max}, or leave it blank.`;
    else if (n !== undefined) numbers[name] = n;
  }
  const values = Object.fromEntries(QUOTA_FIELDS.map((n) => [n, form.fields.get(n) ?? ''])) as QuotaValues;
  const period = (queries: number | undefined, events: number | undefined) =>
    queries === undefined && events === undefined
      ? undefined
      : {
          ...(queries === undefined ? {} : { queries }),
          ...(events === undefined ? {} : { inspectedEvents: events }),
        };
  const day = period(numbers.day_queries, numbers.day_events);
  const month = period(numbers.month_queries, numbers.month_events);
  if (day === undefined && month === undefined) {
    if (numbers.warn !== undefined) errors['warn'] = 'Set a cap first, or leave this blank.';
    if (Object.keys(errors).length === 0) return { quota: null };
  }
  if (Object.keys(errors).length > 0) return { errors, values };
  return {
    quota: {
      ...(day === undefined ? {} : { day }),
      ...(month === undefined ? {} : { month }),
      ...(numbers.warn === undefined ? {} : { warnPercent: numbers.warn }),
    },
  };
}

function QuotaForm(props: {
  readonly action: string;
  readonly csrf: string;
  readonly values: QuotaValues;
  readonly errors?: Readonly<Record<string, string>>;
}): JSX.Element {
  const v = props.values;
  const e = props.errors ?? {};
  return (
    <Form action={props.action} csrf={props.csrf} label="Usage quota">
      <TextField
        name="day_queries"
        label="Calls per day"
        hint="New Relic calls per UTC day. Leave blank for no cap."
        value={v.day_queries}
        error={e['day_queries']}
        inputmode="numeric"
      />
      <TextField
        name="day_events"
        label="Events inspected per day"
        hint="Events New Relic scanned for NRQL queries, per UTC day. Checked before each call, so one query can overshoot."
        value={v.day_events}
        error={e['day_events']}
        inputmode="numeric"
      />
      <TextField
        name="month_queries"
        label="Calls per month"
        hint="Per UTC month. Leave blank for no cap."
        value={v.month_queries}
        error={e['month_queries']}
        inputmode="numeric"
      />
      <TextField
        name="month_events"
        label="Events inspected per month"
        value={v.month_events}
        error={e['month_events']}
        inputmode="numeric"
      />
      <TextField
        name="warn"
        label="Warn at percent"
        hint="Results carry a warning from this share of a cap (1 to 99, default 80)."
        value={v.warn}
        error={e['warn']}
        inputmode="numeric"
      />
      <p class="muted">Leave every field blank to remove the quota. Usage so far is kept.</p>
      <Button>Save quota</Button>
    </Form>
  );
}

/** Tokens of one grant, with a revoke button per live token (confirmation on the next page). */
export function TokenTable(props: {
  readonly tokens: readonly Token[];
  readonly viewer: UiPrincipal;
  readonly now: number;
  /** The grant is an owner's and the viewer is an administrator: the API refuses a revoke (403 owner). */
  readonly locked?: boolean;
}): JSX.Element {
  return (
    <DataTable
      caption="Device tokens"
      empty="No device tokens yet."
      rows={props.tokens}
      columns={[
        { header: 'Device', cell: (t) => t.label },
        { header: 'Token', cell: (t) => <code>{`${t.prefix}…`}</code> },
        { header: 'Status', cell: (t) => <StatusBadge {...lifecycle(t, props.now)} /> },
        { header: 'Last used', cell: (t) => <When at={t.lastUsedAt} none="never" /> },
        { header: 'Expires', cell: (t) => <When at={t.expiresAt} none="never" /> },
        {
          header: 'Action',
          cell: (t) =>
            t.revokedAt === null && props.locked !== true ? (
              <RowAction
                action={adminPath`/admin/tokens/${t.id}/revoke`}
                csrf={props.viewer.csrf}
                label="Revoke…"
                name={`Revoke ${t.label}`}
              />
            ) : (
              '—'
            ),
        },
      ]}
    />
  );
}
