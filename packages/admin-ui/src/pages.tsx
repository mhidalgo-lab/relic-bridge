// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Whole pages (P4-03): rendering to a complete HTML response with the UI headers, and the pages every screen shares
// (sign-in, message, error).
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { Layout, type LayoutProps, localHref, TextField } from './components.tsx';
import { UI_PAGE_HEADERS } from './headers.ts';

/** Render a document synchronously (no async components in the UI) with the doctype. */
export function renderDocument(node: JSX.Element): string {
  const out = (node as unknown as { toString(): string | Promise<string> }).toString();
  if (typeof out !== 'string') throw new TypeError('admin UI components must render synchronously');
  return `<!doctype html>${out}`;
}

/** An HTML response with the UI's CSP and headers (plus `extra`, e.g. `Set-Cookie`). */
export function htmlResponse(
  node: JSX.Element,
  status = 200,
  extra: Readonly<Record<string, string>> | readonly (readonly [string, string])[] = {},
): Response {
  const headers = new Headers(UI_PAGE_HEADERS);
  for (const [k, v] of Array.isArray(extra) ? extra : Object.entries(extra)) headers.append(k, v);
  return new Response(renderDocument(node), { status, headers });
}

export interface LoginProvider {
  /** Same-origin path that starts this provider's sign-in. */
  readonly href: string;
  readonly label: string;
}

export function LoginPage(props: {
  readonly providers: readonly LoginProvider[];
  /** A setup link is being used: the account becomes the owner. */
  readonly setup: boolean;
}): JSX.Element {
  return (
    <Layout title="Sign in">
      {props.setup ? (
        <p class="card">Setup link: the account you sign in with becomes the owner of this instance.</p>
      ) : null}
      {props.providers.length === 0 ? (
        <p>No sign-in provider is configured. Use the admin token with the admin API or the CLI.</p>
      ) : (
        <ul class="providers" aria-label="Sign-in providers">
          {props.providers.map((p) => (
            <li>
              <a class="button" href={localHref(p.href)}>
                {`Sign in with ${p.label}`}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

export interface SetupPageProps {
  /** Same-origin path the form posts to. */
  readonly action: string;
  /** Provider id named by the link (non-secret), passed through to the sign-in chooser. */
  readonly provider?: string | undefined;
  /** Validated post-login path, passed through. */
  readonly next?: string | undefined;
}

/**
 * The first-owner setup form (P8-86). The link carries the one-time code in the URL fragment, which browsers never send
 * to a server; `admin.js` copies it into this form, removes it from the address bar and submits the form. Without
 * script the code is pasted by hand. The code never appears in the page, a URL or a log.
 */
export function SetupPage(props: SetupPageProps): JSX.Element {
  return (
    <Layout title="Set up the owner">
      <p>
        This setup link makes the account you sign in with the owner of this instance. Continue, then choose
        how to sign in.
      </p>
      <form method="post" action={localHref(props.action)} aria-label="Setup code" data-setup-form="">
        {props.provider === undefined ? null : <input type="hidden" name="provider" value={props.provider} />}
        {props.next === undefined ? null : <input type="hidden" name="next" value={props.next} />}
        <TextField
          name="code"
          label="Setup code"
          hint="Filled in from the link. Without it, paste the part of the link after #setup= here."
          required
          autocomplete="off"
          spellcheck={false}
          maxlength={128}
        />
        <button type="submit" class="button">
          Continue
        </button>
      </form>
    </Layout>
  );
}

export interface MessagePageProps extends Pick<LayoutProps, 'viewer'> {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly link?: { readonly href: string; readonly label: string } | undefined;
  /** A button to an absolute `http://[::1]…` URL (the consent post's answer for an IPv6 loopback client, P5-12). */
  readonly continueHref?: string | undefined;
  /** Shown so a person can quote it to whoever reads the logs. Nothing else about the failure is shown. */
  readonly requestId?: string | undefined;
  readonly children?: Child;
}

/** A plain page with a title, a few sentences, an optional link and the request id. */
export function MessagePage(props: MessagePageProps): JSX.Element {
  return (
    <Layout title={props.title} viewer={props.viewer}>
      {props.paragraphs.map((p) => (
        <p>{p}</p>
      ))}
      {props.children}
      {props.continueHref !== undefined &&
      /^http:\/\/\[::1\](?::\d{1,5})?(?:[/?#]|$)/.test(props.continueHref) ? (
        <p>
          <a class="button" href={props.continueHref}>
            Continue
          </a>
        </p>
      ) : null}
      {props.link ? (
        <p>
          <a href={localHref(props.link.href)}>{props.link.label}</a>
        </p>
      ) : null}
      {props.requestId ? (
        <p class="muted">
          <small>
            Request id: <code>{props.requestId}</code>
          </small>
        </p>
      ) : null}
    </Layout>
  );
}

const ERROR_TEXT: Readonly<Record<number, { title: string; text: string }>> = {
  403: {
    title: 'Not allowed',
    text: 'You do not have access to this page, or the request did not come from this site.',
  },
  404: { title: 'Page not found', text: 'There is no admin page at this address.' },
  413: { title: 'Request too large', text: 'The form you sent is too large.' },
  415: { title: 'Unsupported request', text: 'Send the form from the admin pages.' },
  429: {
    title: 'Too many requests',
    text: 'Too many requests from this address. Wait a minute, then try again.',
  },
  500: { title: 'Something went wrong', text: 'The page could not be shown. Try again in a moment.' },
  503: { title: 'Unavailable', text: 'The service is unavailable right now. Try again in a moment.' },
};

/** The error page for `status`: fixed text only (no exception message, no stack), plus the request id. */
export function errorPage(
  status: number,
  requestId: string | undefined,
  viewer?: LayoutProps['viewer'],
): Response {
  const known = ERROR_TEXT[status] ?? (ERROR_TEXT[500] as { title: string; text: string });
  return htmlResponse(
    <MessagePage
      title={known.title}
      paragraphs={[known.text]}
      viewer={viewer}
      requestId={requestId}
      link={viewer ? { href: '/admin', label: 'Back to the overview' } : undefined}
    />,
    status,
  );
}
