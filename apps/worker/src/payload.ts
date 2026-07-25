/**
 * Reading a scalar out of a domain event payload.
 *
 * `DomainEventEnvelope.payload` is `Record<string, unknown>` because it arrives as JSON from
 * the outbox and the dispatcher is deliberately generic. Handlers were reaching into it with
 * `String(payload.orderId ?? fallback)`, which does the wrong thing precisely when it matters:
 * if the field is ever an object — a nested id, a Money serialised as `{ minor, currency }` —
 * `String` yields `[object Object]` and nothing complains. That value then goes on to be used
 * as an id to load a record, or as a variable inside a notification a person reads.
 *
 * This returns the fallback for anything that is not a scalar, so a malformed payload produces
 * a miss rather than a plausible-looking string. A handler that finds nothing stops; a handler
 * that finds `[object Object]` carries on.
 */
export function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return String(value);
  return fallback;
}
