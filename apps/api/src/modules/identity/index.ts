/**
 * Public surface of the identity module. Nothing outside this module may import its
 * internals (ADR-0011 rule 1) — that rule is enforced by dependency-cruiser in CI.
 */
export { createAuthService, type AuthService, type RequestMeta } from './services/auth.service.js';
export { createTokenService, type TokenService } from './services/token.service.js';
export { createSessionService, type SessionService } from './services/session.service.js';
export { createOtpService, type OtpService } from './services/otp.service.js';
export { createSmsProvider, type SmsProvider } from './services/sms.service.js';
export { passwordService } from './services/password.service.js';
export { userShopLinkService } from './services/userShopLink.service.js';
export { buyerSnapshot } from './services/buyerSnapshot.service.js';
export { createAuthController, type AuthController } from './http/auth.controller.js';
export { createAuthRouter, createDeviceRouter } from './http/auth.routes.js';
export { cookieNames, setAuthCookies, clearAuthCookies } from './http/cookies.js';
export { toPublicUser, maskPhone } from './http/mappers.js';
export { IdentityEvents } from './events.js';

/**
 * Cross-module surface for shop lifecycle operations.
 *
 * Exposed as a direct call rather than a domain event because shop approval must be atomic
 * across `shops`, `users.roles`, `users.shopIds` and `seller_applications` (DATABASE.md
 * Part 7). An event bus cannot participate in a transaction, and a half-onboarded seller is
 * worse than the coupling.
 */
