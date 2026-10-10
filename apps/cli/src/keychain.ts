// SPDX-License-Identifier: Apache-2.0
// OS keychain access (P7-11, THREAT_MODEL T7). Node only (ADR-0004). No native module: the OS's own tool is run, and
// the secret goes to it on stdin, never as an argument (process lists would show it). Entries live under service
// `relic-bridge`; the account is a validated name. The backend is synchronous so config loading stays synchronous.
import { spawnSync } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'relic-bridge';
/** A name given to `keychain:<name>`, `keychain set <name>` and `RB_*_KEYCHAIN`. */
export const KEYCHAIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** What may be stored: New Relic keys, `v1:<base64>` master keys, tokens. Keeps every quoting layer trivially safe. */
export const KEYCHAIN_SECRET_RE = /^[A-Za-z0-9_+/=.~:-]{1,512}$/;
/** `apiKey: keychain:<name>` in YAML. */
export const KEYCHAIN_REF_RE = /^keychain:([^\s]*)$/;

const TIMEOUT_MS = 15_000;

export type KeychainErrorCode = 'unavailable' | 'invalid_name' | 'invalid_secret' | 'failed';

/** Messages never contain the secret or the tool's raw output. */
export class KeychainError extends Error {
  readonly code: KeychainErrorCode;
  readonly hint: string | undefined;
  constructor(code: KeychainErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'KeychainError';
    this.code = code;
    this.hint = hint;
  }
}

export interface Keychain {
  /** Human name of the backend, e.g. `macOS Keychain`. */
  readonly backend: string;
  /** The stored secret, or `undefined` when there is no such entry. Throws `KeychainError` when unusable. */
  get(name: string): string | undefined;
  /** Create or replace; reads the entry back to confirm. */
  set(name: string, secret: string): void;
  /** Whether an entry was removed. */
  delete(name: string): boolean;
  /** `undefined` when usable, else why not (never throws). */
  unavailable(): string | undefined;
}

export function assertKeychainName(name: string): void {
  if (!KEYCHAIN_NAME_RE.test(name)) {
    throw new KeychainError(
      'invalid_name',
      'A keychain name is 1-64 characters: lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit.',
    );
  }
}

export function assertKeychainSecret(secret: string): void {
  if (!KEYCHAIN_SECRET_RE.test(secret)) {
    throw new KeychainError(
      'invalid_secret',
      'The value cannot be stored: up to 512 characters from A-Z a-z 0-9 _ + / = . ~ : - (no spaces or quotes).',
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Process runner (injected in tests)
// ---------------------------------------------------------------------------------------------------------------

export interface RunResult {
  /** Exit code; `null` when the program could not run or was killed. */
  readonly status: number | null;
  readonly stdout: string;
  /** Whether the program wrote to stderr (its text is never kept: it can quote what was passed in). */
  readonly stderr?: boolean;
  /** The program does not exist on this machine. */
  readonly missing: boolean;
}
export type Runner = (command: string, args: readonly string[], input?: string) => RunResult;

export const spawnRunner: Runner = (command, args, input) => {
  const r = spawnSync(command, [...args], {
    ...(input === undefined ? {} : { input }),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') !== '',
    missing: code === 'ENOENT',
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------------------------------------------

interface Backend {
  readonly name: string;
  /** Run `read`; `undefined` = no entry. */
  read(name: string): string | undefined;
  write(name: string, secret: string): void;
  remove(name: string): boolean;
  probe(): string | undefined;
}

function toolMissing(tool: string, hint: string): KeychainError {
  return new KeychainError('unavailable', `${tool} was not found on this machine.`, hint);
}

/** Absolute paths: a bare name makes Windows look in the working directory first (a planted binary would get the secret). */
const MAC_SECURITY = '/usr/bin/security';
const WIN_POWERSHELL_SUFFIX = '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function windowsPowerShell(env: Readonly<Record<string, string | undefined>>): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? env['windir'] ?? 'C:\\Windows';
  return `${root.replace(/[\\/]+$/, '')}${WIN_POWERSHELL_SUFFIX}`;
}

function macBackend(run: Runner): Backend {
  const NAME = 'macOS Keychain';
  const MISSING = 'The `security` tool is part of macOS; check that /usr/bin is on PATH.';
  return {
    name: NAME,
    probe: () =>
      run(MAC_SECURITY, ['help'], undefined).missing ? 'the `security` tool was not found' : undefined,
    read(name) {
      const r = run(MAC_SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w']);
      if (r.missing) throw toolMissing('security', MISSING);
      if (r.status === 44) return undefined; // errSecItemNotFound
      if (r.status !== 0)
        throw new KeychainError('failed', 'The macOS Keychain refused the read (locked or denied).');
      const value = r.stdout.replace(/\r?\n$/, '');
      return value === '' ? undefined : value;
    },
    write(name, secret) {
      // `security -i` reads commands from stdin, so the secret never appears in the process list. Name and secret are
      // restricted to characters that need no quoting.
      const r = run(
        MAC_SECURITY,
        ['-i'],
        `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -w ${secret}\n`,
      );
      if (r.missing) throw toolMissing('security', MISSING);
      if (r.status !== 0) throw new KeychainError('failed', 'The macOS Keychain refused the write.');
    },
    remove(name) {
      const r = run(MAC_SECURITY, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name]);
      if (r.missing) throw toolMissing('security', MISSING);
      if (r.status === 44) return false;
      if (r.status !== 0) throw new KeychainError('failed', 'The macOS Keychain refused the delete.');
      return true;
    },
  };
}

function libsecretBackend(run: Runner, wsl: boolean): Backend {
  const HINT = wsl
    ? 'WSL2 has no keychain of its own: install libsecret-tools and run a Secret Service (gnome-keyring) in the distro, or use RB_MASTER_KEY_FILE or an environment variable instead. The Windows credential store is not reachable from WSL.'
    : 'Install libsecret-tools (Debian/Ubuntu: apt install libsecret-tools) and run a Secret Service such as gnome-keyring or KeePassXC, or use a 0600 key file or an environment variable instead.';
  const attrs = (name: string): string[] => ['service', KEYCHAIN_SERVICE, 'account', name];
  return {
    name: 'libsecret (Secret Service)',
    probe: () =>
      run('secret-tool', ['--version']).missing ? 'secret-tool (libsecret-tools) was not found' : undefined,
    read(name) {
      const r = run('secret-tool', ['lookup', ...attrs(name)]);
      if (r.missing) throw toolMissing('secret-tool', HINT);
      if (r.status === 0 && r.stdout !== '') return r.stdout.replace(/\r?\n$/, '');
      // `lookup` exits 1 and prints nothing for a missing entry; a session without a Secret Service (no D-Bus, locked,
      // headless, WSL2) prints an error, which must not be mistaken for "no entry".
      if (r.stderr === true) {
        throw new KeychainError(
          'unavailable',
          'secret-tool could not reach a Secret Service (keyring).',
          HINT,
        );
      }
      return undefined;
    },
    write(name, secret) {
      const r = run('secret-tool', ['store', `--label=${KEYCHAIN_SERVICE}: ${name}`, ...attrs(name)], secret);
      if (r.missing) throw toolMissing('secret-tool', HINT);
      if (r.status !== 0) {
        throw new KeychainError(
          'failed',
          'secret-tool could not store the secret (is a Secret Service running and unlocked?).',
          HINT,
        );
      }
    },
    remove(name) {
      const existed = this.read(name) !== undefined;
      const r = run('secret-tool', ['clear', ...attrs(name)]);
      if (r.missing) throw toolMissing('secret-tool', HINT);
      return existed;
    },
  };
}

/** PowerShell for the Windows backend. `name` is validated; the secret is read from stdin. */
export function windowsScript(op: 'get' | 'set' | 'delete', name: string): string {
  assertKeychainName(name);
  const head = [
    "$ErrorActionPreference='Stop'",
    '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]',
    '$v=New-Object Windows.Security.Credentials.PasswordVault',
    `$r='${KEYCHAIN_SERVICE}'`,
    `$u='${name}'`,
  ];
  const body: Record<typeof op, string[]> = {
    set: [
      '$p=[Console]::In.ReadLine()',
      'try{$v.Remove($v.Retrieve($r,$u))}catch{}',
      '$v.Add((New-Object Windows.Security.Credentials.PasswordCredential($r,$u,$p)))',
    ],
    get: [
      'try{$c=$v.Retrieve($r,$u)}catch{exit 3}',
      '$c.RetrievePassword()',
      '[Console]::Out.Write($c.Password)',
    ],
    delete: ['try{$c=$v.Retrieve($r,$u)}catch{exit 3}', '$v.Remove($c)'],
  };
  return [...head, ...body[op]].join('\n');
}

function windowsBackend(run: Runner, env: Readonly<Record<string, string | undefined>>): Backend {
  const POWERSHELL = windowsPowerShell(env);
  const HINT = 'Windows PowerShell (powershell.exe) is part of Windows; check that it is on PATH.';
  const ps = (op: 'get' | 'set' | 'delete', name: string, input?: string): RunResult => {
    const encoded = Buffer.from(windowsScript(op, name), 'utf16le').toString('base64');
    const r = run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], input);
    if (r.missing) throw toolMissing('powershell.exe', HINT);
    return r;
  };
  return {
    name: 'Windows Credential Manager (PasswordVault)',
    probe: () =>
      run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).missing
        ? 'powershell.exe was not found'
        : undefined,
    read(name) {
      const r = ps('get', name);
      if (r.status === 3) return undefined;
      if (r.status !== 0) throw new KeychainError('failed', 'The Windows credential store refused the read.');
      return r.stdout === '' ? undefined : r.stdout.replace(/\r?\n$/, '');
    },
    write(name, secret) {
      const r = ps('set', name, `${secret}\n`);
      if (r.status !== 0)
        throw new KeychainError('failed', 'The Windows credential store refused the write.');
    },
    remove(name) {
      const r = ps('delete', name);
      if (r.status === 3) return false;
      if (r.status !== 0)
        throw new KeychainError('failed', 'The Windows credential store refused the delete.');
      return true;
    },
  };
}

function unsupportedBackend(platform: string): Backend {
  const err = new KeychainError(
    'unavailable',
    `No OS keychain support for platform "${platform}".`,
    'Use a 0600 key file or an environment variable instead.',
  );
  return {
    name: 'none',
    probe: () => err.message,
    read: () => {
      throw err;
    },
    write: () => {
      throw err;
    },
    remove: () => {
      throw err;
    },
  };
}

export interface KeychainOptions {
  readonly platform: string;
  /** Environment, to recognise WSL (`WSL_DISTRO_NAME`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: Runner;
}

/** The keychain for this OS. Nothing is run until a method is called. */
export function createKeychain(options: KeychainOptions): Keychain {
  const run = options.run ?? spawnRunner;
  const wsl = (options.env?.['WSL_DISTRO_NAME'] ?? '') !== '';
  const backend =
    options.platform === 'darwin'
      ? macBackend(run)
      : options.platform === 'win32'
        ? windowsBackend(run, options.env ?? process.env)
        : options.platform === 'linux' || options.platform === 'freebsd' || options.platform === 'openbsd'
          ? libsecretBackend(run, wsl)
          : unsupportedBackend(options.platform);
  return {
    backend: backend.name,
    unavailable: () => backend.probe(),
    get(name) {
      assertKeychainName(name);
      return backend.read(name);
    },
    set(name, secret) {
      assertKeychainName(name);
      assertKeychainSecret(secret);
      backend.write(name, secret);
      if (backend.read(name) !== secret) {
        throw new KeychainError('failed', `The ${backend.name} did not keep the value (read-back differs).`);
      }
    },
    delete(name) {
      assertKeychainName(name);
      return backend.remove(name);
    },
  };
}

/**
 * Read an entry that configuration refers to: a missing entry or an unusable backend is a `KeychainError` with a
 * fix, never an empty string.
 */
export function readKeychainSecret(keychain: Keychain, name: string, what: string): string {
  assertKeychainName(name);
  const value = keychain.get(name);
  if (value === undefined || value.trim() === '') {
    throw new KeychainError(
      'failed',
      `${what}: no keychain entry "${name}" in the ${keychain.backend}.`,
      `Store it with: relic-bridge keychain set ${name}`,
    );
  }
  return value.trim();
}
