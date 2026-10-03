// SPDX-License-Identifier: Apache-2.0
import { redact, redactValue } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line (e.g. requestId, tool). */
  child(fields: LogFields): Logger;
}

/** Receives one already-redacted JSON line. */
export type LogSink = (line: string) => void;

/**
 * Default sink: `console.error`. On Node that is **stderr** (stdout is the stdio MCP channel); on Workers it goes to
 * Workers Logs. Never use `console.log` for diagnostics in this project.
 */
export const stderrSink: LogSink = (line) => console.error(line);

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  now?: () => number;
  fields?: LogFields;
}

/** Structured JSON logger. Redaction is mandatory: messages and fields always pass through `redact`. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVEL_RANK[options.level ?? 'info'];
  const sink = options.sink ?? stderrSink;
  const now = options.now ?? Date.now;
  const base = options.fields ?? {};

  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < min) return;
    const record = {
      ts: new Date(now()).toISOString(),
      level,
      msg: redact(msg),
      ...(redactValue({ ...base, ...fields }) as LogFields),
    };
    try {
      sink(JSON.stringify(record));
    } catch {
      // Logging must never break a request.
    }
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
  };
}

/** A logger that drops everything (tests, or when a caller explicitly opts out). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
