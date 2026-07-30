import crypto from "crypto";
import fs from "fs";
import path from "path";

import { userDataDir } from "../config";

/**
 * Encrypted-at-rest key/value store for the secrets orchestrator injects into
 * leases (PATs, OAuth tokens, ...). The whole map is serialized to JSON and
 * sealed with AES-256-GCM into a single `secrets.enc` file in the orchestrator
 * user-data dir; a fresh random 12-byte IV is drawn on every write.
 *
 * The 32-byte master key is held by the OS keychain when one is available
 * (service "orchestrator"): a random key is minted on first use and read back
 * thereafter. When the keychain is unavailable — or `ORCH_DISABLE_KEYCHAIN=1`
 * forces it — the key is derived from the `ORCH_MASTER_KEY` passphrase with
 * scrypt (N=2^15) against a salt persisted next to the store.
 *
 * Secret VALUES never leave this module except through {@link SecretStore.get};
 * they are never logged and never placed in an error message. {@link
 * SecretStore.listKeys} returns names only.
 */

/** AES-256 master key length. */
const KEY_BYTES = 32;
/** GCM nonce length — 12 bytes is the standard, most-interoperable IV size. */
const IV_BYTES = 12;
/** scrypt salt length for the passphrase-derived fallback key. */
const SALT_BYTES = 16;
/** scrypt cost parameter (N). 2^15 balances resistance against boot latency. */
const SCRYPT_N = 2 ** 15;
/** scrypt block size (r) and parallelization (p) — library defaults. */
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/**
 * scrypt memory ceiling. Node's default 32 MiB is just under the ~33.5 MiB this
 * cost demands (128 * N * r), so it must be raised or scryptSync throws.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const STORE_FILE = "secrets.enc";
const SALT_FILE = "secrets.salt";

/** Keychain service name; the account under which the master key is stored. */
const KEYCHAIN_SERVICE = "orchestrator";
const KEYCHAIN_ACCOUNT = "master-key";

/** Owner-only file permissions for the on-disk store, salt, and key material. */
const FILE_MODE = 0o600;

/** The on-disk envelope: base64 parts of one AES-256-GCM sealing. */
interface Envelope {
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Minimal keychain abstraction the store depends on, so the OS-specific backend
 * (`@napi-rs/keyring`) can be swapped for a fake in tests. `get` returns the
 * stored master key (base64) or null when absent/unreadable.
 */
export interface Keychain {
  get(): string | null;
  set(password: string): void;
}

/** Construction options; all are injectable so tests never touch the real OS. */
export interface SecretStoreOptions {
  /** Directory holding `secrets.enc` and `secrets.salt`. Defaults to the user-data dir. */
  dir?: string;
  /**
   * Keychain backend. `undefined` loads the real OS keychain lazily; an explicit
   * `null` disables keychain use (forcing the passphrase fallback); a `Keychain`
   * is used as-is (the test path).
   */
  keychain?: Keychain | null;
  /** Environment source. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Wrap `@napi-rs/keyring` in the {@link Keychain} interface, or return null when
 * the module or the platform keychain is unavailable. Loaded lazily via require
 * so importing this module never forces the native addon at import time.
 */
function loadRealKeychain(): Keychain | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Entry } = require("@napi-rs/keyring") as {
      Entry: new (service: string, account: string) => {
        getPassword(): string;
        setPassword(password: string): void;
      };
    };
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    return {
      get() {
        try {
          return entry.getPassword();
        } catch {
          // No stored entry, or the platform store is inaccessible.
          return null;
        }
      },
      set(password) {
        entry.setPassword(password);
      },
    };
  } catch {
    return null;
  }
}

/**
 * The encrypted secret store. Instances are cheap; the key is resolved and the
 * file read lazily on first access (or explicitly via {@link init}).
 */
export class SecretStore {
  private readonly dir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly keychainProvider: () => Keychain | null;

  private key?: Buffer;
  private data?: Record<string, string>;

  constructor(options: SecretStoreOptions = {}) {
    this.dir = options.dir ?? userDataDir();
    this.env = options.env ?? process.env;
    this.keychainProvider =
      options.keychain !== undefined
        ? () => options.keychain ?? null
        : loadRealKeychain;
  }

  private get storePath(): string {
    return path.join(this.dir, STORE_FILE);
  }

  private get saltPath(): string {
    return path.join(this.dir, SALT_FILE);
  }

  /**
   * Resolve the master key and load the store into memory. Idempotent and safe
   * to call at boot; a missing store yields an empty map.
   */
  init(): void {
    this.ensureLoaded();
  }

  /** The decrypted value for `key`, or `undefined` when unset. */
  get(key: string): string | undefined {
    this.ensureLoaded();
    return this.data![key];
  }

  /** Set (or replace) `key` and persist the re-sealed store. */
  set(key: string, value: string): void {
    this.ensureLoaded();
    this.data![key] = value;
    this.persist();
  }

  /** Remove `key` if present and persist the re-sealed store. */
  unset(key: string): void {
    this.ensureLoaded();
    if (key in this.data!) {
      delete this.data![key];
      this.persist();
    }
  }

  /** The stored secret NAMES, sorted. Never returns or logs any value. */
  listKeys(): string[] {
    this.ensureLoaded();
    return Object.keys(this.data!).sort();
  }

  private ensureLoaded(): void {
    if (this.data === undefined) {
      this.key = this.resolveKey();
      this.data = this.load();
    }
  }

  /**
   * Obtain the 32-byte master key: from the OS keychain when enabled (minting
   * and storing a random key on first use), otherwise derived from the
   * `ORCH_MASTER_KEY` passphrase.
   */
  private resolveKey(): Buffer {
    if (this.env.ORCH_DISABLE_KEYCHAIN !== "1") {
      const keychain = this.keychainProvider();
      if (keychain) {
        const existing = keychain.get();
        if (existing) {
          const buf = Buffer.from(existing, "base64");
          if (buf.length === KEY_BYTES) {
            return buf;
          }
          // A stored value of the wrong length can't be our key; fall through
          // to mint a fresh one rather than fail every read.
        }
        const fresh = crypto.randomBytes(KEY_BYTES);
        keychain.set(fresh.toString("base64"));
        return fresh;
      }
    }
    return this.deriveKeyFromPassphrase();
  }

  /** Derive the key from the `ORCH_MASTER_KEY` passphrase + a persisted salt. */
  private deriveKeyFromPassphrase(): Buffer {
    const passphrase = this.env.ORCH_MASTER_KEY;
    if (!passphrase) {
      throw new Error(
        "ORCH_MASTER_KEY must be set when the OS keychain is unavailable " +
          "(or when ORCH_DISABLE_KEYCHAIN=1)."
      );
    }
    const salt = this.loadOrCreateSalt();
    return crypto.scryptSync(passphrase, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
  }

  /** Read the persisted scrypt salt, creating a random one on first use. */
  private loadOrCreateSalt(): Buffer {
    if (fs.existsSync(this.saltPath)) {
      return fs.readFileSync(this.saltPath);
    }
    const salt = crypto.randomBytes(SALT_BYTES);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.saltPath, salt, { mode: FILE_MODE });
    return salt;
  }

  /** Decrypt and parse the store file, or an empty map when it doesn't exist. */
  private load(): Record<string, string> {
    if (!fs.existsSync(this.storePath)) {
      return {};
    }
    let envelope: Envelope;
    try {
      envelope = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as Envelope;
    } catch {
      throw new Error(`Malformed secret store at ${this.storePath}.`);
    }
    try {
      const iv = Buffer.from(envelope.iv, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key!, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8")) as Record<string, string>;
    } catch {
      // Wrong key or tampered file — never surface any decrypted bytes.
      throw new Error(
        `Unable to decrypt the secret store at ${this.storePath}; ` +
          "the master key may have changed."
      );
    }
  }

  /** Seal the in-memory map with a fresh IV and write it to disk (mode 0600). */
  private persist(): void {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key!, iv);
    const plaintext = Buffer.from(JSON.stringify(this.data ?? {}), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: Envelope = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify(envelope), {
      mode: FILE_MODE,
    });
  }
}

let defaultStore: SecretStore | undefined;

/** The process-wide store singleton, backed by the real OS keychain. */
function getDefaultStore(): SecretStore {
  if (!defaultStore) {
    defaultStore = new SecretStore();
  }
  return defaultStore;
}

/**
 * Override the process-wide store singleton. Symmetric with the implicit
 * lazy construction in {@link getDefaultStore}; used by tests to point the
 * secret helpers at an in-memory/temp-dir store that never touches the real OS
 * keychain or user-data directory.
 */
export function setSecretStore(store: SecretStore): void {
  defaultStore = store;
}

/**
 * Resolve the master key and load the store at boot. Failures here (e.g. no
 * keychain and no `ORCH_MASTER_KEY`) surface immediately rather than on first
 * secret access.
 */
export function initSecrets(): void {
  getDefaultStore().init();
}

/** The decrypted value for `key`, or `undefined` when unset. */
export function getSecret(key: string): string | undefined {
  return getDefaultStore().get(key);
}

/** Set (or replace) a secret and persist the store. */
export function setSecret(key: string, value: string): void {
  getDefaultStore().set(key, value);
}

/** Remove a secret and persist the store. */
export function unsetSecret(key: string): void {
  getDefaultStore().unset(key);
}

/** The stored secret NAMES, sorted. Never exposes any value. */
export function listSecretKeys(): string[] {
  return getDefaultStore().listKeys();
}
