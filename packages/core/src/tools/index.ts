// SPDX-License-Identifier: Apache-2.0
import type { ToolDefinition } from '../tool.ts';
import { createQueryTools, type ToolDeps } from './query.ts';

export { createQueryTools, MAX_NRQL_CHARS, MAX_QUERY_ACCOUNTS, type ToolDeps } from './query.ts';

/** Every built-in tool, ready for `ToolRegistry.register`. Later tool groups add themselves here. */
export function createBuiltinTools(deps: ToolDeps = {}): ToolDefinition[] {
  return [...createQueryTools(deps)];
}
