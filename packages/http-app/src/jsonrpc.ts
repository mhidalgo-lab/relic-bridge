// SPDX-License-Identifier: Apache-2.0
// What an MCP POST body asks for, read before the MCP handler runs (P2-12). The `Mcp-Method` / `Mcp-Name` headers are
// only cross-checked against the body by the SDK for 2026-era (modern) requests; a legacy request can carry any
// header values. Rate limiting (`listen`) and the audit of ungranted tools must therefore follow the body, which is
// what the MCP handler actually dispatches. Web-standard only.
import { CLIENT_CAPABILITIES_META_KEY, clientCanElicitForm } from '@relic-bridge/core';

/** What the body names: one JSON-RPC message, a batch, or nothing usable (the MCP handler answers those). */
export type RpcPeek =
  | {
      readonly kind: 'message';
      readonly method: string | null;
      readonly name: string | null;
      /** How a `tools/call` relates to the write limit (P7-35); `null` for any other message. */
      readonly round: WriteRound | null;
    }
  | { readonly kind: 'batch' }
  | { readonly kind: 'unparsable' }
  | { readonly kind: 'too_large' };

/**
 * What a `tools/call` is, for charging the per-grant write bucket (P7-35), read from the raw body before any tool runs:
 *   `dry_run`   `arguments.dry_run` is exactly `true`: the tools return before any mutation.
 *   `answered`  `params.inputResponses` is present (whatever it holds): the round that may spend an approval.
 *   `question`  neither, and the request itself declares form elicitation: the round that can only ask. The server
 *               enforces it (`ToolContext.writeQuestionOnly`): such a call never sends a change.
 *   `confirm`   anything else (the `confirm: true` flow, a client that cannot be asked, a malformed call): can mutate.
 * Only `confirm` and `answered` can reach a mutation, and the write bucket charges both (and every unclassified call).
 */
export type WriteRound = 'dry_run' | 'answered' | 'question' | 'confirm';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function classifyRound(params: unknown): WriteRound {
  if (!isObject(params)) return 'confirm';
  const args = params['arguments'];
  if (isObject(args) && args['dry_run'] === true) return 'dry_run';
  if ('inputResponses' in params) return 'answered';
  const meta = params['_meta'];
  const caps = isObject(meta) ? meta[CLIENT_CAPABILITIES_META_KEY] : undefined;
  return isObject(caps) && clientCanElicitForm(caps) ? 'question' : 'confirm';
}

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
  return { kind: 'message', method, name, round: method === 'tools/call' ? classifyRound(params) : null };
}
