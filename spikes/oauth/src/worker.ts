// SPDX-License-Identifier: Apache-2.0
import { type Env, handle } from './app.ts';

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
