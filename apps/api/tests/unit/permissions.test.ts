import { describe, expect, it } from 'vitest';
import { UserRole } from '@bozorlar/types';
import { Permission, resolvePermissions } from '../../src/modules/authz/permissions.js';

describe('permission resolution', () => {
  it('gives a buyer no seller capabilities', () => {
    const permissions = resolvePermissions([UserRole.BUYER]);
    expect(permissions.has(Permission.ORDER_READ_OWN)).toBe(true);
    expect(permissions.has(Permission.ORDER_ACCEPT_OWN_SHOP)).toBe(false);
    expect(permissions.has(Permission.WALLET_READ_OWN)).toBe(false);
  });

  it('withholds wallet access from seller staff', () => {
    // Family-run stalls are the norm, so staff must be able to work orders without being
    // able to see or spend the shop's balance (USER_ROLES.md).
    const staff = resolvePermissions([UserRole.SELLER_STAFF]);
    expect(staff.has(Permission.ORDER_ACCEPT_OWN_SHOP)).toBe(true);
    expect(staff.has(Permission.WALLET_READ_OWN)).toBe(false);
    expect(staff.has(Permission.WALLET_TOPUP_OWN)).toBe(false);
  });

  it('withholds money movement from support', () => {
    const support = resolvePermissions([UserRole.SUPPORT]);
    expect(support.has(Permission.LEDGER_CREDIT_MANUAL)).toBe(false);
    expect(support.has(Permission.AUDIT_READ)).toBe(true);
  });

  it('unions permissions across multiple roles', () => {
    const both = resolvePermissions([UserRole.BUYER, UserRole.SELLER_OWNER]);
    expect(both.has(Permission.ORDER_READ_OWN)).toBe(true);
    expect(both.has(Permission.WALLET_TOPUP_OWN)).toBe(true);
  });
});
