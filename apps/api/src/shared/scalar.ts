/**
 * Reading a scalar out of untrusted JSON.
 *
 * The API's own request bodies are validated by Zod before a handler sees them, but two kinds
 * of input arrive unvalidated by design: domain event payloads relayed by the worker, and
 * payment provider callbacks, whose shape is the provider's to change and not ours to assume.
 *
 * `String(value)` on those is a trap. If the field is ever an object, the result is the literal
 * text `[object Object]` — a perfectly valid-looking string that then becomes a transaction
 * key, or an account id, or the body of a notification somebody reads. This returns the
 * fallback instead, so a malformed payload produces a miss rather than a plausible forgery.
 */
export function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return String(value);
  return fallback;
}
