// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { peekJsonRpc } from '../src/jsonrpc.ts';

const req = (body: BodyInit | null) =>
  new Request('http://localhost/p/prod/mcp', {
    method: 'POST',
    ...(body === null ? {} : { body }),
    duplex: 'half',
  } as RequestInit);

describe('peekJsonRpc', () => {
  it('reads the method and params.name and leaves the body readable', async () => {
    const r = req(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami' } }),
    );
    expect(await peekJsonRpc(r, 1024)).toEqual({ kind: 'message', method: 'tools/call', name: 'whoami' });
    expect(await r.json()).toMatchObject({ method: 'tools/call' });
  });

  it('classifies batches, odd bodies and oversized bodies', async () => {
    expect(await peekJsonRpc(req('[{"method":"tools/call"}]'), 1024)).toEqual({ kind: 'batch' });
    expect(await peekJsonRpc(req('{"params":{"name":3}}'), 1024)).toEqual({
      kind: 'message',
      method: null,
      name: null,
    });
    for (const body of ['not json', '"text"', 'null', new Uint8Array([0x7b, 0xff, 0x7d])]) {
      expect(await peekJsonRpc(req(body), 1024)).toEqual({ kind: 'unparsable' });
    }
    expect(await peekJsonRpc(req(null), 1024)).toEqual({ kind: 'unparsable' });
    expect(await peekJsonRpc(req(`{"method":"${'x'.repeat(2000)}"}`), 1024)).toEqual({ kind: 'too_large' });
  });

  it('bounds a streamed body without a length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(512).fill(0x20));
      },
    });
    expect(await peekJsonRpc(req(stream), 4096)).toEqual({ kind: 'too_large' });
  });
});
