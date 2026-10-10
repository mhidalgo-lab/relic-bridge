#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { main } from './main.ts';
import { nodeHost } from './manage/host.ts';

// stdout is the MCP channel. Anything a dependency prints with console.log/info/debug goes to stderr instead.
const toStderr = (...args: unknown[]): void => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

const stderr = (line: string): void => {
  process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
};

const abort = new AbortController();
if (process.argv.includes('--follow')) process.once('SIGINT', () => abort.abort());

const result = main({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  homeDir: homedir(),
  fs: {
    stat: (path) => statSync(path),
    readFile: (path) => readFileSync(path, 'utf8'),
  },
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr,
  manage: nodeHost(abort.signal),
});

if (result.kind === 'exit') {
  process.exitCode = result.code;
} else if (result.kind === 'pending') {
  result.done.then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Name only: an unexpected error's message could carry data we have not vetted.
      stderr(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          msg: 'command failed',
          name: error instanceof Error ? error.name : typeof error,
        }),
      );
      process.exitCode = 1;
    },
  );
} else if (result.kind === 'server') {
  result.started.then(
    (server) => {
      if (typeof server === 'number') {
        process.exitCode = server;
        return;
      }
      let closing = false;
      const shutdown = (reason: string): void => {
        if (closing) return;
        closing = true;
        stderr(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'shutting down', reason }));
        // Open streams get a few seconds; never hang on exit.
        setTimeout(() => process.exit(0), 8000).unref();
        server.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    },
    (error: unknown) => {
      stderr(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          msg: 'server failed to start',
          name: error instanceof Error ? error.name : typeof error,
        }),
      );
      process.exitCode = 1;
    },
  );
} else {
  const { close } = result;
  let closing = false;
  const shutdown = (reason: string): void => {
    if (closing) return;
    closing = true;
    stderr(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'shutting down', reason }));
    // Don't let a stuck close keep the process alive.
    setTimeout(() => process.exit(0), 2000).unref();
    close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  // The client closing our stdin ends the session (MCP stdio binding).
  process.stdin.once('end', () => shutdown('stdin closed'));
  process.on('uncaughtException', (error) => {
    stderr(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        msg: 'uncaught exception',
        name: error.name,
      }),
    );
    process.exit(1);
  });
}
