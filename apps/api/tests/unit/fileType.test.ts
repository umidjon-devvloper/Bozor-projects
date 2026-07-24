import { describe, expect, it } from 'vitest';
import {
  assertContentTypeAllowed,
  detectContentType,
  extensionFor,
} from '../../src/modules/media/services/fileType.service.js';

const bytes = (...values: number[]): Buffer => Buffer.from(values);
const pad = (buffer: Buffer, length = 32): Buffer =>
  Buffer.concat([buffer, Buffer.alloc(Math.max(0, length - buffer.length))]);

describe('detectContentType', () => {
  it('recognises JPEG, PNG, WebP, GIF and PDF from their signatures', () => {
    expect(detectContentType(pad(bytes(0xff, 0xd8, 0xff, 0xe0)))).toBe('image/jpeg');
    expect(detectContentType(pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))).toBe('image/png');
    expect(
      detectContentType(
        pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
      ),
    ).toBe('image/webp');
    expect(detectContentType(pad(Buffer.from('GIF89a')))).toBe('image/gif');
    expect(detectContentType(pad(Buffer.from('%PDF-1.7')))).toBe('application/pdf');
  });

  it('recognises HEIC from the ftyp brand at offset 8', () => {
    const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('heic')]);
    expect(detectContentType(pad(heic))).toBe('image/heic');
  });

  it('does not mistake arbitrary data for a known type', () => {
    expect(detectContentType(pad(Buffer.from('<?php system($_GET[0]); ?>')))).toBe('unknown');
    expect(detectContentType(Buffer.alloc(0))).toBe('unknown');
    expect(detectContentType(bytes(0xff, 0xd8))).toBe('unknown'); // truncated JPEG signature
  });

  it('does not match a WebP whose trailing brand is wrong', () => {
    const fake = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')]);
    expect(detectContentType(pad(fake))).toBe('unknown');
  });
});

describe('assertContentTypeAllowed', () => {
  const jpeg = pad(bytes(0xff, 0xd8, 0xff, 0xe0));
  const allowed = ['image/jpeg', 'image/png', 'image/webp'] as const;

  it('accepts a file whose bytes match its declared type', () => {
    expect(
      assertContentTypeAllowed({ header: jpeg, declaredContentType: 'image/jpeg', allowedMimeTypes: allowed }),
    ).toBe('image/jpeg');
  });

  it('rejects a payload disguised with an image content type', () => {
    // The attack this exists to stop: a script uploaded as image/jpeg to a public bucket.
    const script = pad(Buffer.from('#!/bin/sh\nrm -rf /'));
    expect(() =>
      assertContentTypeAllowed({ header: script, declaredContentType: 'image/jpeg', allowedMimeTypes: allowed }),
    ).toThrow(/not a recognised/);
  });

  it('rejects a real file whose declared type is a lie', () => {
    const pdf = pad(Buffer.from('%PDF-1.7'));
    expect(() =>
      assertContentTypeAllowed({
        header: pdf,
        declaredContentType: 'image/jpeg',
        allowedMimeTypes: ['image/jpeg', 'application/pdf'],
      }),
    ).toThrow(/does not match its declared/);
  });

  it('rejects a valid type that this purpose does not permit', () => {
    const pdf = pad(Buffer.from('%PDF-1.7'));
    expect(() =>
      assertContentTypeAllowed({ header: pdf, declaredContentType: 'application/pdf', allowedMimeTypes: allowed }),
    ).toThrow(/not accepted for this purpose/);
  });
});

describe('extensionFor', () => {
  it('maps detected types to safe extensions', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('application/pdf')).toBe('pdf');
    expect(extensionFor('unknown')).toBe('bin');
  });
});
