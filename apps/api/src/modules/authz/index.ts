/** Public surface of the authz module (ADR-0011 rule 1). */
export { Permission, ROLE_PERMISSIONS, resolvePermissions } from './permissions.js';
export { assertOwnResource, assertOwnShop, assertPhoneVerified } from './policies.js';
