import { UserRole } from '@bozorlar/types';

/**
 * The permission catalog (PERMISSIONS.md).
 *
 * Built-in roles live in code rather than the database: a permission that can be edited in a
 * collection but not type-checked at compile time is how privilege escalation ships.
 */
export const Permission = {
  // identity
  USER_READ_OWN: 'identity:user:read:own',
  USER_UPDATE_OWN: 'identity:user:update:own',
  USER_DELETE_OWN: 'identity:user:delete:own',
  SESSION_READ_OWN: 'identity:session:read:own',
  SESSION_REVOKE_OWN: 'identity:session:revoke:own',
  DEVICE_MANAGE_OWN: 'identity:device:manage:own',

  // geo & merchants
  MARKET_READ: 'geo:market:read',
  MARKET_MANAGE: 'geo:market:manage',
  SHOP_READ_OWN: 'geo:shop:read:own',
  SHOP_CREATE: 'geo:shop:create',
  SHOP_UPDATE_OWN: 'geo:shop:update:own',
  SHOP_DELETE_OWN: 'geo:shop:delete:own',
  SHOP_MEMBERS_MANAGE: 'geo:shop:members:manage',
  SHOP_MODERATE: 'geo:shop:moderate',

  // onboarding
  ONBOARDING_APPLY: 'onboarding:application:create',
  ONBOARDING_READ_OWN: 'onboarding:application:read:own',
  /** Read any application. Answering "where is mine?" does not require deciding it. */
  ONBOARDING_READ_ALL: 'onboarding:application:read:all',
  /** Claim, approve, reject. */
  ONBOARDING_REVIEW: 'onboarding:application:review',
  ONBOARDING_REVEAL_IDENTITY: 'onboarding:application:reveal_identity',

  // disputes
  DISPUTE_RAISE_OWN: 'disputes:dispute:raise:own',
  DISPUTE_RESPOND_OWN_SHOP: 'disputes:dispute:respond:own_shop',
  DISPUTE_READ_ALL: 'disputes:dispute:read:all',

  // reviews
  REVIEW_CREATE_OWN: 'reviews:review:create:own',
  REVIEW_REPLY_OWN_SHOP: 'reviews:review:reply:own_shop',
  REVIEW_MODERATE: 'reviews:review:moderate',

  // reporting
  REPORT_READ_PLATFORM: 'reporting:report:read:platform',
  REPORT_READ_OWN_SHOP: 'reporting:report:read:own_shop',

  // favourites
  FAVOURITE_MANAGE_OWN: 'favourites:favourite:manage:own',
  FAVOURITE_READ_OWN_SHOP: 'favourites:favourite:read:own_shop',

  // search
  SEARCH_REINDEX: 'search:index:rebuild',

  // notifications
  NOTIFICATION_READ_OWN: 'notifications:notification:read:own',
  NOTIFICATION_TEST_SEND: 'notifications:notification:test_send',

  // media
  MEDIA_UPLOAD: 'media:asset:upload',
  MEDIA_READ_PRIVATE: 'media:asset:read:private',

  // catalog
  PRODUCT_READ: 'catalog:product:read',
  CATEGORY_MANAGE: 'catalog:category:manage',
  PRODUCT_MODERATE: 'catalog:product:moderate',
  PRODUCT_CREATE_OWN_SHOP: 'catalog:product:create:own_shop',
  PRODUCT_UPDATE_OWN_SHOP: 'catalog:product:update:own_shop',
  PRODUCT_DELETE_OWN_SHOP: 'catalog:product:delete:own_shop',

  // cart & checkout
  CART_MANAGE_OWN: 'checkout:cart:manage:own',
  CHECKOUT_QUOTE: 'checkout:quote:create',

  // orders
  ORDER_READ_OWN: 'orders:order:read:own',
  ORDER_CREATE: 'orders:order:create',
  ORDER_READ_OWN_SHOP: 'orders:order:read:own_shop',
  ORDER_CANCEL_OWN: 'orders:order:cancel:own',
  ORDER_CONFIRM_OWN: 'orders:order:confirm:own',
  ORDER_FULFIL_OWN_SHOP: 'orders:order:fulfil:own_shop',
  ORDER_ACCEPT_OWN_SHOP: 'orders:order:accept:own_shop',
  ORDER_ADJUST_OWN_SHOP: 'orders:order:adjust:own_shop',

  // money
  WALLET_READ_OWN: 'wallet:balance:read:own',
  WALLET_TOPUP_OWN: 'wallet:topup:create:own',
  LEDGER_READ: 'ledger:entry:read',
  LEDGER_CREDIT_MANUAL: 'ledger:credit:manual',
  COMMISSION_RULE_MANAGE: 'wallet:commission_rule:manage',
  WALLET_ADMIN: 'wallet:balance:manage',

  // moderation & admin
  MODERATION_REVIEW: 'moderation:item:review',
  DISPUTE_RESOLVE: 'disputes:dispute:resolve',
  USER_ADMIN: 'admin:user:manage',
  SETTINGS_UPDATE: 'platform:settings:update',
  AUDIT_READ: 'platform:audit:read',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const BUYER_PERMISSIONS: Permission[] = [
  Permission.USER_READ_OWN,
  Permission.USER_UPDATE_OWN,
  Permission.USER_DELETE_OWN,
  Permission.SESSION_READ_OWN,
  Permission.SESSION_REVOKE_OWN,
  Permission.DEVICE_MANAGE_OWN,
  Permission.PRODUCT_READ,
  Permission.MARKET_READ,
  Permission.MEDIA_UPLOAD,
  Permission.NOTIFICATION_READ_OWN,
  Permission.REVIEW_CREATE_OWN,
  Permission.FAVOURITE_MANAGE_OWN,
  Permission.DISPUTE_RAISE_OWN,
  Permission.ONBOARDING_APPLY,
  Permission.ONBOARDING_READ_OWN,
  Permission.CART_MANAGE_OWN,
  Permission.CHECKOUT_QUOTE,
  Permission.ORDER_READ_OWN,
  Permission.ORDER_CREATE,
  Permission.ORDER_CANCEL_OWN,
  Permission.ORDER_CONFIRM_OWN,
];

const SELLER_STAFF_PERMISSIONS: Permission[] = [
  ...BUYER_PERMISSIONS,
  Permission.SHOP_READ_OWN,
  Permission.SHOP_READ_OWN,
  Permission.SHOP_UPDATE_OWN,
  Permission.PRODUCT_CREATE_OWN_SHOP,
  Permission.PRODUCT_UPDATE_OWN_SHOP,
  Permission.ORDER_READ_OWN_SHOP,
  Permission.ORDER_ACCEPT_OWN_SHOP,
  Permission.ORDER_ADJUST_OWN_SHOP,
  Permission.ORDER_FULFIL_OWN_SHOP,
  Permission.REVIEW_REPLY_OWN_SHOP,
  Permission.FAVOURITE_READ_OWN_SHOP,
  Permission.REPORT_READ_OWN_SHOP,
  Permission.DISPUTE_RESPOND_OWN_SHOP,
];

/** Staff never touch the wallet. Separating this is the point of having two seller roles. */
const SELLER_OWNER_PERMISSIONS: Permission[] = [
  ...SELLER_STAFF_PERMISSIONS,
  // Staff may work the shop; only the owner may change it, close it, or change who works there.
  Permission.SHOP_CREATE,
  Permission.SHOP_UPDATE_OWN,
  Permission.SHOP_DELETE_OWN,
  Permission.SHOP_MEMBERS_MANAGE,
  Permission.PRODUCT_DELETE_OWN_SHOP,
  Permission.WALLET_READ_OWN,
  Permission.WALLET_TOPUP_OWN,
];

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  [UserRole.BUYER]: BUYER_PERMISSIONS,
  [UserRole.SELLER_STAFF]: SELLER_STAFF_PERMISSIONS,
  [UserRole.SELLER_OWNER]: SELLER_OWNER_PERMISSIONS,
  [UserRole.COURIER]: BUYER_PERMISSIONS,
  // Moderators must be able to open KYC documents and dispute evidence; every issue of a
  // signed URL for a private object is audited.
  [UserRole.MODERATOR]: [
    ...BUYER_PERMISSIONS,
    Permission.MODERATION_REVIEW,
    Permission.SHOP_MODERATE,
    Permission.PRODUCT_MODERATE,
    Permission.REVIEW_MODERATE,
    Permission.DISPUTE_READ_ALL,
    Permission.MEDIA_READ_PRIVATE,
    Permission.ONBOARDING_READ_ALL,
    Permission.ONBOARDING_REVIEW,
    // Reading a passport number is separable from deciding an application, so it can be
    // withdrawn from a role without removing the ability to moderate.
    Permission.ONBOARDING_REVEAL_IDENTITY,
  ],
  // Support handles the highest volume of social-engineering attempts and must not be able
  // to move money, even if the account is compromised (USER_ROLES.md).
  [UserRole.SUPPORT]: [
    ...BUYER_PERMISSIONS,
    Permission.ORDER_READ_OWN_SHOP,
    Permission.AUDIT_READ,
    // Read-only. Support handles the highest volume of social-engineering attempts and must
    // never be able to approve a seller or read an identity document (USER_ROLES.md).
    Permission.ONBOARDING_READ_ALL,
  ],
  [UserRole.FINANCE]: [
    ...BUYER_PERMISSIONS,
    Permission.LEDGER_READ,
    Permission.REPORT_READ_PLATFORM,
    Permission.LEDGER_CREDIT_MANUAL,
    Permission.WALLET_ADMIN,
    Permission.DISPUTE_RESOLVE,
    Permission.AUDIT_READ,
    Permission.MEDIA_READ_PRIVATE,
  ],
  [UserRole.ADMIN]: [
    ...BUYER_PERMISSIONS,
    Permission.MARKET_MANAGE,
    Permission.MODERATION_REVIEW,
    Permission.USER_ADMIN,
    Permission.AUDIT_READ,
    Permission.LEDGER_READ,
    Permission.PRODUCT_DELETE_OWN_SHOP,
    Permission.MEDIA_READ_PRIVATE,
    Permission.ONBOARDING_READ_ALL,
    Permission.ONBOARDING_REVIEW,
    Permission.ONBOARDING_REVEAL_IDENTITY,
  ],
  // SUPER_ADMIN alone may set commission rates. ADMIN is a broader role than the person who
  // signs off on pricing, and this is the single most consequential number in the system.
  [UserRole.SUPER_ADMIN]: Object.values(Permission),
};

export function resolvePermissions(roles: readonly UserRole[]): Set<string> {
  const permissions = new Set<string>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) permissions.add(permission);
  }
  return permissions;
}
