// SPDX-License-Identifier: Apache-2.0
// The `RB_OAUTH*` deployment switches (P5-04), shared by `relic-bridge serve` and the Worker. Web-standard only.
//
//   RB_OAUTH                     on | off (default off): the OAuth 2.1 server, sign-in and consent screen
//   RB_OAUTH_DCR                 on | off (default on): RFC 7591 dynamic client registration at /oauth/register
//   RB_OAUTH_DCR_LIMIT           registrations per hour for the whole deployment (default 30), or off
//   RB_OAUTH_DCR_IP_LIMIT        registration attempts per hour for one client address that passed the policy,
//                                accepted or not (default 10), or off
//   RB_OAUTH_DCR_REDIRECT_HOSTS  comma-separated https redirect hosts dynamic clients may use (default: any)
//   RB_OAUTH_CIMD_HOSTS          comma-separated host names whose client metadata documents may be fetched (default:
//                                any public host), P8-96
//   RB_OAUTH_ACCESS_TTL          access-token lifetime (default 1h; 60s-24h), P5-05
//   RB_OAUTH_REFRESH_TTL         absolute refresh lifetime of a device authorization (default 30d; 1h-365d), P5-05
//   RB_OAUTH_REFRESH_REUSE_WINDOW refresh token reuse interval (default 30s; 0 or off = strict; up to 120s), P5-09
// Durations: a number of seconds, or a number with s, m, h or d (`90m`, `12h`, `30d`).
import {
  DEFAULT_OAUTH_REGISTRATION_IP_LIMIT,
  DEFAULT_OAUTH_REGISTRATION_LIMIT,
  MAX_OAUTH_REFRESH_REUSE_WINDOW_S,
  type OAuthOptions,
} from './server.ts';

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
export type OAuthSettings = Required<
  Pick<OAuthOptions, 'registration' | 'registrationLimit' | 'registrationIpLimit'>
> &
  Pick<
    OAuthOptions,
    | 'registrationRedirectHosts'
    | 'clientMetadataHosts'
    | 'accessTokenTtlSeconds'
    | 'refreshTokenTtlSeconds'
    | 'refreshReuseWindowSeconds'
  >;

export type OAuthEnv = Readonly<Record<string, unknown>>;

const MAX_REGISTRATIONS_PER_HOUR = 100_000;
const DURATION_RE = /^(\d{1,8})([smhd]?)$/;
const UNIT_SECONDS: Readonly<Record<string, number>> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };
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

/** A duration variable in seconds, within [min, max]; undefined when unset. */
function duration(env: OAuthEnv, name: string, min: number, max: number, range: string): number | undefined {
  const raw = text(env, name)?.toLowerCase();
  if (raw === undefined) return undefined;
  const m = DURATION_RE.exec(raw);
  const seconds = m === null ? Number.NaN : Number(m[1]) * (UNIT_SECONDS[m[2] ?? ''] ?? Number.NaN);
  if (!Number.isSafeInteger(seconds) || seconds < min || seconds > max) {
    throw new OAuthConfigError(
      name,
      `${name} must be a duration between ${range} (e.g. 3600, 90m, 12h, 30d)`,
    );
  }
  return seconds;
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
  const ipLimitRaw = text(env, 'RB_OAUTH_DCR_IP_LIMIT')?.toLowerCase();
  let registrationIpLimit: OAuthSettings['registrationIpLimit'] = DEFAULT_OAUTH_REGISTRATION_IP_LIMIT;
  if (ipLimitRaw === 'off') {
    registrationIpLimit = null;
  } else if (ipLimitRaw !== undefined) {
    if (
      !/^\d{1,6}$/.test(ipLimitRaw) ||
      Number(ipLimitRaw) < 1 ||
      Number(ipLimitRaw) > MAX_REGISTRATIONS_PER_HOUR
    ) {
      throw new OAuthConfigError(
        'RB_OAUTH_DCR_IP_LIMIT',
        `RB_OAUTH_DCR_IP_LIMIT must be registrations per hour (1-${MAX_REGISTRATIONS_PER_HOUR}) or off`,
      );
    }
    registrationIpLimit = { requests: Number(ipLimitRaw), perSeconds: 3600 };
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
  const cimdHostsRaw = text(env, 'RB_OAUTH_CIMD_HOSTS');
  let clientMetadataHosts: string[] | undefined;
  if (cimdHostsRaw !== undefined) {
    clientMetadataHosts = cimdHostsRaw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== '');
    if (clientMetadataHosts.length === 0 || !clientMetadataHosts.every((h) => HOST_RE.test(h))) {
      throw new OAuthConfigError(
        'RB_OAUTH_CIMD_HOSTS',
        'RB_OAUTH_CIMD_HOSTS must list host names (e.g. claude.ai)',
      );
    }
  }
  const accessTokenTtlSeconds = duration(env, 'RB_OAUTH_ACCESS_TTL', 60, 86_400, '60s and 24h');
  const refreshTokenTtlSeconds = duration(env, 'RB_OAUTH_REFRESH_TTL', 3600, 365 * 86_400, '1h and 365d');
  const reuseRaw = text(env, 'RB_OAUTH_REFRESH_REUSE_WINDOW')?.toLowerCase();
  const refreshReuseWindowSeconds =
    reuseRaw === 'off'
      ? 0
      : duration(
          env,
          'RB_OAUTH_REFRESH_REUSE_WINDOW',
          0,
          MAX_OAUTH_REFRESH_REUSE_WINDOW_S,
          `0 (or off) and ${MAX_OAUTH_REFRESH_REUSE_WINDOW_S}s`,
        );
  if (
    accessTokenTtlSeconds !== undefined &&
    refreshTokenTtlSeconds !== undefined &&
    refreshTokenTtlSeconds < accessTokenTtlSeconds
  ) {
    throw new OAuthConfigError(
      'RB_OAUTH_REFRESH_TTL',
      'RB_OAUTH_REFRESH_TTL must not be shorter than RB_OAUTH_ACCESS_TTL',
    );
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
    registrationIpLimit,
    ...(registrationRedirectHosts === undefined ? {} : { registrationRedirectHosts }),
    ...(clientMetadataHosts === undefined ? {} : { clientMetadataHosts }),
    ...(accessTokenTtlSeconds === undefined ? {} : { accessTokenTtlSeconds }),
    ...(refreshTokenTtlSeconds === undefined ? {} : { refreshTokenTtlSeconds }),
    ...(refreshReuseWindowSeconds === undefined ? {} : { refreshReuseWindowSeconds }),
  };
}
