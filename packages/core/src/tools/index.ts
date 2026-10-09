// SPDX-License-Identifier: Apache-2.0
import type { ToolDefinition } from '../tool.ts';
import { createIdentityTools } from './identity.ts';
import { createQueryTools, type ToolDeps } from './query.ts';

export { createTimeTools } from './time.ts';

import { createTimeTools } from './time.ts';

export { createIdentityTools, intersectAccounts, maskEmail, type ScopedAccount } from './identity.ts';
export { createQueryTools, MAX_NRQL_CHARS, MAX_QUERY_ACCOUNTS, type ToolDeps } from './query.ts';

/** Every built-in tool, ready for `ToolRegistry.register`. Later tool groups add themselves here. */
export function createBuiltinTools(deps: ToolDeps = {}): ToolDefinition[] {
  return [...createIdentityTools(deps), ...createTimeTools(), ...createQueryTools(deps)];
}
