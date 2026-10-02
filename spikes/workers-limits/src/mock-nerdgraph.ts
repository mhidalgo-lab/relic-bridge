// SPDX-License-Identifier: Apache-2.0
// Mock NerdGraph for the P0-06 spike: returns synthetic NRQL-shaped JSON of the requested size.
// Runs as its own Worker so its CPU (payload generation) is not billed to the measured Worker.
import { makeNrqlPayload, SIZES } from './hotpath.ts';

const cache = new Map<string, string>();

export default {
  async fetch(request: Request): Promise<Response> {
    const size = request.headers.get('x-spike-size') ?? '10k';
    const bytes = SIZES[size];
    if (bytes === undefined) return new Response('unknown size', { status: 400 });
    if (request.headers.get('api-key') === null) return new Response('missing API-Key', { status: 401 });
    let body = cache.get(size);
    if (body === undefined) {
      body = makeNrqlPayload(bytes);
      cache.set(size, body);
    }
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  },
};
