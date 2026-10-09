// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Admin UI components (P4-03). Server-rendered Hono JSX: every string goes through Hono's auto-escaping. Never use
// `raw()`, the `html` helper or `dangerouslySetInnerHTML` here (scripts/check-ui-escaping.ts fails the lint).
// Accessibility: landmarks, a skip link, labelled controls, errors tied to their field, captions on tables, focus
// styles and 44 px targets in the stylesheet. Nothing needs JavaScript.
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { ASSETS, assetHref } from './assets.ts';
import type { FlashMessage } from './flash.ts';

/** Roles, lowest first. */
export type UiRole = 'member' | 'admin' | 'owner';
export const UI_ROLE_RANK: Readonly<Record<UiRole, number>> = Object.freeze({
  member: 1,
  admin: 2,
  owner: 3,
});

/** Who is looking at the page (from the admin session). */
export interface UiViewer {
  readonly email: string;
  readonly displayName: string | null;
  readonly role: UiRole;
  /** The session's CSRF token, embedded in every form. */
  readonly csrf: string;
}

/** Form field carrying the CSRF token (the same name `POST /auth/logout` reads). */
export const CSRF_FIELD = '_csrf';

/** One entry of the main navigation. Screens add theirs here (P4-04). */
export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Least role that sees the entry (the route checks again). */
  readonly minRole: UiRole;
}

export const NAV_ITEMS: readonly NavItem[] = Object.freeze([
  { href: '/admin', label: 'Overview', minRole: 'member' },
  { href: '/admin/credentials', label: 'Keys', minRole: 'admin' },
  { href: '/admin/projects', label: 'Projects', minRole: 'admin' },
  { href: '/admin/grants', label: 'Grants', minRole: 'admin' },
  { href: '/admin/tokens', label: 'Devices', minRole: 'admin' },
  { href: '/admin/connect', label: 'Connect', minRole: 'admin' },
  { href: '/admin/users', label: 'Users', minRole: 'admin' },
  { href: '/admin/audit', label: 'Audit', minRole: 'member' },
  { href: '/admin/usage', label: 'Usage', minRole: 'admin' },
]);

/**
 * Same-origin path for `href` / `action`: starts with one `/`, no backslash, printable ASCII. Anything else throws, so
 * a component can never emit `javascript:` or another origin, whatever a caller passes.
 */
export function localHref(path: string): string {
  if (!/^\/(?![/\\])[!-~]*$/.test(path) || path.includes('\\')) {
    throw new TypeError('admin UI links must be same-origin paths');
  }
  return path;
}

// ---------------------------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------------------------

export interface DocumentProps {
  readonly title: string;
  readonly children?: Child;
}

/** `<html>` with the stylesheet and the optional script (both same-origin with SRI). */
export function Document(props: DocumentProps): JSX.Element {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="no-referrer" />
        <meta name="color-scheme" content="light dark" />
        <title>{`${props.title} · relic-bridge`}</title>
        <link rel="stylesheet" href={assetHref(ASSETS.css)} integrity={ASSETS.css.integrity} />
        <script src={assetHref(ASSETS.js)} integrity={ASSETS.js.integrity} defer></script>
      </head>
      <body>{props.children}</body>
    </html>
  );
}

export interface LayoutProps {
  readonly title: string;
  /** Signed-in viewer; omitted on sign-in and error pages shown to anyone. */
  readonly viewer?: UiViewer | undefined;
  /** `href` of the current page (marked in the nav). */
  readonly current?: string | undefined;
  readonly flash?: FlashMessage | null | undefined;
  readonly children?: Child;
}

/** The page frame: skip link, header with nav, main landmark (with the flash), footer with sign-out. */
export function Layout(props: LayoutProps): JSX.Element {
  const viewer = props.viewer;
  return (
    <Document title={props.title}>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <header class="site-header">
        <div class="bar">
          <a class="brand" href={viewer ? '/admin' : '/auth/login'}>
            relic-bridge
          </a>
          {viewer ? <Nav viewer={viewer} current={props.current} /> : null}
        </div>
      </header>
      <main id="main" tabindex={-1}>
        {props.flash ? <Flash message={props.flash} /> : null}
        <h1>{props.title}</h1>
        {props.children}
      </main>
      <footer class="site-footer">
        <div class="bar">
          {viewer ? (
            <>
              <span>
                Signed in as <strong>{viewer.displayName ?? viewer.email}</strong> ({viewer.role})
              </span>
              <SignOut viewer={viewer} />
            </>
          ) : (
            <span>relic-bridge admin</span>
          )}
        </div>
      </footer>
    </Document>
  );
}

export function Nav(props: {
  readonly viewer: UiViewer;
  readonly current?: string | undefined;
}): JSX.Element {
  const rank = UI_ROLE_RANK[props.viewer.role];
  return (
    <nav class="nav" aria-label="Main">
      <ul>
        {NAV_ITEMS.filter((item) => rank >= UI_ROLE_RANK[item.minRole]).map((item) => (
          <li>
            <a href={localHref(item.href)} aria-current={item.href === props.current ? 'page' : undefined}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Flash(props: { readonly message: FlashMessage }): JSX.Element {
  const { kind, text } = props.message;
  return (
    <div class={`flash flash-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {text}
    </div>
  );
}

/** Sign out of this browser (`POST /auth/logout`). */
export function SignOut(props: { readonly viewer: UiViewer; readonly everywhere?: boolean }): JSX.Element {
  return (
    <Form action="/auth/logout" csrf={props.viewer.csrf}>
      {props.everywhere ? <input type="hidden" name="everywhere" value="1" /> : null}
      <button type="submit" class="button button-secondary">
        {props.everywhere ? 'Sign out everywhere' : 'Sign out'}
      </button>
    </Form>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------

export interface FormProps {
  /** Same-origin path. */
  readonly action: string;
  /** The viewer's CSRF token: every form carries it (`readForm` checks it). */
  readonly csrf: string;
  readonly label?: string;
  readonly children?: Child;
}

/** A POST form (urlencoded) with the CSRF hidden field. The only way screens should build forms. */
export function Form(props: FormProps): JSX.Element {
  return (
    <form method="post" action={localHref(props.action)} aria-label={props.label}>
      <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
      {props.children}
    </form>
  );
}

export interface FieldProps {
  /** Unique on the page; the control's `id` and `name`. */
  readonly name: string;
  readonly label: string;
  readonly hint?: string | undefined;
  /** Validation message for this field (shown above the control, announced with it). */
  readonly error?: string | undefined;
  readonly type?: 'text' | 'email' | 'number' | 'url' | 'password';
  readonly value?: string | number | undefined;
  readonly required?: boolean;
  readonly autocomplete?: string;
  readonly inputmode?: 'text' | 'numeric' | 'email' | 'url';
  readonly maxlength?: number;
  readonly min?: number;
  readonly max?: number;
  /** Off for secrets and identifiers (no spelling suggestions sent anywhere). */
  readonly spellcheck?: boolean;
}

const describedBy = (name: string, hint: unknown, error: unknown): string | undefined => {
  const ids = [hint ? `${name}-hint` : null, error ? `${name}-error` : null].filter((x) => x !== null);
  return ids.length > 0 ? ids.join(' ') : undefined;
};

export function TextField(props: FieldProps): JSX.Element {
  return (
    <div class="field">
      <label for={props.name}>{props.label}</label>
      {props.hint ? (
        <p class="hint" id={`${props.name}-hint`}>
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p class="error" id={`${props.name}-error`}>
          {props.error}
        </p>
      ) : null}
      <input
        id={props.name}
        name={props.name}
        type={props.type ?? 'text'}
        value={props.value === undefined ? undefined : String(props.value)}
        required={props.required}
        autocomplete={props.autocomplete}
        inputmode={props.inputmode}
        maxlength={props.maxlength}
        min={props.min}
        max={props.max}
        spellcheck={props.spellcheck === undefined ? undefined : props.spellcheck ? 'true' : 'false'}
        aria-invalid={props.error ? 'true' : undefined}
        aria-describedby={describedBy(props.name, props.hint, props.error)}
      />
    </div>
  );
}

export interface SelectFieldProps
  extends Omit<
    FieldProps,
    'type' | 'autocomplete' | 'inputmode' | 'maxlength' | 'min' | 'max' | 'spellcheck'
  > {
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export function SelectField(props: SelectFieldProps): JSX.Element {
  return (
    <div class="field">
      <label for={props.name}>{props.label}</label>
      {props.hint ? (
        <p class="hint" id={`${props.name}-hint`}>
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p class="error" id={`${props.name}-error`}>
          {props.error}
        </p>
      ) : null}
      <select
        id={props.name}
        name={props.name}
        required={props.required}
        aria-invalid={props.error ? 'true' : undefined}
        aria-describedby={describedBy(props.name, props.hint, props.error)}
      >
        {props.options.map((o) => (
          <option value={o.value} selected={String(props.value) === o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface CheckboxProps {
  readonly name: string;
  /** Distinguishes several boxes with one `name`. */
  readonly id?: string;
  /** Text, or text with a badge. */
  readonly label: Child;
  readonly value?: string;
  readonly checked?: boolean;
  /** Hint under the label, tied with `aria-describedby`. */
  readonly hint?: string;
}

export function Checkbox(props: CheckboxProps): JSX.Element {
  const id = props.id ?? props.name;
  return (
    <div class="check">
      <input
        type="checkbox"
        id={id}
        name={props.name}
        value={props.value ?? '1'}
        checked={props.checked}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
      />
      <label for={id}>{props.label}</label>
      {props.hint ? (
        <span class="hint" id={`${id}-hint`}>
          {props.hint}
        </span>
      ) : null}
    </div>
  );
}

export function Button(props: {
  readonly children?: Child;
  readonly variant?: 'primary' | 'secondary' | 'danger';
  readonly type?: 'submit' | 'button';
}): JSX.Element {
  const variant = props.variant ?? 'primary';
  return (
    <button
      type={props.type ?? 'submit'}
      class={variant === 'primary' ? 'button' : `button button-${variant}`}
    >
      {props.children}
    </button>
  );
}

/** Field a destructive form must carry (`confirm=yes`); the handler checks it and asks again without it. */
export const CONFIRM_FIELD = 'confirm';

/**
 * A destructive action behind a disclosure: the first activation only reveals the explanation and the real button.
 * Works without JavaScript and with the keyboard (`<details>`/`<summary>`). The form carries `confirm=yes`.
 */
export function ConfirmAction(props: {
  readonly action: string;
  readonly csrf: string;
  readonly summary: string;
  readonly confirm: string;
  readonly children?: Child;
}): JSX.Element {
  return (
    <details class="confirm">
      <summary>{props.summary}</summary>
      <Form action={props.action} csrf={props.csrf}>
        <input type="hidden" name={CONFIRM_FIELD} value="yes" />
        {props.children}
        <Button variant="danger">{props.confirm}</Button>
      </Form>
    </details>
  );
}

/**
 * Text shown once (a new device token): selectable, with a copy button the optional script reveals when the
 * clipboard API is there.
 */
export function SecretOnce(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div class="field">
      <p>
        <strong id={`${props.id}-label`}>{props.label}</strong>
      </p>
      <p>
        <code id={props.id}>{props.value}</code>
      </p>
      <button type="button" class="button button-secondary" data-copy={props.id} hidden>
        Copy
      </button>
    </div>
  );
}

/**
 * A GET form (filters, pickers): no CSRF token, because it changes nothing. Its fields end up in the URL, so never
 * put a secret in one.
 */
export function QueryForm(props: {
  readonly action: string;
  readonly label: string;
  readonly children?: Child;
}): JSX.Element {
  return (
    <form method="get" action={localHref(props.action)} aria-label={props.label} class="query-form">
      {props.children}
    </form>
  );
}

export type BadgeTone = 'ok' | 'info' | 'error' | 'muted';

/** A short status word (`valid`, `revoked`, `read`); colour is never the only signal (the word is the content). */
export function Badge(props: { readonly tone: BadgeTone; readonly children?: Child }): JSX.Element {
  return <span class={`badge badge-${props.tone}`}>{props.children}</span>;
}

/** "Next page" for cursor lists (`href` is the next page's same-origin URL, or null at the end). */
export function Pager(props: {
  readonly next: string | null;
  readonly first?: string | undefined;
  readonly label: string;
}): JSX.Element | null {
  if (props.next === null && props.first === undefined) return null;
  return (
    <nav class="pager" aria-label={props.label}>
      {props.first === undefined ? null : (
        <a class="button button-secondary" href={localHref(props.first)}>
          First page
        </a>
      )}
      {props.next === null ? null : (
        <a class="button button-secondary" href={localHref(props.next)}>
          Next page
        </a>
      )}
    </nav>
  );
}

/** A link styled as a button (navigation, not an action). */
export function LinkButton(props: {
  readonly href: string;
  readonly variant?: 'primary' | 'secondary';
  readonly children?: Child;
}): JSX.Element {
  return (
    <a
      class={props.variant === 'secondary' ? 'button button-secondary' : 'button'}
      href={localHref(props.href)}
    >
      {props.children}
    </a>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Tables and facts
// ---------------------------------------------------------------------------------------------------------------

export interface Column<T> {
  readonly header: string;
  readonly cell: (row: T) => Child;
}

export interface DataTableProps<T> {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  /** Shown in one cell when there are no rows. */
  readonly empty: string;
}

/** A table with a caption and column headers; scrolls sideways on narrow screens instead of overflowing the page. */
export function DataTable<T>(props: DataTableProps<T>): JSX.Element {
  return (
    <div class="table-wrap">
      <table>
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((col) => (
              <th scope="col">{col.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr>
              <td class="empty" colspan={props.columns.length}>
                {props.empty}
              </td>
            </tr>
          ) : (
            props.rows.map((row) => (
              <tr>
                {props.columns.map((col) => (
                  <td>{col.cell(row)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Facts(props: { readonly items: readonly (readonly [string, Child])[] }): JSX.Element {
  return (
    <dl class="facts">
      {props.items.map(([term, value]) => (
        <>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </>
      ))}
    </dl>
  );
}

/** A point in time for people: UTC, minute precision, machine-readable in `datetime`. */
export function Time(props: { readonly at: number }): JSX.Element {
  const iso = new Date(props.at).toISOString();
  return <time datetime={iso}>{`${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`}</time>;
}
