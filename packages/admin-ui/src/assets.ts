// SPDX-License-Identifier: Apache-2.0
// Static assets of the admin UI (P4-03): compiled into the bundle (`assets.generated.ts`) so `serve` and the Worker
// serve the same bytes without a file system or a static-assets binding.
import { GENERATED_ASSETS } from './assets.generated.ts';

export interface StaticAsset {
  /** Published file name, with a content hash (`admin.<hash>.css`). */
  readonly file: string;
  /** `Content-Type`. */
  readonly type: string;
  /** Subresource Integrity value for the tag (`sha384-…`). */
  readonly integrity: string;
  readonly body: string;
}

/** Where the assets are served. */
export const ASSET_BASE: '/admin/assets' = '/admin/assets';
/** Hashed names never change content: cache for a year, never revalidate. */
export const ASSET_CACHE_CONTROL: 'public, max-age=31536000, immutable' =
  'public, max-age=31536000, immutable';

export const ASSETS: Readonly<Record<'css' | 'js', StaticAsset>> = GENERATED_ASSETS;

const BY_FILE: ReadonlyMap<string, StaticAsset> = new Map(Object.values(ASSETS).map((a) => [a.file, a]));

/** The asset published under `file`, if any (exact match: no paths, no other names). */
export function findAsset(file: string): StaticAsset | undefined {
  return BY_FILE.get(file);
}

export const assetHref = (asset: StaticAsset): string => `${ASSET_BASE}/${asset.file}`;
