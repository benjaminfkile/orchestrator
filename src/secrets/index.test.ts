import fs from "fs";
import os from "os";
import path from "path";

import { Keychain, SecretStore } from "./index";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-secrets-"));
}

/** An in-memory keychain double: no OS interaction, inspectable in assertions. */
function fakeKeychain(seed?: string): Keychain & { value: string | null } {
  return {
    value: seed ?? null,
    get() {
      return this.value;
    },
    set(password: string) {
      this.value = password;
    },
  };
}

describe("SecretStore with a mocked keychain", () => {
  let dir: string;
  let keychain: ReturnType<typeof fakeKeychain>;

  beforeEach(() => {
    dir = tempDir();
    keychain = fakeKeychain();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mints and stores a fresh 32-byte master key on first use", () => {
    const store = new SecretStore({ dir, keychain, env: {} });
    store.init();
    expect(keychain.value).not.toBeNull();
    expect(Buffer.from(keychain.value as string, "base64")).toHaveLength(32);
  });

  it("round-trips a value through disk and re-decrypts with the same key", () => {
    const store = new SecretStore({ dir, keychain, env: {} });
    store.set("ADO_PAT", "super-secret-token");
    expect(store.get("ADO_PAT")).toBe("super-secret-token");
    expect(fs.existsSync(path.join(dir, "secrets.enc"))).toBe(true);

    // A brand-new instance reading the same key from the keychain must decrypt.
    const reopened = new SecretStore({ dir, keychain, env: {} });
    expect(reopened.get("ADO_PAT")).toBe("super-secret-token");
  });

  it("returns undefined for unknown keys", () => {
    const store = new SecretStore({ dir, keychain, env: {} });
    expect(store.get("NOPE")).toBeUndefined();
  });

  it("unset removes a key and persists the change", () => {
    const store = new SecretStore({ dir, keychain, env: {} });
    store.set("GIT_TOKEN", "gt");
    store.set("ADO_PAT", "pat");
    store.unset("GIT_TOKEN");
    expect(store.get("GIT_TOKEN")).toBeUndefined();

    const reopened = new SecretStore({ dir, keychain, env: {} });
    expect(reopened.get("GIT_TOKEN")).toBeUndefined();
    expect(reopened.get("ADO_PAT")).toBe("pat");
  });

  it("unset of an absent key is a no-op and does not throw", () => {
    const store = new SecretStore({ dir, keychain, env: {} });
    expect(() => store.unset("MISSING")).not.toThrow();
  });

  it("listKeys returns sorted names only, never values", () => {
    const store = new SecretStore({ dir, keychain, env: {} });
    store.set("ZED", "z-value");
    store.set("ADO_PAT", "a-value");
    store.set("CLAUDE_CODE_OAUTH_TOKEN", "c-value");
    expect(store.listKeys()).toEqual([
      "ADO_PAT",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ZED",
    ]);
    expect(JSON.stringify(store.listKeys())).not.toContain("value");
  });

  it("never writes plaintext values to the store file", () => {
    const store = new SecretStore({ dir, keychain, env: {} });
    store.set("ADO_PAT", "plaintext-should-not-appear");
    const onDisk = fs.readFileSync(path.join(dir, "secrets.enc"), "utf8");
    expect(onDisk).not.toContain("plaintext-should-not-appear");
    const envelope = JSON.parse(onDisk);
    expect(envelope).toEqual({
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    });
    // 12-byte IV, base64-encoded.
    expect(Buffer.from(envelope.iv, "base64")).toHaveLength(12);
  });

  it("draws a fresh IV on every write", () => {
    const store = new SecretStore({ dir, keychain, env: {} });
    store.set("K", "v1");
    const first = JSON.parse(
      fs.readFileSync(path.join(dir, "secrets.enc"), "utf8")
    ).iv;
    store.set("K", "v2");
    const second = JSON.parse(
      fs.readFileSync(path.join(dir, "secrets.enc"), "utf8")
    ).iv;
    expect(first).not.toBe(second);
  });

  it("fails to decrypt when the keychain key changes (tamper/rotation)", () => {
    const store = new SecretStore({ dir, keychain, env: {} });
    store.set("ADO_PAT", "pat");

    // Simulate a different key in the keychain.
    const other = fakeKeychain(Buffer.alloc(32, 7).toString("base64"));
    const reopened = new SecretStore({ dir, keychain: other, env: {} });
    expect(() => reopened.get("ADO_PAT")).toThrow(/decrypt/i);
  });
});

describe("SecretStore passphrase fallback", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("derives the key from ORCH_MASTER_KEY when the keychain is disabled", () => {
    const env = { ORCH_DISABLE_KEYCHAIN: "1", ORCH_MASTER_KEY: "correct horse" };
    const store = new SecretStore({ dir, keychain: fakeKeychain(), env });
    store.set("ADO_PAT", "pat");
    expect(fs.existsSync(path.join(dir, "secrets.salt"))).toBe(true);

    const reopened = new SecretStore({ dir, keychain: fakeKeychain(), env });
    expect(reopened.get("ADO_PAT")).toBe("pat");
  });

  it("uses the fallback when no keychain backend is available", () => {
    const env = { ORCH_MASTER_KEY: "passphrase" };
    const store = new SecretStore({ dir, keychain: null, env });
    store.set("GIT_TOKEN", "gt");
    const reopened = new SecretStore({ dir, keychain: null, env });
    expect(reopened.get("GIT_TOKEN")).toBe("gt");
  });

  it("a wrong passphrase cannot decrypt a store sealed with another", () => {
    const store = new SecretStore({
      dir,
      keychain: null,
      env: { ORCH_MASTER_KEY: "right" },
    });
    store.set("ADO_PAT", "pat");

    const wrong = new SecretStore({
      dir,
      keychain: null,
      env: { ORCH_MASTER_KEY: "wrong" },
    });
    expect(() => wrong.get("ADO_PAT")).toThrow(/decrypt/i);
  });

  it("throws a value-free error when no key source is configured", () => {
    const store = new SecretStore({ dir, keychain: null, env: {} });
    expect(() => store.init()).toThrow(/ORCH_MASTER_KEY/);
  });

  it("persists a stable salt across instances", () => {
    const env = { ORCH_DISABLE_KEYCHAIN: "1", ORCH_MASTER_KEY: "pp" };
    const store = new SecretStore({ dir, keychain: fakeKeychain(), env });
    store.set("K", "v");
    const salt1 = fs.readFileSync(path.join(dir, "secrets.salt"));

    const reopened = new SecretStore({ dir, keychain: fakeKeychain(), env });
    expect(reopened.get("K")).toBe("v");
    const salt2 = fs.readFileSync(path.join(dir, "secrets.salt"));
    expect(salt1.equals(salt2)).toBe(true);
    expect(salt1).toHaveLength(16);
  });
});

describe("SecretStore default dir honors ORCH_DATA_DIR", () => {
  const original = process.env.ORCH_DATA_DIR;
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (original === undefined) delete process.env.ORCH_DATA_DIR;
    else process.env.ORCH_DATA_DIR = original;
  });

  it("writes secrets.enc under ORCH_DATA_DIR when the store has no explicit dir", () => {
    process.env.ORCH_DATA_DIR = dir;
    const store = new SecretStore({ keychain: fakeKeychain(), env: {} });
    store.set("K", "v");
    expect(fs.existsSync(path.join(dir, "secrets.enc"))).toBe(true);
  });
});
