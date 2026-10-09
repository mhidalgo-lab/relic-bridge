// SPDX-License-Identifier: Apache-2.0
// SQL shared by the SQL adapters for the user write guards (P4-16). Fixed text only: every value is a bound parameter.

/**
 * `WHERE` fragment of an `UPDATE users`: true unless the row is an enabled owner that this write demotes or disables
 * while no other enabled owner exists. `role` and `disabled_at` name the row's current values; `newRole` and
 * `newDisabledAt` are SQL expressions for the new ones (a `?` placeholder or the column itself). Checked and written
 * in the same statement, so concurrent demotions serialise in the engine and the last one finds no other owner.
 */
export function lastOwnerGuardSql(newRole: '?' | 'role', newDisabledAt: '?' | 'disabled_at'): string {
  return (
    `(NOT (role = 'owner' AND disabled_at IS NULL) OR (${newRole} = 'owner' AND ${newDisabledAt} IS NULL) OR ` +
    `EXISTS (SELECT 1 FROM users AS o WHERE o.id <> users.id AND o.role = 'owner' AND o.disabled_at IS NULL))`
  );
}

/** `WHERE` fragment of a first binding (P4-16): the row is enabled and has no identity yet. */
export const UNBOUND_ENABLED_SQL = 'idp IS NULL AND idp_subject IS NULL AND disabled_at IS NULL';
