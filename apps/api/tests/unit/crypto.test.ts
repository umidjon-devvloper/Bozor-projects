import { describe, expect, it } from 'vitest';
import {
  blindIndex,
  blindIndexEquals,
  decryptField,
  encryptField,
  isEncrypted,
  maskDocumentNumber,
} from '../../src/shared/crypto.js';

describe('field encryption', () => {
  it('round-trips a passport number', () => {
    const envelope = encryptField('AA1234567');
    expect(decryptField(envelope)).toBe('AA1234567');
  });

  it('produces a different ciphertext every time', () => {
    // A deterministic cipher would let anyone with read access group applicants by whether
    // they share a document, without decrypting anything.
    const first = encryptField('AA1234567');
    const second = encryptField('AA1234567');
    expect(first).not.toBe(second);
    expect(decryptField(first)).toBe(decryptField(second));
  });

  it('emits a versioned envelope so keys can be rotated later', () => {
    const envelope = encryptField('123456789');
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(envelope.split(':')).toHaveLength(4);
    expect(isEncrypted(envelope)).toBe(true);
    expect(isEncrypted('AA1234567')).toBe(false);
  });

  it('detects tampering rather than returning plausible garbage', () => {
    // GCM authenticates as well as encrypts. Flipping a ciphertext bit must fail loudly.
    const envelope = encryptField('AA1234567');
    const [version, iv, tag, data] = envelope.split(':');
    const flipped = Buffer.from(data ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const tampered = [version, iv, tag, flipped.toString('base64url')].join(':');
    expect(() => decryptField(tampered)).toThrow(/could not be decrypted/);
  });

  it('rejects a forged authentication tag', () => {
    const envelope = encryptField('AA1234567');
    const [version, iv, , data] = envelope.split(':');
    const forged = [version, iv, Buffer.alloc(16).toString('base64url'), data].join(':');
    expect(() => decryptField(forged)).toThrow();
  });

  it('rejects malformed and unknown-version envelopes', () => {
    expect(() => decryptField('not-an-envelope')).toThrow(/malformed/);
    expect(() => decryptField('v9:a:b:c')).toThrow(/Unsupported/);
  });

  it('refuses to encrypt an empty value', () => {
    expect(() => encryptField('')).toThrow();
  });

  it('handles non-ASCII input', () => {
    expect(decryptField(encryptField('Азиз Каримов'))).toBe('Азиз Каримов');
  });
});

describe('blind index', () => {
  it('is deterministic, so it can be uniquely indexed', () => {
    expect(blindIndex('AA1234567')).toBe(blindIndex('AA1234567'));
  });

  it('normalises case and whitespace', () => {
    // The same document typed three ways must collide, or duplicate detection misses.
    expect(blindIndex(' aa1234567 ')).toBe(blindIndex('AA1234567'));
    expect(blindIndex('AA 1234567')).toBe(blindIndex('AA1234567'));
  });

  it('separates distinct values', () => {
    expect(blindIndex('AA1234567')).not.toBe(blindIndex('AA1234568'));
  });

  it('does not reveal its input', () => {
    const index = blindIndex('AA1234567');
    expect(index).toMatch(/^[a-f0-9]{64}$/);
    expect(index).not.toContain('1234567');
  });

  it('uses a key distinct from the encryption key', () => {
    // Domain separation: the same secret feeds the cursor signer and the cipher, so the
    // blind index must not be derivable from either.
    const index = blindIndex('AA1234567');
    const envelope = encryptField('AA1234567');
    expect(envelope).not.toContain(index);
  });

  it('compares in constant time', () => {
    const index = blindIndex('AA1234567');
    expect(blindIndexEquals(index, index)).toBe(true);
    expect(blindIndexEquals(index, blindIndex('AA7654321'))).toBe(false);
    expect(blindIndexEquals(index, 'short')).toBe(false);
  });

  it('refuses an empty value', () => {
    expect(() => blindIndex('   ')).toThrow();
  });
});

describe('maskDocumentNumber', () => {
  it('shows enough to identify, not enough to reuse', () => {
    expect(maskDocumentNumber('AA1234567')).toBe('AA***4567');
    expect(maskDocumentNumber('123')).toBe('***');
  });
});
