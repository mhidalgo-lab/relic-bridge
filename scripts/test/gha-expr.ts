// SPDX-License-Identifier: Apache-2.0
// A tiny evaluator for the subset of GitHub Actions expressions our workflow `if:` guards use (P8-68): dotted context
// names, string/boolean literals, `==`, `!=`, `!`, `&&`, `||`, parentheses, `startsWith()` and `cancelled()`. Tests use
// it to run a job guard against a ref or branch instead of matching its text. Anything else throws, so a guard that
// grows beyond the subset fails the test instead of being misread.

type Value = string | boolean;

const TOKEN_RE = /\s*(?:(\$\{\{|\}\})|('(?:[^']|'')*')|(==|!=|&&|\|\||[!(),])|([A-Za-z_][\w.-]*))/y;

function tokenize(expr: string): string[] {
  const out: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < expr.length) {
    if (/^\s*$/.test(expr.slice(pos))) break;
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(expr);
    if (m === null) throw new Error(`unsupported expression at: ${expr.slice(pos)}`);
    pos = TOKEN_RE.lastIndex;
    const token = m[2] ?? m[3] ?? m[4];
    if (token !== undefined) out.push(token);
  }
  return out;
}

const truthy = (v: Value): boolean => v !== '' && v !== false && v !== 'false';

/** Evaluates `expr` with `context` (missing names are `''`, as in GitHub Actions). */
export function evalGuard(expr: string, context: Readonly<Record<string, Value>>): boolean {
  const tokens = tokenize(expr);
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const take = (expected?: string): string => {
    const t = tokens[i++];
    if (t === undefined || (expected !== undefined && t !== expected)) {
      throw new Error(`expected ${expected ?? 'a token'}, got ${t ?? 'end'} in ${expr}`);
    }
    return t;
  };
  const primary = (): Value => {
    const t = take();
    if (t === '(') {
      const v = or();
      take(')');
      return v;
    }
    if (t === '!') return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1, -1).replaceAll("''", "'");
    if (t === 'true' || t === 'false') return t === 'true';
    if (peek() === '(') {
      take('(');
      const args: Value[] = [];
      while (peek() !== ')') {
        args.push(or());
        if (peek() === ',') take(',');
      }
      take(')');
      if (t === 'startsWith') return String(args[0]).toLowerCase().startsWith(String(args[1]).toLowerCase());
      if (t === 'cancelled') return false;
      throw new Error(`unsupported function ${t}`);
    }
    return context[t] ?? '';
  };
  const compare = (): Value => {
    const left = primary();
    const op = peek();
    if (op === '==' || op === '!=') {
      take();
      const right = primary();
      const equal = String(left).toLowerCase() === String(right).toLowerCase();
      return op === '==' ? equal : !equal;
    }
    return left;
  };
  const and = (): Value => {
    let v = compare();
    while (peek() === '&&') {
      take();
      const r = compare();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const or = (): Value => {
    let v = and();
    while (peek() === '||') {
      take();
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  const result = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in ${expr}`);
  return truthy(result);
}
