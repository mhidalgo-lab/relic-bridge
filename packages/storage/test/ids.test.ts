// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { newId } from '../src/ids.ts';

it('generates prefixed, unique ids', () => {
  const a = newId('cred');
  expect(a).toMatch(/^cred_[0-9a-f]{32}$/);
  expect(newId('cred')).not.toBe(a);
});
