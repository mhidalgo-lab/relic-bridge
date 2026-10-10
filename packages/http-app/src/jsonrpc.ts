// SPDX-License-Identifier: Apache-2.0
// What an MCP POST body asks for, read before the MCP handler runs (P2-12). The `Mcp-Method` / `Mcp-Name` headers are
// only cross-checked against the body by the SDK for 2026-era (modern) requests; a legacy request can carry any
// header values. Rate limiting (`listen`) and the audit of ungranted tools must therefore follow the body, which is
// what the MCP handler actually dispatches. Web-standard only.

/** What the body names: one JSON-RPC message, a batch, or nothing usable (the MCP handler answers those). */
export type RpcPeek =
  | { readonly kind: 'message'; readonly method: string | null; readonly name: string | null }
  | { readonly kind: 'batch' }
  | { readonly kind: 'unparsable' }
  | { readonly kind: 'too_large' };

/**
 * Read a copy of `request`'s body (the original stays unread for the MCP handler), bounded by `maxBytes`, and say
 * which method and `params.name` it carries. Never throws for a malformed body.
 */
export async function peekJsonRpc(request: Request, maxBytes: number): Promise<RpcPeek> {
  if (request.body === null) return { kind: 'unparsable' };
  const reader = request.clone().body?.getReader();
  if (reader === undefined) return { kind: 'unparsable' };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Not awaited: a tee branch's cancel settles only once the other branch (the original body) is cancelled too.
        reader.cancel().catch(() => undefined);
        return { kind: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: 'unparsable' };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    // Decode exactly as the SDK's MCP handler does (lenient: invalid bytes become U+FFFD). A stricter decoder here
    // would call a body "unparsable" that the handler then dispatches, hiding the call from the audit (P2-review).
    body = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch {
    return { kind: 'unparsable' };
  }
  if (Array.isArray(body)) return { kind: 'batch' };
  if (typeof body !== 'object' || body === null) return { kind: 'unparsable' };
  const message = body as { method?: unknown; params?: unknown };
  const method = typeof message.method === 'string' ? message.method : null;
  const params = message.params;
  const name =
    typeof params === 'object' && params !== null && typeof (params as { name?: unknown }).name === 'string'
      ? (params as { name: string }).name
      : null;
  return { kind: 'message', method, name };
}
