// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Apps connected with OAuth (P5-05): the table "My access" and a user's page share. One row per app authorization
// (claude.ai, Claude Code, a phone…). The client name is untrusted text from the app's registration: always escaped
// plain text, never a link; a metadata-document app is shown with the host that vouches for it, a dynamically
// registered one is marked "not verified" (as on the consent page, P5-04).
import type { JSX } from 'hono/jsx/jsx-runtime';
import { DataTable } from '../components.tsx';
import type { OAuthDevice } from './data.ts';
import { RowAction, StatusBadge, When } from './shared.tsx';

/** How an app is named in tables and confirmation pages (plain text). */
export function appName(d: OAuthDevice): string {
  const name = d.clientName ?? 'An unnamed app';
  return d.label === null ? name : `${name} (${d.label})`;
}

function client(d: OAuthDevice): JSX.Element {
  return (
    <span>
      {d.clientName ?? 'An unnamed app'}{' '}
      {d.clientKind === 'metadata_document' && d.clientHost !== null ? (
        <span class="muted">
          by <code>{d.clientHost}</code>
        </span>
      ) : (
        <StatusBadge tone="muted" text="not verified" />
      )}
    </span>
  );
}

export function OAuthDevicesTable(props: {
  readonly caption: string;
  readonly rows: readonly OAuthDevice[];
  readonly csrf: string;
  /** Grant id → how to name it (optional). */
  readonly grantNames?: ReadonlyMap<string, string>;
  /** The revoke form's action for a row (null: no action, e.g. an owner's app seen by an admin). */
  readonly revokeAction: (d: OAuthDevice) => string | null;
}): JSX.Element {
  return (
    <DataTable
      caption={props.caption}
      empty="No apps connected with OAuth."
      rows={[...props.rows]}
      columns={[
        { header: 'App', cell: (d) => client(d) },
        { header: 'Device', cell: (d) => d.label ?? '—' },
        { header: 'Project', cell: (d) => d.projectSlug ?? '—' },
        {
          header: 'Grant',
          cell: (d) => (d.grantId === null ? '—' : (props.grantNames?.get(d.grantId) ?? d.grantId)),
        },
        { header: 'Connected', cell: (d) => <When at={d.createdAt} /> },
        { header: 'Asks again', cell: (d) => <When at={d.expiresAt} none="never" /> },
        {
          header: 'Action',
          cell: (d) => {
            const action = props.revokeAction(d);
            return action === null ? (
              '—'
            ) : (
              <RowAction
                action={action}
                csrf={props.csrf}
                label="Disconnect…"
                name={`Disconnect ${appName(d)}`}
              />
            );
          },
        },
      ]}
    />
  );
}
