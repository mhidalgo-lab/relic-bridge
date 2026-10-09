// SPDX-License-Identifier: Apache-2.0
// Entity GUIDs are base64 of `accountId|DOMAIN|TYPE|domainId` (e.g. `1000001|APM|APPLICATION|42`). Decoding them
// offline lets tools check the account against the connection scope before spending a request (THREAT_MODEL T3).
import { ErrorCode, RbError } from '../errors.ts';

/** Accepted GUID text: standard or URL-safe base64, optional padding. */
const GUID_RE = /^[A-Za-z0-9+/_-]{8,512}={0,2}$/;
const DECODED_RE = /^([1-9]\d{0,15})\|([A-Z][A-Z0-9_]{0,31})\|([A-Z][A-Z0-9_]{0,63})\|([\x20-\x7e]{1,384})$/;

export interface DecodedEntityGuid {
  readonly accountId: number;
  /** e.g. `APM`, `INFRA`, `VIZ`. */
  readonly domain: string;
  /** e.g. `APPLICATION`, `HOST`, `DASHBOARD`. */
  readonly type: string;
  /** The id within the domain (opaque; numeric for most entities). */
  readonly domainId: string;
}

function invalidGuid(): RbError {
  return new RbError(ErrorCode.InputInvalid, 'The entity GUID is not valid.', {
    hint: 'Pass a guid exactly as returned by search_entities (base64 text such as MTAwMDAwMXxBUE18QVBQTElDQVRJT058NDI).',
  });
}

/** Decode a GUID without any request. Anything that is not a well-formed entity GUID → RB_INPUT_INVALID. */
export function decodeEntityGuid(guid: string): DecodedEntityGuid {
  if (typeof guid !== 'string' || !GUID_RE.test(guid)) throw invalidGuid();
  const standard = guid.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (standard.length % 4 === 1) throw invalidGuid();
  let decoded: string;
  try {
    decoded = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='));
  } catch {
    throw invalidGuid();
  }
  const m = DECODED_RE.exec(decoded);
  if (!m?.[1] || !m[2] || !m[3] || !m[4]) throw invalidGuid();
  const accountId = Number(m[1]);
  if (!Number.isSafeInteger(accountId)) throw invalidGuid();
  return { accountId, domain: m[2], type: m[3], domainId: m[4] };
}
