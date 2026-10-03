// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// The snippet list shared by the Connect page and the one-time token page. Every snippet is text in a focusable
// `<pre>` (selectable without JavaScript); the copy buttons are revealed by `admin.js` when the clipboard API exists.
import type { JSX } from 'hono/jsx/jsx-runtime';
import { clientSnippets, type SnippetInput } from './snippets.ts';

export function SnippetList(props: SnippetInput & { readonly idPrefix?: string }): JSX.Element {
  const prefix = props.idPrefix ?? 'snippet';
  return (
    <div class="snippets">
      {clientSnippets(props).map((s) => (
        <div class="card snippet">
          <h3 id={`${prefix}-${s.id}-title`}>{s.client}</h3>
          <p class="muted">{s.where}</p>
          <pre tabindex={0}>
            <code id={`${prefix}-${s.id}`}>{s.body}</code>
          </pre>
          <button
            type="button"
            class="button button-secondary"
            data-copy={`${prefix}-${s.id}`}
            aria-label={`Copy the ${s.client} snippet`}
            hidden
          >
            Copy
          </button>
          {s.notes.length === 0 ? null : (
            <ul class="notes-list">
              {s.notes.map((n) => (
                <li>{n}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
