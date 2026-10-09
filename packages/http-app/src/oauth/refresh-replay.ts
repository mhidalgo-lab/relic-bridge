// SPDX-License-Identifier: Apache-2.0
// Refresh token reuse interval (P5-09, ADR-0013): the successor of a just-rotated refresh token, kept for a few
// seconds so that a client which refreshed twice at once (the MCP SDK client does not coalesce refreshes) gets the same
// pair again instead of having its device revoked as a reused token. Web-standard APIs only (ADR-0004).
//
// - Stored under `oauth-refresh-replay:<sha256(presented token)>` with the window as its expiry.
// - Sealed with AES-256-GCM under a key derived (HKDF-SHA-256) from the presented refresh token itself: only a holder of
//   that token can open it, and a copy of the database (which holds only token hashes) can't. The AAD binds the user,
//   the provider grant and the token hash, so a sealed value moved to another key or grant does not open.
// - Client authentication for a replay mirrors the provider's (public: `client_id` only; confidential: the registered
//   secret, compared by its SHA-256 hash as the provider stores it).

/** What the replay cache keeps for one rotated refresh token (sealed at rest). */
export interface ReplayPayload {
  readonly v: 1;
  /** Epoch seconds of the rotation. */
  readonly issuedAt: number;
  /** The client the provider authenticated for the rotation. */
  readonly clientId: string;
  /** The rotation request's `resource` and `scope` parameters (a replay must repeat them). */
  readonly resource: string;
  readonly scope: string | null;
  /** SHA-256 (hex) of the successor refresh token: a replay is valid only while it is the grant's current one. */
  readonly successor: string;
  /** The token response the provider gave the rotation (access and refresh token included). */
  readonly response: Readonly<Record<string, unknown>>;
}

const HKDF_SALT = new TextEncoder().encode('relic-bridge oauth refresh replay v1');
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL_RE.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** `CryptoKey`, spelled so it type-checks under both the DOM/webworker lib and `@types/node`. */
type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function replayKey(token: string, usage: 'encrypt' | 'decrypt'): Promise<WebCryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: new TextEncoder().encode('aes-256-gcm') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** `v1.<iv>.<ciphertext>` (base64url): the payload sealed under the presented token, bound to `aad`. */
export async function sealReplay(token: string, aad: string, payload: ReplayPayload): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    await replayKey(token, 'encrypt'),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `v1.${toB64url(iv)}.${toB64url(new Uint8Array(sealed))}`;
}

/** The payload, or null when the value is malformed, sealed under another token or bound to another `aad`. */
export async function openReplay(token: string, aad: string, value: string): Promise<ReplayPayload | null> {
  const [version, ivText, dataText, ...rest] = value.split('.');
  if (version !== 'v1' || rest.length > 0 || ivText === undefined || dataText === undefined) return null;
  const iv = fromB64url(ivText);
  const data = fromB64url(dataText);
  if (iv === null || iv.length !== 12 || data === null) return null;
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
      await replayKey(token, 'decrypt'),
      data,
    );
  } catch {
    return null;
  }
  try {
    const p = JSON.parse(new TextDecoder().decode(plain)) as Partial<ReplayPayload>;
    if (
      p.v !== 1 ||
      typeof p.issuedAt !== 'number' ||
      typeof p.clientId !== 'string' ||
      typeof p.resource !== 'string' ||
      (p.scope !== null && typeof p.scope !== 'string') ||
      typeof p.successor !== 'string' ||
      typeof p.response !== 'object' ||
      p.response === null
    ) {
      return null;
    }
    return p as ReplayPayload;
  } catch {
    return null;
  }
}

/** How a token request authenticated its client (RFC 6749 §2.3.1), as the provider reads it. */
export interface PresentedClient {
  readonly clientId: string;
  readonly method: 'none' | 'client_secret_basic' | 'client_secret_post';
  readonly secret: string;
}

/**
 * The client a token request names and how it authenticates; null when it names none or mixes methods (the provider
 * refuses those too).
 */
export function presentedClient(headers: Headers, form: URLSearchParams): PresentedClient | null {
  const header = headers.get('authorization');
  const scheme = header
    ?.trim()
    .split(/[ \t]+/)[0]
    ?.toLowerCase();
  if (header !== null && scheme === 'basic') {
    if (form.has('client_id') || form.has('client_secret')) return null;
    const encoded = header.trim().slice('basic'.length).trim();
    if (encoded === '' || /[ \t]/.test(encoded)) return null;
    let credentials: string;
    try {
      credentials = atob(encoded);
    } catch {
      return null;
    }
    const at = credentials.indexOf(':');
    if (at <= 0) return null;
    try {
      return {
        clientId: decodeURIComponent(credentials.slice(0, at).replace(/\+/g, ' ')),
        method: 'client_secret_basic',
        secret: decodeURIComponent(credentials.slice(at + 1).replace(/\+/g, ' ')),
      };
    } catch {
      return null;
    }
  }
  const clientId = form.get('client_id');
  if (clientId === null || clientId === '') return null;
  if (form.has('client_secret')) {
    return { clientId, method: 'client_secret_post', secret: form.get('client_secret') ?? '' };
  }
  return { clientId, method: 'none', secret: '' };
}

/** The provider's stored client record fields client authentication reads. */
export interface StoredClientAuth {
  readonly tokenEndpointAuthMethod?: unknown;
  readonly clientSecret?: unknown;
  readonly authMethodExplicit?: unknown;
}

const SECRET_METHODS = new Set(['client_secret_basic', 'client_secret_post']);

/**
 * Whether `presented` authenticates as the stored client, by the provider 1.2.x rules: the registered method (or, for a
 * client registered without an explicit method, either secret method) and, for a secret method, the secret whose
 * SHA-256 hex the record holds. CIMD clients are stored by us as ordinary records (the provider's CIMD is off).
 */
export async function clientAuthenticates(
  presented: PresentedClient,
  record: StoredClientAuth | null,
  sha256Hex: (text: string) => Promise<string>,
): Promise<boolean> {
  if (record === null) return false;
  const registered = record.tokenEndpointAuthMethod;
  const methodOk =
    presented.method === registered ||
    (record.authMethodExplicit === undefined &&
      typeof registered === 'string' &&
      SECRET_METHODS.has(registered) &&
      SECRET_METHODS.has(presented.method));
  if (!methodOk) return false;
  if (presented.method === 'none') return true;
  if (presented.secret === '' || typeof record.clientSecret !== 'string') return false;
  return (await sha256Hex(presented.secret)) === record.clientSecret;
}
