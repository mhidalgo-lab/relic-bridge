// SPDX-License-Identifier: Apache-2.0
// The `RB_OAUTH*` deployment switches (P5-04), shared by `relic-bridge serve` and the Worker. Web-standard only.
//
//   RB_OAUTH                     on | off (default off): the OAuth 2.1 server, sign-in and consent screen
//   RB_OAUTH_DCR                 on | off (default on): RFC 7591 dynamic client registration at /oauth/register
//   RB_OAUTH_DCR_LIMIT           registrations per hour for the whole deployment (default 30), or off
//   RB_OAUTH_DCR_REDIRECT_HOSTS  comma-separated https redirect hosts dynamic clients may use (default: any)
import { DEFAULT_OAUTH_REGISTRATION_LIMIT, type OAuthOptions } from './server.ts';

/** A refused `RB_OAUTH*` value; `variable` names it for the host's error message. */
export class OAuthConfigError extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthConfigError';
  }
}

/** What the variables configure; the host adds the consent screen (default) and its CIMD fetcher. */
export type OAuthSettings = Required<Pick<OAuthOptions, 'registration' | 'registrationLimit'>> &
  Pick<OAuthOptions, 'registrationRedirectHosts'>;

export type OAuthEnv = Readonly<Record<string, unknown>>;

const MAX_REGISTRATIONS_PER_HOUR = 100_000;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function text(env: OAuthEnv, name: string): string | undefined {
  const v = env[name];
  if (v === undefined || v === null) return undefined;
  // Worker `vars` may be JSON numbers or booleans.
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
    throw new OAuthConfigError(name, `${name} must be a string`);
  }
  const t = String(v).trim();
  return t === '' ? undefined : t;
}

function onOff(env: OAuthEnv, name: string, fallback: boolean): boolean {
  const v = text(env, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  throw new OAuthConfigError(name, `${name} must be on or off`);
}

/**
 * The OAuth settings, or null when `RB_OAUTH` is off (the default). `signIn`: whether sign-in is configured
 * (`RB_PUBLIC_URL` and a provider); OAuth needs it (its public URL is the issuer, its sessions sign people in).
 */
export function oauthSettingsFromEnv(env: OAuthEnv, signIn: boolean): OAuthSettings | null {
  const enabled = onOff(env, 'RB_OAUTH', false);
  const registration = onOff(env, 'RB_OAUTH_DCR', true);
  const limitRaw = text(env, 'RB_OAUTH_DCR_LIMIT')?.toLowerCase();
  let registrationLimit: OAuthSettings['registrationLimit'] = DEFAULT_OAUTH_REGISTRATION_LIMIT;
  if (limitRaw === 'off') {
    registrationLimit = null;
  } else if (limitRaw !== undefined) {
    if (
      !/^\d{1,6}$/.test(limitRaw) ||
      Number(limitRaw) < 1 ||
      Number(limitRaw) > MAX_REGISTRATIONS_PER_HOUR
    ) {
      throw new OAuthConfigError(
        'RB_OAUTH_DCR_LIMIT',
        `RB_OAUTH_DCR_LIMIT must be registrations per hour (1-${MAX_REGISTRATIONS_PER_HOUR}) or off`,
      );
    }
    registrationLimit = { requests: Number(limitRaw), perSeconds: 3600 };
  }
  const hostsRaw = text(env, 'RB_OAUTH_DCR_REDIRECT_HOSTS');
  let registrationRedirectHosts: string[] | undefined;
  if (hostsRaw !== undefined) {
    registrationRedirectHosts = hostsRaw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== '');
    if (registrationRedirectHosts.length === 0 || !registrationRedirectHosts.every((h) => HOST_RE.test(h))) {
      throw new OAuthConfigError(
        'RB_OAUTH_DCR_REDIRECT_HOSTS',
        'RB_OAUTH_DCR_REDIRECT_HOSTS must list host names (e.g. claude.ai)',
      );
    }
  }
  if (!enabled) return null;
  if (!signIn) {
    throw new OAuthConfigError(
      'RB_OAUTH',
      'RB_OAUTH=on needs sign-in: set RB_PUBLIC_URL and an identity provider (people sign in to approve apps)',
    );
  }
  return {
    registration,
    registrationLimit,
    ...(registrationRedirectHosts === undefined ? {} : { registrationRedirectHosts }),
  };
}
