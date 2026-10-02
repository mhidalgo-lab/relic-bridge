// SPDX-License-Identifier: Apache-2.0
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer, resolveGrant } from './server.ts';

const grant = resolveGrant(process.env['SPIKE_SLUG'] ?? 'b', null);
if (!grant) throw new Error('bad SPIKE_SLUG');
serveStdio(({ era }) => buildServer(grant, era));
