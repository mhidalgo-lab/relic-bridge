// SPDX-License-Identifier: Apache-2.0
// drizzle-kit config: `pnpm --filter @relic-bridge/storage db:generate` writes SQL migrations from src/schema.ts.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
});
