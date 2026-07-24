import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Handover verification (ORDER_SYSTEM.md "Pickup verification").
 *
 * The buyer shows a six-digit code, the seller types it in. Only the hash is stored, so a
 * database read cannot be used to collect goods, and the verified handover is what anchors
 * dispute resolution later: "they had the code" is a materially different claim from "they
 * said they collected it".
 */
export function generatePickupCode(): string {
  // CSPRNG-backed. Math.random would make the code guessable from a known earlier one.
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashPickupCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function pickupCodeMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashPickupCode(candidate));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}
