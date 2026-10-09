// SPDX-License-Identifier: Apache-2.0
// Compaction helpers shared by list tools: flat tags, and field selection (`minimal_output`).
/** NerdGraph `EntityTag` shape. */
export interface TagGroup {
  readonly key: string;
  readonly values: readonly string[];
}

export type TagInput = readonly TagGroup[] | Readonly<Record<string, string | readonly string[]>>;

/**
 * Tags as `key:value` strings, one per value (`[{key:'env', values:['prod']}]` → `['env:prod']`). Several times
 * cheaper in tokens than the nested shape. Empty keys are skipped; duplicates removed; order kept.
 */
export function flattenTags(tags: TagInput | null | undefined): string[] {
  if (!tags) return [];
  const groups: [string, readonly string[]][] = Array.isArray(tags)
    ? (tags as readonly TagGroup[]).map((t) => [t.key, t.values ?? []])
    : Object.entries(tags as Record<string, string | readonly string[]>).map(([k, v]) => [
        k,
        typeof v === 'string' ? [v] : v,
      ]);
  const out = new Set<string>();
  for (const [key, values] of groups) {
    if (typeof key !== 'string' || key === '') continue;
    if (values.length === 0) out.add(key);
    for (const value of values) out.add(`${key}:${value}`);
  }
  return [...out];
}

/** Keep only `fields` (in that order) of each item: the `minimal_output` option of list tools. */
export function pickFields<T extends Record<string, unknown>>(
  items: readonly T[],
  fields: readonly string[],
): Record<string, unknown>[] {
  return items.map((item) =>
    Object.fromEntries(fields.filter((f) => Object.hasOwn(item, f)).map((f) => [f, item[f]])),
  );
}
