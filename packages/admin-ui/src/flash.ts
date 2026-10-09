// SPDX-License-Identifier: Apache-2.0
// Flash messages for Post/Redirect/Get (P4-03). The cookie carries a message *code* from this fixed catalogue, never
// text: nothing a request supplies is ever shown back through it.

export type FlashKind = 'success' | 'info' | 'error';

export interface FlashMessage {
  readonly kind: FlashKind;
  readonly text: string;
}

/** Every flash code. Screens add theirs here and in the catalogue below. */
export type FlashCode = 'saved' | 'deleted' | 'revoked' | 'not_found' | 'not_allowed' | 'failed';

/** Every flash message the UI can show. */
export const FLASH_MESSAGES: Readonly<Record<FlashCode, FlashMessage>> = Object.freeze({
  saved: { kind: 'success', text: 'Saved.' },
  deleted: { kind: 'success', text: 'Deleted.' },
  revoked: { kind: 'success', text: 'Revoked.' },
  not_found: { kind: 'error', text: 'That item no longer exists.' },
  not_allowed: { kind: 'error', text: 'Your role does not allow that.' },
  failed: { kind: 'error', text: 'That did not work. Try again in a moment.' },
});

const SECURE_NAME = '__Host-rb_flash';
const PLAIN_NAME = 'rb_flash';
/** A flash survives one redirect, not a later visit. */
const FLASH_MAX_AGE = 60;

export const flashCookieName = (secure: boolean): string => (secure ? SECURE_NAME : PLAIN_NAME);

const isFlashCode = (code: string): code is FlashCode => Object.hasOwn(FLASH_MESSAGES, code);

/** `Set-Cookie` value that shows `code` on the next page. */
export function flashCookie(code: FlashCode, secure: boolean): string {
  return `${flashCookieName(secure)}=${code}; Path=/; Max-Age=${FLASH_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** `Set-Cookie` value that removes the flash once shown. */
export function clearFlashCookie(secure: boolean): string {
  return `${flashCookieName(secure)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * The flash this request carries: `present` when the cookie is there at all (it must then be cleared), `message` only
 * for a known code.
 */
export function readFlash(
  cookieHeader: string | undefined,
  secure: boolean,
): { readonly present: boolean; readonly message: FlashMessage | null } {
  if (cookieHeader === undefined) return { present: false, message: null };
  const name = flashCookieName(secure);
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      const code = part.slice(i + 1).trim();
      return { present: true, message: isFlashCode(code) ? FLASH_MESSAGES[code] : null };
    }
  }
  return { present: false, message: null };
}
