// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { classifyRound, peekJsonRpc } from '../src/jsonrpc.ts';

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
    expect(await peekJsonRpc(r, 1024)).toEqual({
      kind: 'message',
      method: 'tools/call',
      name: 'whoami',
      round: 'confirm',
    });
    expect(await r.json()).toMatchObject({ method: 'tools/call' });
  });

  it('classifies batches, odd bodies and oversized bodies', async () => {
    expect(await peekJsonRpc(req('[{"method":"tools/call"}]'), 1024)).toEqual({ kind: 'batch' });
    expect(await peekJsonRpc(req('{"params":{"name":3}}'), 1024)).toEqual({
      kind: 'message',
      method: null,
      name: null,
      round: null,
    });
    for (const body of ['not json', '"text"', 'null', new Uint8Array([0x7b, 0xff, 0x7d])]) {
      expect(await peekJsonRpc(req(body), 1024)).toEqual({ kind: 'unparsable' });
    }
    expect(await peekJsonRpc(req(null), 1024)).toEqual({ kind: 'unparsable' });
    expect(await peekJsonRpc(req(`{"method":"${'x'.repeat(2000)}"}`), 1024)).toEqual({ kind: 'too_large' });
  });

  it('decodes like the MCP handler: invalid UTF-8 inside a string still names the method (P2-review)', async () => {
    const bytes = new TextEncoder().encode(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_nrql","x":"~~"}}',
    );
    const at = bytes.indexOf(0x7e); // the first `~` of "~~"
    bytes[at] = 0xff;
    bytes[at + 1] = 0xfe;
    expect(await peekJsonRpc(req(bytes), 1024)).toEqual({
      kind: 'message',
      method: 'tools/call',
      name: 'run_nrql',
      round: 'confirm',
    });
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

describe('classifyRound (P7-35)', () => {
  const FORM = { 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } } };
  const call = (extra: Record<string, unknown>, args: Record<string, unknown> = { confirm: true }) => ({
    name: 'close_issue',
    arguments: args,
    ...extra,
  });

  it('a dry run is exactly dry_run: true', () => {
    expect(classifyRound(call({ _meta: FORM }, { dry_run: true }))).toBe('dry_run');
    for (const dry of [false, 'true', 1, null, [true]]) {
      expect(classifyRound(call({ _meta: FORM }, { confirm: true, dry_run: dry }))).toBe('question');
    }
  });

  it('any inputResponses key makes the call answered, whatever it holds', () => {
    for (const value of [{}, null, [], 'x', 0, { a: { action: 'accept' } }]) {
      expect(classifyRound(call({ inputResponses: value, _meta: FORM }))).toBe('answered');
      expect(classifyRound(call({ inputResponses: value }))).toBe('answered');
    }
  });

  it('only a request that declares form elicitation and carries no answer is a question', () => {
    expect(classifyRound(call({ _meta: FORM }))).toBe('question');
    expect(classifyRound(call({}))).toBe('confirm');
    expect(classifyRound(call({ _meta: {} }))).toBe('confirm');
    expect(classifyRound(call({ _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } }))).toBe(
      'confirm',
    );
    expect(
      classifyRound(call({ _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: 1 } } })),
    ).toBe('confirm');
    expect(
      classifyRound(
        call({ _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } } } }),
      ),
    ).toBe('confirm');
  });

  it('a malformed call is never cheaper than a confirmed one', () => {
    for (const params of [null, undefined, 'x', 3, [], { arguments: 'x' }]) {
      expect(classifyRound(params)).toBe('confirm');
    }
  });
});
