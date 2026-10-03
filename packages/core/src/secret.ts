// SPDX-License-Identifier: Apache-2.0
import { REDACTED } from './redact.ts';

/** `util.inspect` hook (Node); a plain global symbol, so no `node:util` import is needed. */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/**
 * Holds a secret (e.g. a New Relic User key) so that it cannot leak through logging, string interpolation,
 * JSON serialization or `util.inspect`. The only way to read it is the explicit `reveal()` call, used at the
 * single point where the value is put on the wire (the NerdGraph client).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.defineProperty(this, INSPECT_CUSTOM, { value: () => REDACTED, enumerable: false });
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }
}
