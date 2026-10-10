// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// The OAuth consent screen and the remembered-approvals page (P5-04, THREAT_MODEL T10/T13). Pure views: the HTTP app
// (`packages/http-app/src/oauth/consent.ts`) decides what they show. Phishing resistance: the client's name is shown as
// untrusted text and marked unverified unless its metadata document's host vouches for it, and where the answer goes
// (the redirect host) is as prominent as the name.
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  Badge,
  CSRF_FIELD,
  DataTable,
  Facts,
  Form,
  Layout,
  localHref,
  TextField,
  Time,
  type UiViewer,
} from './components.tsx';

/** One of the signed-in user's grants on the project, as the consent form offers it. */
export interface ConsentGrantOption {
  readonly id: string;
  /** The grant's label, or a fixed fallback. */
  readonly label: string;
  /** Tool titles the grant allows (effective access). */
  readonly tools: readonly string[];
  /** New Relic account ids the grant allows (effective access). */
  readonly accounts: readonly number[];
  /** Epoch ms, or null. */
  readonly expiresAt: number | null;
}

/** Who is asking and where the answer goes (from the validated authorization request). */
export interface ConsentClient {
  /** Untrusted display text (already checked for control/bidi characters); null when the client gave none. */
  readonly name: string | null;
  /** `metadata_document`: identified by its https client id's host (`host`). `dynamic`: nothing is verified. */
  readonly kind: 'metadata_document' | 'dynamic';
  readonly host: string | null;
  /** Host (and port) of the redirect URI: where the authorization code is sent. */
  readonly redirectHost: string;
  /** The redirect goes to this computer (`localhost`, `127.0.0.1`, `[::1]`). */
  readonly loopback: boolean;
}

export interface ConsentPageProps {
  readonly viewer: UiViewer;
  /** Same-origin path the form posts to (carries the authorization request's query). */
  readonly action: string;
  readonly client: ConsentClient;
  readonly project: { readonly slug: string; readonly name: string | null };
  readonly grants: readonly ConsentGrantOption[];
  /** The client asked for a refresh token (stays connected until revoked or unused). */
  readonly offline: boolean;
  /** Pre-selected grant id. */
  readonly selected?: string | undefined;
  /** Device label field value. */
  readonly label?: string | undefined;
  /** A fixed message about the last submission. */
  readonly error?: string | undefined;
  /** Same-origin path of the remembered-approvals page. */
  readonly approvalsHref: string;
  /** Days a remembered approval lasts. */
  readonly rememberDays: number;
}

/** Field names of the consent form. */
export const CONSENT_FIELDS: {
  readonly decision: 'decision';
  readonly grant: 'grant';
  readonly label: 'label';
  readonly remember: 'remember';
} = Object.freeze({
  decision: 'decision',
  grant: 'grant',
  label: 'label',
  remember: 'remember',
} as const);

/** Longest device label the form accepts. */
export const CONSENT_LABEL_MAX = 60;

function ClientIdentity(props: { readonly client: ConsentClient }): JSX.Element {
  const { client } = props;
  return (
    <section class="card" aria-labelledby="consent-who">
      <h2 id="consent-who">Who is asking</h2>
      <p class="consent-client">{client.name ?? 'An unnamed app'}</p>
      {client.kind === 'metadata_document' && client.host !== null ? (
        <p>
          <Badge tone="ok">identified</Badge> This app is identified by the website{' '}
          <strong class="consent-host">{client.host}</strong>.
        </p>
      ) : (
        <p>
          <Badge tone="error">not verified</Badge> Anyone can register an app with any name. Continue only if
          you started connecting this app yourself, just now.
        </p>
      )}
      <Facts items={[['Sends you back to', <strong class="consent-host">{client.redirectHost}</strong>]]} />
      {client.loopback ? (
        <p class="flash flash-error">
          This address is a program on the computer that opened this page, not a website. Allow only if you
          just started it (for example a command-line tool) on this device.
        </p>
      ) : null}
    </section>
  );
}

function GrantChoice(props: {
  readonly grants: readonly ConsentGrantOption[];
  readonly selected?: string | undefined;
}): JSX.Element {
  const only = props.grants.length === 1;
  return (
    <fieldset class="field">
      <legend>Access to give</legend>
      <p class="hint">
        Read-only New Relic tools. The app gets exactly this access, and loses it when the access is revoked.
      </p>
      {props.grants.map((g, i) => {
        const id = `grant-${i}`;
        const checked = props.selected === undefined ? only || i === 0 : props.selected === g.id;
        return (
          <div class="check grant-option">
            <input
              type="radio"
              id={id}
              name={CONSENT_FIELDS.grant}
              value={g.id}
              checked={checked}
              required
              aria-describedby={`${id}-hint`}
            />
            <label for={id}>{g.label}</label>
            <span class="hint" id={`${id}-hint`}>
              {`Tools: ${g.tools.join(', ')}. Accounts: ${g.accounts.join(', ')}.`}
              {g.expiresAt === null ? null : (
                <>
                  {' Ends '}
                  <Time at={g.expiresAt} />.
                </>
              )}
            </span>
          </div>
        );
      })}
    </fieldset>
  );
}

/** The consent page: who is asking, where the answer goes, which project and which of the user's grants. */
export function ConsentPage(props: ConsentPageProps): JSX.Element {
  const { client, project } = props;
  const usable = props.grants.length > 0;
  return (
    <Layout title="Connect an app" viewer={props.viewer}>
      {props.error ? (
        <div class="flash flash-error" role="alert">
          {props.error}
        </div>
      ) : null}
      <ClientIdentity client={client} />
      <section aria-labelledby="consent-what">
        <h2 id="consent-what">What it asks for</h2>
        <Facts
          items={[
            ['Project', project.name === null ? project.slug : `${project.name} (${project.slug})`],
            [
              'For how long',
              props.offline
                ? 'Until you revoke it or stop using the app'
                : 'About an hour, then the app must ask again',
            ],
          ]}
        />
      </section>
      <Form action={props.action} csrf={props.viewer.csrf} label="Allow or deny the app">
        {usable ? (
          <>
            <GrantChoice grants={props.grants} selected={props.selected} />
            <TextField
              name={CONSENT_FIELDS.label}
              label="Device name (optional)"
              hint="Shown in your list of connected devices, for example “Pixel phone – claude.ai”."
              value={props.label}
              maxlength={CONSENT_LABEL_MAX}
              autocomplete="off"
            />
            <div class="check">
              <input
                type="checkbox"
                id={CONSENT_FIELDS.remember}
                name={CONSENT_FIELDS.remember}
                value="1"
                aria-describedby={`${CONSENT_FIELDS.remember}-hint`}
              />
              <label for={CONSENT_FIELDS.remember}>Don’t ask again for this app</label>
              <span class="hint" id={`${CONSENT_FIELDS.remember}-hint`}>
                {`For ${props.rememberDays} days, for this app, this address and this project only. `}
                <a href={localHref(props.approvalsHref)}>Remembered apps</a>
              </span>
            </div>
          </>
        ) : (
          <p class="flash flash-info">
            You have no access to this project that an app could use. Ask an administrator for access, then
            connect the app again.
          </p>
        )}
        <div class="actions">
          {usable ? (
            <button type="submit" class="button" name={CONSENT_FIELDS.decision} value="approve">
              Allow
            </button>
          ) : null}
          <button type="submit" class="button button-secondary" name={CONSENT_FIELDS.decision} value="deny">
            Deny
          </button>
        </div>
      </Form>
    </Layout>
  );
}

/** One remembered approval, as the approvals page lists it. */
export interface RememberedApproval {
  /** Opaque id of the row (a hash), posted back to forget it. */
  readonly id: string;
  readonly client: Pick<ConsentClient, 'name' | 'kind' | 'host' | 'redirectHost'>;
  readonly projectSlug: string;
  readonly grantLabel: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

export interface ApprovalsPageProps {
  readonly viewer: UiViewer;
  readonly approvals: readonly RememberedApproval[];
  /** Same-origin path the forget form posts to. */
  readonly forgetAction: string;
  /** A fixed confirmation after forgetting one. */
  readonly notice?: string | undefined;
}

/** The apps the signed-in user told not to ask again, with a way to forget each. */
export function ApprovalsPage(props: ApprovalsPageProps): JSX.Element {
  return (
    <Layout title="Remembered apps" viewer={props.viewer}>
      {props.notice ? (
        <div class="flash flash-success" role="status">
          {props.notice}
        </div>
      ) : null}
      <p>
        These apps connect without asking you again. Forgetting one makes it ask next time; access it already
        has keeps working until it ends or is revoked.
      </p>
      <DataTable
        caption="Remembered apps"
        rows={props.approvals}
        empty="No remembered apps."
        columns={[
          {
            header: 'App',
            cell: (a) => (
              <>
                {a.client.name ?? 'An unnamed app'}{' '}
                {a.client.kind === 'metadata_document' && a.client.host !== null ? (
                  <Badge tone="ok">{a.client.host}</Badge>
                ) : (
                  <Badge tone="error">not verified</Badge>
                )}
              </>
            ),
          },
          { header: 'Sends to', cell: (a) => <span class="mono">{a.client.redirectHost}</span> },
          { header: 'Project', cell: (a) => a.projectSlug },
          { header: 'Access', cell: (a) => a.grantLabel },
          { header: 'Until', cell: (a) => <Time at={a.expiresAt} /> },
          {
            header: 'Actions',
            cell: (a) => (
              <form
                method="post"
                action={localHref(props.forgetAction)}
                aria-label={`Forget ${a.client.name ?? 'an unnamed app'} on ${a.projectSlug}`}
              >
                <input type="hidden" name={CSRF_FIELD} value={props.viewer.csrf} />
                <input type="hidden" name="id" value={a.id} />
                <button type="submit" class="button button-secondary button-small">
                  Forget
                </button>
              </form>
            ),
          },
        ]}
      />
    </Layout>
  );
}
