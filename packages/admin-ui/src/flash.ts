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
  | 'quota_removed'
  | 'created'
  | 'created_with_notes'
  | 'deleted'
  | 'revoked'
  | 'client_removed'
  | 'client_removal_partial'
  | 'form_used'
  | 'registration_on'
  | 'registration_off'
  | 'oauth_off'
  | 'disabled'
  | 'enabled'
  | 'signed_out_everywhere'
  | 'user_added'
  | 'identity_cleared'
  | 'identity_none'
  | 'key_added'
  | 'key_rotated'
  | 'key_rotated_other_user'
  | 'key_valid'
  | 'key_invalid'
  | 'key_check_failed'
  | 'key_in_use'
  | 'key_not_checkable'
  | 'changed_meanwhile'
  | 'last_owner'
  | 'read_only'
  | 'token_form_used'
  | 'not_found'
  | 'not_allowed'
  | 'failed';

/** Every flash message the UI can show. */
export const FLASH_MESSAGES: Readonly<Record<FlashCode, FlashMessage>> = Object.freeze({
  saved: { kind: 'success', text: 'Saved.' },
  quota_removed: { kind: 'success', text: 'Quota removed. The grant is no longer capped.' },
  created: { kind: 'success', text: 'Created.' },
  created_with_notes: {
    kind: 'info',
    text: 'Created. Some of what it asks for has no effect, or needs more tools: see the notes below.',
  },
  deleted: { kind: 'success', text: 'Deleted.' },
  revoked: { kind: 'success', text: 'Revoked.' },
  form_used: { kind: 'info', text: 'That form was already sent, so nothing was changed again.' },
  client_removed: {
    kind: 'success',
    text: 'App removed. Every device authorization of it is revoked and its tokens no longer work.',
  },
  client_removal_partial: {
    kind: 'info',
    text: 'The app is removed and cannot connect again, but it had too many device authorizations to revoke in one go. Remove it again to revoke the rest.',
  },
  registration_on: { kind: 'success', text: 'Dynamic client registration is on.' },
  registration_off: {
    kind: 'success',
    text: 'Dynamic client registration is off. Apps already registered keep working.',
  },
  oauth_off: { kind: 'info', text: 'OAuth is not enabled on this server.' },
  disabled: { kind: 'success', text: 'Disabled.' },
  enabled: { kind: 'success', text: 'Enabled.' },
  signed_out_everywhere: { kind: 'success', text: 'Signed out on every device.' },
  user_added: {
    kind: 'success',
    text: 'User added. They can sign in with a provider that confirms this email address.',
  },
  identity_cleared: {
    kind: 'success',
    text: 'Sign-in identity cleared and the user signed out. The next verified sign-in with this email binds the account again: ask them to sign in now.',
  },
  identity_none: { kind: 'info', text: 'This user has no sign-in identity to clear.' },
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
  last_owner: {
    kind: 'error',
    text: 'This is the last enabled owner. Make another user owner first. Nothing changed.',
  },
  read_only: { kind: 'error', text: 'The storage is read-only right now. Nothing changed.' },
  token_form_used: {
    kind: 'info',
    text: 'That form was already sent, so no other token was created. A token is shown only once: if you did not copy it, revoke it below and create a new one.',
  },
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
