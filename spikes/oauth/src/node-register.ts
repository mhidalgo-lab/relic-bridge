// SPDX-License-Identifier: Apache-2.0
// `node --import ./src/node-register.ts`: resolves `cloudflare:workers` to the local shim.
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'cloudflare:workers') {
        return { url: ${JSON.stringify(new URL('./shims/cloudflare-workers.ts', import.meta.url).href)}, shortCircuit: true };
      }
      return next(specifier, context);
    }`)}`,
);
