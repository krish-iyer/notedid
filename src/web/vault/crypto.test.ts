import { describe, expect, it } from 'vitest';
import { createVault, decryptNote, encryptNote, newRecoveryCode, normalizeRecoveryCode, setPassphrase, titleOf, unlockVault, WrongSecret } from './crypto.ts';

// Light Argon2 settings so the tests run fast; the app uses 64 MiB and 3 passes.
const CHEAP = { memoryKiB: 1024, iterations: 1, parallelism: 1 };
const note = { title: 'Bank', body: '# Bank\n\nPIN hint: the year we met', created: '2026-11-25T10:00:00Z', updated: '2026-11-25T10:00:00Z' };

describe('vault crypto', () => {
  it('encrypts notes so only the right key and ID can read them', async () => {
    const { keyFile, key } = await createVault('correct horse battery staple', CHEAP);
    const id = 'a'.repeat(32);
    const sealed = await encryptNote(key, id, note);
    expect(new TextDecoder().decode(sealed)).not.toContain('PIN hint');
    expect(await decryptNote(key, id, sealed)).toEqual(note);
    await expect(decryptNote(key, 'b'.repeat(32), sealed)).rejects.toThrow(); // swapped item
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(decryptNote(key, id, tampered)).rejects.toThrow();

    const again = await unlockVault(keyFile, 'correct horse battery staple');
    expect(await decryptNote(again, id, sealed)).toEqual(note);
    await expect(unlockVault(keyFile, 'wrong')).rejects.toBeInstanceOf(WrongSecret);
    expect(JSON.stringify(keyFile)).not.toContain('correct horse');
  });

  it('recovers with the recovery code and changes the passphrase without re-encrypting notes', async () => {
    const { keyFile, recoveryCode, key } = await createVault('first passphrase', CHEAP);
    const id = 'c'.repeat(32);
    const sealed = await encryptNote(key, id, note);
    const typedSloppily = recoveryCode.toLowerCase().replace(/-/g, ' ');
    const reset = await setPassphrase(keyFile, { slot: 'recovery', secret: typedSloppily }, 'second passphrase');
    expect(await decryptNote(reset.key, id, sealed)).toEqual(note);
    await expect(unlockVault(reset.keyFile, 'first passphrase')).rejects.toBeInstanceOf(WrongSecret);
    expect(await decryptNote(await unlockVault(reset.keyFile, 'second passphrase'), id, sealed)).toEqual(note);
    await expect(setPassphrase(keyFile, { slot: 'passphrase', secret: 'nope' }, 'x')).rejects.toBeInstanceOf(WrongSecret);
  });

  it('makes readable recovery codes and titles', () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeRecoveryCode('abcd-o1il')).toBe('ABCD0111');
    expect(titleOf('# Bank\nmore')).toBe('Bank');
    expect(titleOf('\n- [ ] first line')).toBe('first line');
    expect(titleOf('')).toBe('Untitled');
  });
});
