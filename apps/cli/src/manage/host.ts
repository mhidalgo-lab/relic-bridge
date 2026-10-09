// SPDX-License-Identifier: Apache-2.0
// Node implementations of `ManageHost`: terminal prompts (hidden for secrets), stdin, files. Kept apart from the
// command logic so that logic is testable with fakes.
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { ManageHost } from './io.ts';

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown';
  }
}

async function readAll(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > maxBytes) throw new Error('stdin is too long');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read one line from the terminal without echoing it (raw mode; Ctrl-C aborts; backspace edits). */
function hiddenLine(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (error?: Error): void => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          finish();
          return;
        }
        if (ch === '\u0003') {
          finish(new Error('aborted'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function visibleLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function nodeHost(signal?: AbortSignal): ManageHost {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin: readAll,
    promptSecret: hiddenLine,
    async prompt(question, fallback) {
      const answer = (
        await visibleLine(fallback === undefined ? `${question}: ` : `${question} [${fallback}]: `)
      ).trim();
      return answer === '' ? (fallback ?? '') : answer;
    },
    fetch: (url, init) => fetch(url, init),
    userName: currentUser,
    writeSecretFile(path, text) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
    },
    ...(signal === undefined ? {} : { signal }),
    sleep: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
  };
}
