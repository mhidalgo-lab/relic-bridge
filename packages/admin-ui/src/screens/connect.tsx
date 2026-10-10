// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Connect page (P4-06): copy-paste client configuration for a project, and "create a token for this device".
//
//   GET /admin/connect                  snippets for the first enabled project
//   GET /admin/connect?project=<id>     snippets for that project
//
// The endpoint is built from the configured public origin, never from the Host header. No snippet here holds a
// token: tokens are stored as hashes. The inline form posts to `POST /admin/tokens`, whose one-time answer page
// repeats the snippets with the new token filled in (`no-store`).
import type { Hono } from 'hono';
import { Button, Form, Layout, LinkButton, QueryForm, SelectField, TextField } from '../components.tsx';
import { ONCE_FIELD, type UiKit } from '../kit.ts';
import { endpointFor } from '../snippets.ts';
import { SnippetList } from '../snippets.tsx';
import { isId, parseGrant, parseProject, parseUser } from './data.ts';
import { grantFor } from './grants.tsx';
import { lifecycle, listAll, loadFailed, Notes, StatusBadge } from './shared.tsx';
import { LIFETIMES } from './tokens.tsx';

const BASE = '/admin/connect';
const ROUTE = '/connect';

export function registerConnect(ui: Hono, kit: UiKit): void {
  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const [projects, grants, users] = await Promise.all([
        listAll(kit, c, principal, '/projects', parseProject),
        listAll(kit, c, principal, '/grants', parseGrant),
        listAll(kit, c, principal, '/users', parseUser),
      ]);
      if (projects === null) {
        return loadFailed(c, { status: 502, body: null }, principal);
      }
      const asked = c.req.query('project');
      const project =
        (isId(asked) ? projects.find((p) => p.id === asked) : undefined) ??
        projects.find((p) => p.disabledAt === null) ??
        projects[0];
      const t = (kit.deps.now ?? Date.now)();
      const emails = new Map((users ?? []).map((u) => [u.id, u.email]));
      const live =
        project === undefined
          ? []
          : (grants ?? []).filter((g) => g.projectId === project.id && lifecycle(g, t).text === 'active');
      return page.html(
        <Layout title="Connect a client" viewer={principal} current={BASE} flash={page.flash}>
          <p>
            Configuration for connecting an MCP client on a device to a project. Each device gets its own
            token, so a lost phone or laptop can be revoked alone.
          </p>
          {project === undefined ? (
            <p class="card">
              There is no project yet. <a href="/admin/projects/new">Create a project</a> first.
            </p>
          ) : (
            <>
              <QueryForm action={BASE} label="Choose the project">
                <SelectField
                  name="project"
                  label="Project"
                  value={project.id}
                  options={projects.map((p) => ({
                    value: p.id,
                    label: p.disabledAt === null ? p.slug : `${p.slug} (disabled)`,
                  }))}
                />
                <Button variant="secondary">Show</Button>
              </QueryForm>
              {project.disabledAt === null ? null : (
                <p class="flash flash-error" role="alert">
                  This project is disabled: clients cannot connect until it is enabled again.
                </p>
              )}
              <section aria-labelledby="token-heading">
                <h2 id="token-heading">Create a token for this device</h2>
                {live.length === 0 ? (
                  <p class="card">
                    This project has no active grant. <a href="/admin/grants/new">Create a grant</a> first.
                  </p>
                ) : (
                  <Form action="/admin/tokens" csrf={principal.csrf} label="Create a device token">
                    <input type="hidden" name={ONCE_FIELD} value={await kit.issueOnce(principal)} />
                    <SelectField
                      name="grantId"
                      label="Grant"
                      options={live.map((g) => ({ value: g.id, label: grantFor(g, emails) }))}
                    />
                    <TextField
                      name="label"
                      label="Device name"
                      hint="e.g. laptop, work-pc, phone."
                      required
                      maxlength={100}
                    />
                    <SelectField
                      name="lifetime"
                      label="Lifetime"
                      value="90"
                      options={LIFETIMES.map(([value, label]) => ({ value, label }))}
                    />
                    <div class="actions">
                      <Button>Create token and show snippets</Button>
                      <LinkButton href="/admin/tokens" variant="secondary">
                        Existing tokens
                      </LinkButton>
                    </div>
                  </Form>
                )}
              </section>
              <section aria-labelledby="snippets-heading">
                <h2 id="snippets-heading">
                  Client configuration <StatusBadge tone="info" text={project.slug} />
                </h2>
                <Notes
                  title="Before you paste"
                  items={[
                    'These snippets never contain a token: tokens are stored as hashes and cannot be shown again.',
                    'Paste the token only into the device’s own client or secret store, never into a chat, ticket or repository.',
                    'The address must be https. A token sent over plain HTTP can be read on the way.',
                  ]}
                />
                <SnippetList
                  endpoint={endpointFor(kit.deps.publicUrl, project.slug)}
                  slug={project.slug}
                  idPrefix="snippet"
                />
              </section>
            </>
          )}
        </Layout>,
      );
    }),
  );
}
