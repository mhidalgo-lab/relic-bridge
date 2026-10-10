// SPDX-License-Identifier: Apache-2.0
// Vitest setup file of the Worker project: points the shared authz harness at the Worker (see `authz-host.ts`).
import { afterEach, vi } from 'vitest';
import { useAuthzHost } from '../../../packages/http-app/test/authz/harness.ts';
import { workerHost } from './authz-host.ts';

useAuthzHost(workerHost);
afterEach(() => {
  vi.useRealTimers();
});
