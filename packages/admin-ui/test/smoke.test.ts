// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.ts';

describe('@relic-bridge/admin-ui', () => {
  it('loads', () => {
    expect(packageName).toBe('@relic-bridge/admin-ui');
  });
});
