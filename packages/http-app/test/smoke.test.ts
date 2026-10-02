// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { packageName } from '../src/index.ts';

describe('@relic-bridge/http-app', () => {
  it('loads', () => {
    expect(packageName).toBe('@relic-bridge/http-app');
  });
});
