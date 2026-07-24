import sharp from 'sharp';
import { encode as encodeBlurhash } from 'blurhash';
import { AppError, ErrorCode } from '@bozorlar/errors';
import type { VariantSpec } from '../media.constants.js';

/**
 * Image normalisation and derivative generation.
 *
 * Re-encoding is what strips metadata. A product photo taken at a stall carries EXIF GPS,
 * which would publish the seller's location — often their home — to anyone who downloads the
 * image. sharp discards all metadata on re-encode unless explicitly told to keep it, and the
 * orientation tag is baked into the pixels first so the image is not silently rotated
 * (SECURITY.md "Uploads").
 */

export interface ProcessedVariant {
  name: string;
  data: Buffer;
  contentType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface ProcessedImage {
  original: { width: number; height: number };
  blurhash: string;
  variants: ProcessedVariant[];
}

/** Guards against decompression bombs: a 100MP PNG expands to gigabytes in memory. */
const MAX_PIXELS = 50_000_000;

export async function processImage(
  source: Buffer,
  variants: readonly VariantSpec[],
): Promise<ProcessedImage> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(source, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch (cause) {
    throw new AppError(ErrorCode.MEDIA_TYPE_NOT_ALLOWED, {
      detail: 'The uploaded file could not be decoded as an image',
      cause,
    });
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width === 0 || height === 0) {
    throw new AppError(ErrorCode.MEDIA_TYPE_NOT_ALLOWED, {
      detail: 'The uploaded image has no readable dimensions',
    });
  }
  if (width * height > MAX_PIXELS) {
    throw new AppError(ErrorCode.MEDIA_TOO_LARGE, {
      detail: 'The image resolution exceeds the supported maximum',
      params: { width, height, maxPixels: MAX_PIXELS },
    });
  }

  const blurhash = await computeBlurhash(source);

  const produced: ProcessedVariant[] = [];
  for (const spec of variants) {
    const pipeline = sharp(source, { limitInputPixels: MAX_PIXELS })
      // Applies the EXIF orientation to the pixel data before that tag is discarded.
      .rotate()
      .resize({
        width: spec.width,
        height: spec.height,
        fit: spec.fit,
        // Never upscale: a 200px original blown up to 1600px is worse than the original and
        // costs eight times the storage.
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    produced.push({
      name: spec.name,
      data,
      contentType: 'image/webp',
      width: info.width,
      height: info.height,
      sizeBytes: info.size,
    });
  }

  return { original: { width, height }, blurhash, variants: produced };
}

/**
 * Blurhash placeholder, computed from a small raw thumbnail.
 *
 * The encoder is O(pixels x components), so it runs on a 32px raster rather than the full
 * image — the output is visually identical and the cost is negligible.
 */
async function computeBlurhash(source: Buffer): Promise<string> {
  const { data, info } = await sharp(source, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize(32, 32, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return encodeBlurhash(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
}

/**
 * Normalises an image that keeps its original form (no derivatives requested) by re-encoding
 * it once, purely to strip metadata.
 */
export async function stripMetadata(source: Buffer): Promise<Buffer> {
  return sharp(source, { limitInputPixels: MAX_PIXELS }).rotate().webp({ quality: 90 }).toBuffer();
}
