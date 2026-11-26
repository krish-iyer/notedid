import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../shared/sha256.ts';

const node = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

describe('sha256Hex', () => {
  it('matches the standard test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches Node for text and bytes of every length around the block edges, and for Unicode', () => {
    for (let n = 0; n < 200; n++) {
      const bytes = randomBytes(n);
      expect(sha256Hex(bytes)).toBe(node(bytes));
    }
    for (const text of ['café ☕ – “notes”', '﻿---\r\nid: k7q9m2vbfz4r\r\n---\r\n', '日本語のノート', 'x'.repeat(100_000)]) expect(sha256Hex(text)).toBe(node(text));
    const big = randomBytes(3 * 1024 * 1024 + 17);
    expect(sha256Hex(big)).toBe(node(big));
  });
});
