// SPDX-License-Identifier: Apache-2.0
import type { FetchLike } from '@relic-bridge/core';
import type { ConfigFs, Env } from '../config.ts';
import type { Keychain } from '../keychain.ts';

/**
 * Everything the management commands need from the process, injected so they run in tests without a terminal.
 * The Node implementations live in `host.ts`.
 */
export interface ManageHost {
  /** Whether stdin is a terminal (prompts possible). */
  readonly stdinIsTTY: boolean;
  /** Everything on stdin up to EOF, at most `maxBytes`; rejects when it is longer. */
  readStdin(maxBytes: number): Promise<string>;
  /** Ask on the terminal without echoing the answer. Only called when `stdinIsTTY`. */
  promptSecret(question: string): Promise<string>;
  /** Ask on the terminal (echoed), returning `fallback` for an empty answer. Only called when `stdinIsTTY`. */
  prompt(question: string, fallback?: string): Promise<string>;
  /** The `fetch` for remote mode. */
  readonly fetch: FetchLike;
  /** Local mode: NerdGraph fetch override (tests). When absent the test-hook environment variable decides. */
  readonly nerdGraphFetch?: FetchLike;
  /** The OS user running the CLI (recorded in the audit log for local changes). */
  userName(): string;
  /** Create `path` (and parents, mode 0700) exclusively with mode 0600; throws when it exists. */
  writeSecretFile(path: string, text: string): void;
  /** Node version for `doctor` (tests); defaults to the running process. */
  readonly nodeVersion?: string;
  /** Clock for `doctor` (tests); defaults to `Date.now`. */
  readonly now?: () => number;
  /** `audit tail --follow` stops when this aborts. */
  readonly signal?: AbortSignal;
  /** Pause for `ms`; resolves early on abort. */
  sleep(ms: number): Promise<void>;
}

/** The process view shared by every management command. */
export interface ManageContext {
  readonly host: ManageHost;
  readonly env: Env;
  readonly fs: ConfigFs;
  readonly platform: string;
  readonly homeDir?: string;
  /** Working directory (project-level client config files for `doctor --client-configs`). */
  readonly cwd?: string;
  /** OS keychain override (tests); the real one for this platform is created when a command needs it. */
  readonly keychain?: Keychain;
  /** Machine-readable output on stdout. */
  readonly stdout: (text: string) => void;
  /** Guidance, warnings and errors. Never receives a secret. */
  readonly stderr: (line: string) => void;
}
