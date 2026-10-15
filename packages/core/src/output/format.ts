// SPDX-License-Identifier: Apache-2.0
import { ErrorCode, RbError } from '../errors.ts';
import { redactHead } from '../redact.ts';
import { envelope } from './envelope.ts';

export type OutputFormat = 'auto' | 'table' | 'csv' | 'json';
export type RenderedFormat = Exclude<OutputFormat, 'auto'>;

export const OUTPUT_FORMATS: readonly OutputFormat[] = Object.freeze(['auto', 'table', 'csv', 'json']);

/** `auto` renders a markdown table up to this many columns, CSV above it (wide tables waste tokens on padding). */
export const TABLE_MAX_COLUMNS = 8;

export interface OutputCaps {
  readonly maxRows: number;
  readonly maxCellChars: number;
  /** Cap on the rendered data block (inside the envelope). */
  readonly maxChars: number;
  readonly maxColumns: number;
}

export const DEFAULT_OUTPUT_CAPS: OutputCaps = Object.freeze({
  maxRows: 100,
  maxCellChars: 300,
  maxChars: 24_000,
  maxColumns: 50,
});

/** Callers (and agents, through tool inputs) may lower caps, never raise them past these. */
export const MAX_OUTPUT_CAPS: OutputCaps = Object.freeze({
  maxRows: 1000,
  maxCellChars: 4000,
  maxChars: 100_000,
  maxColumns: 200,
});

export const DEFAULT_NARROW_HINT =
  'narrow the request: add filters, a shorter time range, fewer columns, or a smaller page';

export interface ShapeRowsOptions extends Partial<OutputCaps> {
  readonly format?: OutputFormat;
  /** Fixed column order / subset. Default: keys in order of first appearance. */
  readonly columns?: readonly string[];
  /** Wrap the data block in the untrusted-data envelope. Default true; false only for values we generated. */
  readonly untrusted?: boolean;
  /** Envelope source label, e.g. "NRQL results". */
  readonly source?: string;
  /** Finishes "To see the rest, …" in the truncation notice. */
  readonly narrowHint?: string;
  /** Rows that exist in total, when the caller passes only one page of them. Default `rows.length`. */
  readonly totalRows?: number;
  /** Redact secret-shaped values (NR keys, bearer tokens…) in the data (T8). Default true. */
  readonly redactSecrets?: boolean;
  /**
   * Extra data-derived lines shown after the rows, inside the same block (e.g. NRQL totals). Redacted like the rows
   * and cut to TRAILER_MAX_CHARS each; not counted against `maxChars`.
   */
  readonly trailer?: readonly string[];
  /** Fixed envelope id, for stable snapshots in tests. */
  readonly envelopeId?: string;
}

export interface ShapeStats {
  readonly totalRows: number;
  readonly returnedRows: number;
  readonly truncated: boolean;
  /** Values cut to `maxCellChars`. */
  readonly cutValues: number;
  readonly omittedColumns: number;
  /** Rows dropped because the data block reached `maxChars`. */
  readonly charCapped: boolean;
}

export interface ShapedRows {
  /** Envelope (or plain block) plus the truncation notice when something was cut. */
  readonly text: string;
  /** The rows that were shown, with the same cuts applied (use as `structuredContent`). */
  readonly rows: Record<string, unknown>[];
  readonly columns: string[];
  readonly format: RenderedFormat;
  readonly truncationNotice?: string;
  readonly stats: ShapeStats;
}

function cap(value: number | undefined, name: keyof OutputCaps): number {
  if (value === undefined) return DEFAULT_OUTPUT_CAPS[name];
  if (!Number.isInteger(value) || value < 1) {
    throw new RbError(ErrorCode.InputInvalid, `${name} must be a positive integer.`);
  }
  return Math.min(value, MAX_OUTPUT_CAPS[name]);
}

/** Resolve caps: defaults for missing values, hard maximums applied. */
export function resolveCaps(options: Partial<OutputCaps> = {}): OutputCaps {
  return {
    maxRows: cap(options.maxRows, 'maxRows'),
    maxCellChars: cap(options.maxCellChars, 'maxCellChars'),
    maxChars: cap(options.maxChars, 'maxChars'),
    maxColumns: cap(options.maxColumns, 'maxColumns'),
  };
}

/** Rough token count for budgeting (~4 characters per token for English and JSON). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Redacted (when `redactSecrets`) and cut to `max` like truncateText. Only the start of a long text is redacted
 * (redactHead), so the work follows the cap and not the size of the value. `cut` says whether anything was dropped.
 */
export function redactTruncate(
  text: string,
  max: number,
  redactSecrets = true,
): { readonly text: string; readonly cut: boolean } {
  if (!redactSecrets) return { text: truncateText(text, max), cut: text.length > max };
  const head = redactHead(text, max);
  if (!head.cut) return { text: truncateText(head.text, max), cut: head.text.length > max };
  return { text: head.text.length < max ? `${head.text}…` : cutText(head.text, max), cut: true };
}

/** Cut to `max` UTF-16 units, never splitting a surrogate pair, marking the cut with `…`. */
export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : cutText(text, max);
}

function cutText(text: string, max: number): string {
  let end = Math.max(0, max - 1);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

interface Counter {
  cut: number;
}

/** One value as it appears in structured output: scalars kept, long strings / big objects cut to text. */
function shapeValue(value: unknown, caps: OutputCaps, redactSecrets: boolean, counter: Counter): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  const isString = typeof value === 'string';
  const raw = toText(value);
  const { text, cut } = redactTruncate(raw, caps.maxCellChars, redactSecrets);
  if (cut) {
    counter.cut++;
    return text;
  }
  if (isString) return text;
  // Small objects / arrays stay structured (re-parsed only if redaction changed them).
  return redactSecrets && text !== raw ? text : value;
}

const NEWLINE_RE = /\r\n|\r|\n/g;

function tableCell(value: unknown): string {
  return toText(value).replace(NEWLINE_RE, '\\n').replace(/\|/g, '\\|');
}

const CSV_QUOTE_RE = /[",\r\n]|^\s|\s$/;
const FORMULA_RE = /^[=+@\t\r]|^-(?!\d+(\.\d+)?(e[+-]?\d+)?$)/i;

function csvCell(value: unknown): string {
  let text = toText(value);
  // Spreadsheet formula injection (CSV is often pasted into a sheet): prefix text that a sheet would evaluate.
  if (typeof value === 'string' && FORMULA_RE.test(text)) text = `'${text}`;
  return CSV_QUOTE_RE.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function renderer(format: RenderedFormat, columns: readonly string[]) {
  switch (format) {
    case 'table':
      return {
        header: [`| ${columns.map(tableCell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`],
        row: (r: Record<string, unknown>) => `| ${columns.map((c) => tableCell(r[c])).join(' | ')} |`,
        footer: [] as string[],
      };
    case 'csv':
      return {
        header: [columns.map(csvCell).join(',')],
        row: (r: Record<string, unknown>) => columns.map((c) => csvCell(r[c])).join(','),
        footer: [] as string[],
      };
    case 'json':
      return {
        header: ['['],
        row: (r: Record<string, unknown>) => JSON.stringify(r),
        footer: [']'],
      };
  }
}

function collectColumns(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

const TRAILER_MAX_CHARS = 2000;
const TOO_WIDE = '(column names exceed the size cap)';

/** Longest column name shown. NRQL attribute names are at most 255 characters; other sources are cut. */
const MAX_COLUMN_NAME = 256;

/** Column names as displayed: cut to MAX_COLUMN_NAME and made unique again if the cut made two equal. */
function displayNames(columns: readonly string[], redactSecrets: boolean): string[] {
  const used = new Set<string>();
  return columns.map((c) => {
    const base = redactTruncate(c, MAX_COLUMN_NAME, redactSecrets).text;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}~${i}`;
    used.add(name);
    return name;
  });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * Render rows for an agent: chosen format, caps on rows / value length / total size, an explicit truncation notice,
 * and the untrusted-data envelope. The returned `rows` are exactly what the text shows (same cuts), so text and
 * `structuredContent` agree.
 */
export function shapeRows(
  input: readonly Record<string, unknown>[],
  options: ShapeRowsOptions = {},
): ShapedRows {
  const rows = input.filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r));
  const caps = resolveCaps(options);
  const redactSecrets = options.redactSecrets ?? true;
  const totalRows = Math.max(options.totalRows ?? rows.length, rows.length);
  const allColumns = options.columns ? [...new Set(options.columns)] : collectColumns(rows);
  const omittedColumns = Math.max(0, allColumns.length - caps.maxColumns);
  const counter: Counter = { cut: 0 };
  const sourceColumns = allColumns.slice(0, caps.maxColumns);
  // Column names are data too (attribute names, facet labels): redacted like values when redaction is on.
  const columns = displayNames(sourceColumns, redactSecrets);

  const requested = options.format ?? 'auto';
  if (!OUTPUT_FORMATS.includes(requested)) {
    throw new RbError(ErrorCode.InputInvalid, `format must be one of ${OUTPUT_FORMATS.join(', ')}.`);
  }
  const format: RenderedFormat =
    requested === 'auto' ? (columns.length <= TABLE_MAX_COLUMNS ? 'table' : 'csv') : requested;
  const render = renderer(format, columns);

  const lines = [...render.header];
  let used =
    lines.reduce((n, l) => n + l.length + 1, 0) + render.footer.reduce((n, l) => n + l.length + 1, 0);
  const shown: Record<string, unknown>[] = [];
  // Even the header doesn't fit: show no rows rather than a broken block.
  let charCapped = used > caps.maxChars && rows.length > 0;
  for (const row of charCapped ? [] : rows.slice(0, caps.maxRows)) {
    const rowCounter: Counter = { cut: 0 };
    // fromEntries defines own properties, so a `__proto__` attribute in the data stays plain data.
    const shaped: Record<string, unknown> = Object.fromEntries(
      sourceColumns.flatMap((c, i) =>
        Object.hasOwn(row, c)
          ? [[columns[i] as string, shapeValue(row[c], caps, redactSecrets, rowCounter)]]
          : [],
      ),
    );
    const line = render.row(shaped);
    const comma = format === 'json' && shown.length > 0 ? 1 : 0;
    if (used + comma + line.length + 1 > caps.maxChars) {
      charCapped = true;
      break;
    }
    used += comma + line.length + 1;
    if (comma) lines[lines.length - 1] += ',';
    lines.push(line);
    shown.push(shaped);
    counter.cut += rowCounter.cut;
  }
  lines.push(...render.footer);

  const returnedRows = shown.length;
  const truncated = returnedRows < totalRows || counter.cut > 0 || omittedColumns > 0;
  const parts: string[] = [];
  if (returnedRows < totalRows) {
    parts.push(
      `showing ${plural(returnedRows, 'row')} of ${totalRows.toLocaleString('en-US')}` +
        (charCapped ? ` (output size cap of ${caps.maxChars.toLocaleString('en-US')} characters)` : ''),
    );
  }
  if (counter.cut > 0)
    parts.push(`${plural(counter.cut, 'value')} cut to ${caps.maxCellChars} characters (marked …)`);
  if (omittedColumns > 0) parts.push(`${plural(omittedColumns, 'column')} omitted`);
  const truncationNotice = truncated
    ? `Truncated: ${parts.join('; ')}. To see the rest, ${options.narrowHint ?? DEFAULT_NARROW_HINT}.`
    : undefined;

  const trailer = (options.trailer ?? []).map(
    (l) => redactTruncate(l, TRAILER_MAX_CHARS, redactSecrets).text,
  );
  const body = [
    rows.length === 0 ? '(no rows)' : used > caps.maxChars ? TOO_WIDE : lines.join('\n'),
    ...trailer,
  ].join('\n');
  const block =
    (rows.length > 0 || trailer.length > 0) && (options.untrusted ?? true)
      ? envelope(body, {
          ...(options.source === undefined ? {} : { source: options.source }),
          ...(options.envelopeId === undefined ? {} : { id: options.envelopeId }),
        })
      : body;
  return {
    text: truncationNotice ? `${block}\n${truncationNotice}` : block,
    rows: shown,
    columns,
    format,
    ...(truncationNotice ? { truncationNotice } : {}),
    stats: { totalRows, returnedRows, truncated, cutValues: counter.cut, omittedColumns, charCapped },
  };
}
