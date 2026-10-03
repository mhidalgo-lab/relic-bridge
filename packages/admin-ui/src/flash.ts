// SPDX-License-Identifier: Apache-2.0
// Flash messages for Post/Redirect/Get (P4-03). The cookie carries a message *code* from this fixed catalogue, never
// text: nothing a request supplies is ever shown back through it.

export type FlashKind = 'success' | 'info' | 'error';

export interface FlashMessage {
  readonly kind: FlashKind;
  readonly text: string;
}

/** Every flash code. Screens add theirs here and in the catalogue below. */
export type FlashCode =
  | 'saved'
  | 'created'
  | 'created_with_notes'
  | 'deleted'
  | 'revoked'
  | 'disabled'
  | 'enabled'
  | 'signed_out_everywhere'
  | 'user_added'
  | 'key_added'
  | 'key_rotated'
  | 'key_rotated_other_user'
  | 'key_valid'
  | 'key_invalid'
  | 'key_check_failed'
  | 'key_in_use'
  | 'key_not_checkable'
  | 'changed_meanwhile'
  | 'read_only'
  | 'not_found'
  | 'not_allowed'
  | 'failed';

/** Every flash message the UI can show. */
export const FLASH_MESSAGES: Readonly<Record<FlashCode, FlashMessage>> = Object.freeze({
  saved: { kind: 'success', text: 'Saved.' },
  created: { kind: 'success', text: 'Created.' },
  created_with_notes: {
    kind: 'info',
    text: 'Created. Some of what it asks for has no effect on this project: see the notes below.',
  },
  deleted: { kind: 'success', text: 'Deleted.' },
  revoked: { kind: 'success', text: 'Revoked.' },
  disabled: { kind: 'success', text: 'Disabled.' },
  enabled: { kind: 'success', text: 'Enabled.' },
  signed_out_everywhere: { kind: 'success', text: 'Signed out on every device.' },
  user_added: {
    kind: 'success',
    text: 'User added. They can sign in with a provider that confirms this email address.',
  },
  key_added: { kind: 'success', text: 'Key added. New Relic accepted it.' },
  key_rotated: { kind: 'success', text: 'Key replaced. New Relic accepted the new key.' },
  key_rotated_other_user: {
    kind: 'info',
    text: 'Key replaced. The new key belongs to a different New Relic user: check the accounts it reaches.',
  },
  key_valid: { kind: 'success', text: 'New Relic accepted the key. Its accounts are up to date.' },
  key_invalid: {
    kind: 'error',
    text: 'New Relic refused the key. Everything using it stops until you replace it.',
  },
  key_check_failed: {
    kind: 'error',
    text: 'New Relic could not be reached. Nothing changed. Try again in a moment.',
  },
  key_not_checkable: {
    kind: 'info',
    text: 'This key is not stored in the database (it comes from the environment or a config file), so it is checked when the server starts.',
  },
  key_in_use: {
    kind: 'error',
    text: 'This key is still used by a project or grant. Point them at another key first.',
  },
  changed_meanwhile: {
    kind: 'error',
    text: 'Someone changed this at the same time. Check it and try again.',
  },
  read_only: { kind: 'error', text: 'The storage is read-only right now. Nothing changed.' },
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
