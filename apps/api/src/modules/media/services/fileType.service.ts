import { AppError, ErrorCode } from '@bozorlar/errors';

/**
 * Content-type detection from magic bytes.
 *
 * The client-supplied Content-Type is a hint, not evidence. Anyone can PUT a PHP script with
 * `Content-Type: image/jpeg`; on a public bucket fronted by a misconfigured CDN that becomes
 * a remote-execution vector, and on any bucket it becomes a malware distribution point under
 * our domain. The declared type is therefore verified against the actual bytes at confirm
 * time (SECURITY.md "Uploads").
 */

export type DetectedType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/gif'
  | 'image/heic'
  | 'application/pdf'
  | 'unknown';

/** Enough bytes to cover every signature below, including the ISO-BMFF ftyp box. */
export const MAGIC_BYTE_WINDOW = 32;

function startsWith(buffer: Buffer, signature: readonly number[], offset = 0): boolean {
  if (buffer.length < offset + signature.length) return false;
  return signature.every((byte, index) => buffer[offset + index] === byte);
}

export function detectContentType(buffer: Buffer): DetectedType {
  // JPEG: FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // PNG: 89 P N G CR LF SUB LF
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';

  // WebP: "RIFF" .... "WEBP" — the middle four bytes are the file length and vary.
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }

  // GIF: "GIF87a" or "GIF89a"
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) {
    const version = buffer[4];
    if (version === 0x37 || version === 0x39) return 'image/gif';
  }

  // HEIC/HEIF: ISO base media file, brand at offset 8 inside the "ftyp" box.
  if (startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }

  // PDF: "%PDF-"
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';

  return 'unknown';
}

/**
 * Verifies the real type against what the client declared and what the purpose permits.
 *
 * A mismatch is rejected rather than silently corrected: a client that declares JPEG and
 * uploads a PDF is either broken or probing, and neither deserves a stored object.
 */
export function assertContentTypeAllowed(input: {
  header: Buffer;
  declaredContentType: string;
  allowedMimeTypes: readonly string[];
}): DetectedType {
  const detected = detectContentType(input.header);

  if (detected === 'unknown') {
    throw new AppError(ErrorCode.MEDIA_TYPE_NOT_ALLOWED, {
      detail: 'The uploaded file is not a recognised image or PDF',
      params: { declared: input.declaredContentType },
    });
  }
  if (!input.allowedMimeTypes.includes(detected)) {
    throw new AppError(ErrorCode.MEDIA_TYPE_NOT_ALLOWED, {
      detail: `Files of type ${detected} are not accepted for this purpose`,
      params: { detected, allowed: input.allowedMimeTypes },
    });
  }
  if (detected !== input.declaredContentType) {
    throw new AppError(ErrorCode.MEDIA_TYPE_NOT_ALLOWED, {
      detail: 'The uploaded file does not match its declared content type',
      params: { declared: input.declaredContentType, detected },
    });
  }
  return detected;
}

const EXTENSIONS: Record<DetectedType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  unknown: 'bin',
};

export function extensionFor(type: DetectedType): string {
  return EXTENSIONS[type];
}
