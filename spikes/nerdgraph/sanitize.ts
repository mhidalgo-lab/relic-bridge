// SPDX-License-Identifier: Apache-2.0
// Deterministic sanitizer for P0-09 raw results → test fixtures (THREAT_MODEL T8).
//   node sanitize.ts            results/raw/*.json → results/sanitized/*.json
// Pass 1 learns sensitive values by key/shape (account ids, GUIDs, names, emails, user ids, free text); pass 2 replaces
// every learned value wherever it appears (including inside NRQL strings, URLs and error messages).
// The mapping (real → fake) is written to results/raw/_mapping.json only (gitignored). ALWAYS review output manually.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAW_DIR, SANITIZED_DIR } from './lib.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const ACCOUNT_KEYS = /^(accountId|accountIds|account_id|consumingAccountId|reportingAccountId)$/i;
const USER_ID_KEYS = /^(userId|user_id|ownerId|createdBy|updatedBy)$/i;
const ACCOUNT_PARENTS = /^(account|accounts|consumingAccount|reportingAccount)$/i;
const USER_PARENTS = /^(user|users|owner|createdBy|updatedBy|author)$/i;
const NAME_KEYS =
  /^(name|appName|entityName|entityNames|host|hostname|hostName|displayName|serviceName|clusterName|facet|title|label|policyName|conditionName)$/i;
const FREE_TEXT_KEYS =
  /^(message|description|errorMessage|error\.message|stackTrace|exception|changelog|commit|details|summary|shortDescription|text|body)$/i;
/** Values under these keys are schema/system data and are kept verbatim (still subject to pass-2 replacement). */
const KEEP_KEYS =
  /^(__typename|eventType|eventTypes|entityType|domain|type|kind|state|priority|function|attribute|key|keys|unit|query|rawSince|rawUntil|since|until|status|reporting|alertSeverity)$/i;

/** Subtrees that hold public schema/docs or our own request documents: only ids are learned there, never names/text. */
const IDS_ONLY_KEYS =
  /^(eventDefinitions|metadata|request|variables|__schema|types|fields|args|inputFields|enumValues)$/;
/** Files that are New Relic's public GraphQL schema: copied verbatim, never learned from. */
export const SCHEMA_FILES = new Set(['schema-excerpt.json']);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const GUID_RE = /\b[A-Za-z0-9+/]{20,}={0,2}/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6_RE = /\b(?:[A-Fa-f0-9]{1,4}:){4,7}[A-Fa-f0-9]{1,4}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/g;
const NR_KEY_RE = /\b(?:NRAK|NRAA|NRII|NRIK|NRIQ|NRJS|NRBR|NRSP)-[A-Za-z0-9_-]{10,}\b|\b[a-f0-9]{36}NRAL\b/g;

const LOREM =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ';

/** Placeholder text of the same length class (≤16, ≤64, ≤256, ≤1024, longer). */
export function loremFor(original: string): string {
  const len = original.length;
  const target = len <= 16 ? 16 : len <= 64 ? 64 : len <= 256 ? 256 : len <= 1024 ? 1024 : 4096;
  return LOREM.repeat(Math.ceil(target / LOREM.length))
    .slice(0, target)
    .trimEnd();
}

function decodeGuid(s: string): { account: string; domain: string; type: string; id: string } | undefined {
  try {
    const decoded = atob(s);
    const m = /^(\d+)\|([A-Z]+)\|([A-Z_]+)\|(.+)$/.exec(decoded);
    return m
      ? { account: m[1] as string, domain: m[2] as string, type: m[3] as string, id: m[4] as string }
      : undefined;
  } catch {
    return undefined;
  }
}

export class Sanitizer {
  private readonly accounts = new Map<string, string>();
  private readonly users = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private readonly emails = new Map<string, string>();
  private readonly ips = new Map<string, string>();
  private readonly guids = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  private readonly ids = new Map<string, string>();

  constructor(knownAccountIds: (string | number)[] = []) {
    for (const a of knownAccountIds) this.account(String(a));
  }

  private account(real: string): string {
    let v = this.accounts.get(real);
    if (!v) {
      v = String(1_000_001 + this.accounts.size);
      this.accounts.set(real, v);
    }
    return v;
  }

  private mapped(map: Map<string, string>, real: string, make: (n: number) => string): string {
    let v = map.get(real);
    if (!v) {
      v = make(map.size + 1);
      map.set(real, v);
    }
    return v;
  }

  private guid(real: string): string | undefined {
    const g = decodeGuid(real);
    if (!g) return undefined;
    return this.mapped(this.guids, real, () => {
      const id = this.mapped(this.ids, g.id, (n) => String(9_000_000 + n));
      return btoa(`${this.account(g.account)}|${g.domain}|${g.type}|${id}`).replace(/=+$/, '');
    });
  }

  /** Pass 1: learn sensitive values by key and shape. */
  learn(value: Json, key = '', inErrors = false, parent = '', idsOnly = false): void {
    if (Array.isArray(value)) {
      for (const v of value) this.learn(v, key, inErrors, parent, idsOnly);
      return;
    }
    if (value !== null && typeof value === 'object') {
      if (!idsOnly && typeof value['key'] === 'string' && Array.isArray(value['values']))
        this.learnTagValues(value['values']);
      for (const [k, v] of Object.entries(value))
        this.learn(v, k, inErrors || k === 'errors', key, idsOnly || IDS_ONLY_KEYS.test(k));
      return;
    }
    // `id` is ambiguous: classify by the parent key (actor.user.id, actor.accounts[].id).
    const isAccount = ACCOUNT_KEYS.test(key) || (key === 'id' && ACCOUNT_PARENTS.test(parent));
    const isUser = USER_ID_KEYS.test(key) || (key === 'id' && USER_PARENTS.test(parent));
    if (typeof value === 'number') {
      if (isAccount) this.account(String(value));
      else if (isUser) this.mapped(this.users, String(value), (n) => String(2_000_000 + n));
      return;
    }
    if (typeof value !== 'string' || value.length === 0) return;
    for (const m of value.matchAll(GUID_RE)) this.guid(m[0]);
    for (const m of value.matchAll(EMAIL_RE)) this.mapped(this.emails, m[0], (n) => `user-${n}@example.com`);
    for (const m of value.matchAll(IPV4_RE)) this.mapped(this.ips, m[0], (n) => `192.0.2.${n % 250}`);
    for (const m of value.matchAll(IPV6_RE))
      this.mapped(this.ips, m[0], (n) => `2001:db8::${n.toString(16)}`);
    if (KEEP_KEYS.test(key)) return;
    if (isAccount && /^\d+$/.test(value)) this.account(value);
    else if (isUser) this.mapped(this.users, value, (n) => String(2_000_000 + n));
    else if (idsOnly) return;
    else if (NAME_KEYS.test(key) && value.length >= 2) {
      this.mapped(this.names, value, (n) => `${key.toLowerCase().includes('host') ? 'host' : 'name'}-${n}`);
    } else if (FREE_TEXT_KEYS.test(key) && !inErrors && value.length >= 8) {
      this.mapped(this.texts, value, () => loremFor(value));
    }
  }

  /** Entity tags `{ key, values[] }`: numeric ids → fake ids; booleans/enums kept; anything else → placeholder name. */
  private learnTagValues(values: Json[]): void {
    for (const v of values) {
      if (typeof v !== 'string' || v.length < 2) continue;
      if (/^\d{4,}$/.test(v)) this.mapped(this.names, v, (n) => String(8_000_000 + n));
      else if (/^(true|false|[A-Z][A-Z0-9_]*)$/.test(v) || decodeGuid(v)) continue;
      else this.mapped(this.names, v, (n) => `tag-${n}`);
    }
  }

  /** Pass 2: replace everything learned, wherever it appears. */
  apply(value: Json, key = '', parent = ''): Json {
    if (Array.isArray(value)) return value.map((v) => this.apply(v, key, parent));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.apply(v, k, key);
      return out;
    }
    if (typeof value === 'number') {
      // Only numbers under id-like keys are replaced, so counts that happen to equal an id stay intact.
      const s = String(value);
      const accountCtx = ACCOUNT_KEYS.test(key) || (key === 'id' && ACCOUNT_PARENTS.test(parent));
      const userCtx = USER_ID_KEYS.test(key) || (key === 'id' && USER_PARENTS.test(parent));
      // Outside id keys, only numbers of 5+ digits are treated as account ids (small counts are never ids).
      if ((accountCtx || ACCOUNT_PARENTS.test(key) || s.length >= 5) && this.accounts.has(s))
        return Number(this.accounts.get(s));
      if (userCtx && this.users.has(s)) return Number(this.users.get(s));
      return value;
    }
    if (typeof value !== 'string') return value;
    const whole = this.texts.get(value) ?? this.names.get(value);
    if (whole !== undefined) return whole;
    return this.replaceInString(value);
  }

  private replaceInString(s: string): string {
    let out = s.replace(NR_KEY_RE, (m) => `${m.slice(0, 4)}-EXAMPLEREDACTED`);
    out = out.replace(GUID_RE, (m) => this.guids.get(m) ?? m);
    out = out.replace(EMAIL_RE, (m) => this.emails.get(m) ?? 'user-x@example.com');
    out = out.replace(IPV4_RE, (m) => this.ips.get(m) ?? '192.0.2.1');
    out = out.replace(IPV6_RE, (m) => this.ips.get(m) ?? '2001:db8::1');
    out = out.replace(URL_RE, (u) => {
      try {
        const url = new URL(u);
        const host = /(^|\.)newrelic\.com$/.test(url.hostname) ? url.hostname : 'example.invalid';
        return `${url.protocol}//${host}/REDACTED`;
      } catch {
        return 'https://example.invalid/REDACTED';
      }
    });
    // Longest first so "acme-checkout" wins over "acme".
    const subs: [string, string][] = [
      ...this.names,
      ...this.texts,
      ...[...this.accounts].filter(([r]) => r.length >= 5),
    ];
    subs.sort((a, b) => b[0].length - a[0].length);
    for (const [real, fake] of subs) {
      if (real.length < 3) continue;
      // Whole tokens only: "acme" must not rewrite "acmeCorp" or substrings of ordinary words.
      out = out.replace(new RegExp(`(?<![\\w.-])${escapeRe(real)}(?![\\w-])`, 'g'), fake);
    }
    for (const [real, fake] of this.users)
      if (real.length >= 5) out = out.replace(new RegExp(`\\b${real}\\b`, 'g'), fake);
    return out;
  }

  sanitizeAll(docs: Json[]): Json[] {
    for (const d of docs) this.learn(d);
    return docs.map((d) => this.apply(d));
  }

  mapping(): Record<string, Record<string, string>> {
    const o = (m: Map<string, string>) => Object.fromEntries(m);
    return {
      accounts: o(this.accounts),
      users: o(this.users),
      names: o(this.names),
      emails: o(this.emails),
      ips: o(this.ips),
      guids: o(this.guids),
    };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_mapping') && f !== 'introspection.json')
    .sort();
  if (files.length === 0) {
    console.error(`No raw results in ${RAW_DIR}. Run node probe.ts first.`);
    process.exit(2);
  }
  const known = [process.env['NR_ACCOUNT_A'], process.env['NR_ACCOUNT_B']].filter((x): x is string =>
    Boolean(x),
  );
  const s = new Sanitizer(known);
  mkdirSync(SANITIZED_DIR, { recursive: true });
  const dataFiles = files.filter((f) => !SCHEMA_FILES.has(f));
  const docs = dataFiles.map((f) => JSON.parse(readFileSync(join(RAW_DIR, f), 'utf8')) as Json);
  const out = s.sanitizeAll(docs);
  for (const [i, f] of dataFiles.entries())
    writeFileSync(join(SANITIZED_DIR, f), `${JSON.stringify(out[i], null, 2)}\n`);
  // Public schema: copied verbatim (still scrubbed for keys/emails/URLs as a safety net).
  for (const f of files.filter((x) => SCHEMA_FILES.has(x))) {
    const schema = JSON.parse(readFileSync(join(RAW_DIR, f), 'utf8')) as Json;
    writeFileSync(join(SANITIZED_DIR, f), `${JSON.stringify(new Sanitizer().apply(schema), null, 2)}\n`);
  }
  writeFileSync(join(RAW_DIR, '_mapping.json'), JSON.stringify(s.mapping(), null, 2));
  console.log(`Sanitized ${files.length} files → ${SANITIZED_DIR}`);
  console.log('introspection.json is schema-only and is not copied; schema-excerpt.json is.');
  console.log(
    'Now review every file manually (README checklist) before copying anything to packages/core/test/fixtures/.',
  );
}
