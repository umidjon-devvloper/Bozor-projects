/**
 * The base URL the app talks to.
 *
 * `EXPO_PUBLIC_` prefixed variables are inlined at build time by Expo. The localhost fallback
 * is for a simulator only: a physical phone on the same network cannot reach the developer's
 * localhost, and pointing it at a machine's LAN address is a per-developer setting rather than
 * something to commit.
 */
const configured: unknown = process.env.EXPO_PUBLIC_API_URL;
export const API_BASE_URL =
  typeof configured === 'string' && configured.length > 0 ? configured : 'http://localhost:4000';
