import { argon2id } from 'hash-wasm';

/**
 * The vault's encryption, done entirely in the browser:
 *   passphrase --Argon2id--> key-encryption key --AES-GCM--> wraps a random 256-bit vault key
 *   recovery code --Argon2id--> a second key-encryption key that wraps the same vault key
 *   each note: AES-256-GCM with the vault key, its ID bound in as associated data.
 * The server only ever stores the key file (wrapped keys + salts) and the encrypted notes.
 */

export interface KdfParams {
  name: 'argon2id';
  salt: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export interface Wrapped {
  iv: string;
  data: string;
}

export interface VaultKeyFile {
  version: 1;
  createdAt: string;
  passphrase: { kdf: KdfParams; key: Wrapped };
  recovery: { kdf: KdfParams; key: Wrapped };
}

export interface VaultNote {
  title: string;
  body: string;
  created: string;
  updated: string;
}

export type KdfCost = Pick<KdfParams, 'memoryKiB' | 'iterations' | 'parallelism'>;

/** About half a second to a second in a browser; costly enough to make guessing passphrases slow. */
export const DEFAULT_COST: KdfCost = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY_AAD = 'notesapp-vault-key';
const FORMAT = 1;

export class WrongSecret extends Error {
  override name = 'WrongSecret';
}

export const base64 = {
  encode(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  },
  decode(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  },
};

function random(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function newKdf(cost: KdfCost): KdfParams {
  return { name: 'argon2id', salt: base64.encode(random(16)), ...cost };
}

async function deriveKey(secret: string, kdf: KdfParams): Promise<CryptoKey> {
  const raw = await argon2id({
    password: secret.normalize('NFKC'),
    salt: base64.decode(kdf.salt),
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memoryKiB,
    hashLength: 32,
    outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(key: CryptoKey, plain: Uint8Array<ArrayBuffer>, aad: string): Promise<Wrapped> {
  const iv = random(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, plain));
  return { iv: base64.encode(iv), data: base64.encode(data) };
}

async function unseal(key: CryptoKey, wrapped: Wrapped, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64.decode(wrapped.iv), additionalData: encoder.encode(aad) }, key, base64.decode(wrapped.data)));
}

function importVaultKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A random recovery code: 160 bits, shown as eight groups of four characters. */
export function newRecoveryCode(): string {
  const bytes = random(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)?.join('-') ?? out;
}

/** Accepts a recovery code typed with spaces, dashes, lowercase, or O/I/L for 0/1. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export async function createVault(passphrase: string, cost: KdfCost = DEFAULT_COST): Promise<{ keyFile: VaultKeyFile; recoveryCode: string; key: CryptoKey }> {
  const vaultKey = random(32);
  const kdf = newKdf(cost);
  const recoveryCode = newRecoveryCode();
  const recoveryKdf = newKdf(cost);
  const keyFile: VaultKeyFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    passphrase: { kdf, key: await seal(await deriveKey(passphrase, kdf), vaultKey, KEY_AAD) },
    recovery: { kdf: recoveryKdf, key: await seal(await deriveKey(normalizeRecoveryCode(recoveryCode), recoveryKdf), vaultKey, KEY_AAD) },
  };
  const key = await importVaultKey(vaultKey);
  vaultKey.fill(0);
  return { keyFile, recoveryCode, key };
}

async function rawVaultKey(keyFile: VaultKeyFile, slot: 'passphrase' | 'recovery', secret: string): Promise<Uint8Array<ArrayBuffer>> {
  const entry = keyFile[slot];
  const kek = await deriveKey(slot === 'recovery' ? normalizeRecoveryCode(secret) : secret, entry.kdf);
  try {
    return await unseal(kek, entry.key, KEY_AAD);
  } catch {
    throw new WrongSecret(slot === 'recovery' ? 'That recovery code isn’t right.' : 'That passphrase isn’t right.');
  }
}

export async function unlockVault(keyFile: VaultKeyFile, passphrase: string): Promise<CryptoKey> {
  const raw = await rawVaultKey(keyFile, 'passphrase', passphrase);
  try {
    return await importVaultKey(raw);
  } finally {
    raw.fill(0);
  }
}

/** Sets a new passphrase, proving access with the current passphrase or the recovery code. Notes stay as they are. */
export async function setPassphrase(keyFile: VaultKeyFile, proof: { slot: 'passphrase' | 'recovery'; secret: string }, newPassphrase: string): Promise<{ keyFile: VaultKeyFile; key: CryptoKey }> {
  const raw = await rawVaultKey(keyFile, proof.slot, proof.secret);
  try {
    const { memoryKiB, iterations, parallelism } = keyFile.passphrase.kdf;
    const kdf = newKdf({ memoryKiB, iterations, parallelism });
    const next: VaultKeyFile = { ...keyFile, passphrase: { kdf, key: await seal(await deriveKey(newPassphrase, kdf), raw, KEY_AAD) } };
    return { keyFile: next, key: await importVaultKey(raw) };
  } finally {
    raw.fill(0);
  }
}

export async function encryptNote(key: CryptoKey, id: string, note: VaultNote): Promise<Uint8Array<ArrayBuffer>> {
  const iv = random(12);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`vault-note:${id}`) }, key, encoder.encode(JSON.stringify(note))));
  const out = new Uint8Array(1 + iv.length + sealed.length);
  out[0] = FORMAT;
  out.set(iv, 1);
  out.set(sealed, 1 + iv.length);
  return out;
}

export async function decryptNote(key: CryptoKey, id: string, bytes: Uint8Array): Promise<VaultNote> {
  if (bytes[0] !== FORMAT || bytes.length < 1 + 12 + 16) throw new Error('Not a vault note this app can read');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(bytes.slice(1, 13)), additionalData: encoder.encode(`vault-note:${id}`) },
    key,
    new Uint8Array(bytes.slice(13)),
  );
  const note = JSON.parse(decoder.decode(plain)) as Partial<VaultNote>;
  return { title: String(note.title ?? ''), body: String(note.body ?? ''), created: String(note.created ?? ''), updated: String(note.updated ?? '') };
}

/** A note's title: its first heading, else its first line. */
export function titleOf(body: string): string {
  const heading = /^#\s+(.+)$/m.exec(body)?.[1];
  const first = body.split('\n').find((l) => l.trim())?.replace(/^[#>\-*\s[\]x]+/, '');
  return (heading ?? first ?? '').trim().slice(0, 80) || 'Untitled';
}

export function isKeyFile(value: unknown): value is VaultKeyFile {
  const v = value as VaultKeyFile | null;
  return !!v && v.version === 1 && !!v.passphrase?.kdf?.salt && !!v.passphrase.key?.data && !!v.recovery?.key?.data;
}
