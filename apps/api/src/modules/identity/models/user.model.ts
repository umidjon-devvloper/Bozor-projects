import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { LOCALES, USER_ROLES, UserRole, UserStatus, type Locale } from '@bozorlar/types';

export interface UserDoc {
  _id: Types.ObjectId;
  phone: string;
  phoneVerifiedAt: Date | null;
  passwordHash: string;
  passwordChangedAt: Date;
  roles: UserRole[];
  status: UserStatus;
  statusReason: string | null;
  locale: Locale;
  email: string | null;
  emailVerifiedAt: Date | null;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  lastSeenAt: Date | null;
  /** Denormalized from shops.ownerId; kept in the same transaction (DATABASE.md 3.3). */
  shopIds: Types.ObjectId[];
  deletedAt: Date | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    phone: { type: String, required: true, trim: true, match: /^\+998\d{9}$/ },
    phoneVerifiedAt: { type: Date, default: null },
    // Never projected by accident: a hash in a log or an API response is a permanent leak.
    passwordHash: { type: String, required: true, select: false },
    passwordChangedAt: { type: Date, required: true, default: () => new Date() },
    roles: {
      type: [String],
      enum: USER_ROLES,
      required: true,
      default: [UserRole.BUYER],
      validate: { validator: (v: string[]) => v.length > 0, message: 'At least one role required' },
    },
    status: {
      type: String,
      enum: Object.values(UserStatus),
      required: true,
      default: UserStatus.ACTIVE,
    },
    statusReason: { type: String, default: null, maxlength: 500 },
    locale: { type: String, enum: LOCALES, required: true, default: 'uz-Latn' },
    email: { type: String, default: null, lowercase: true, trim: true },
    emailVerifiedAt: { type: Date, default: null },
    twoFactorEnabled: { type: Boolean, required: true, default: false },
    twoFactorSecret: { type: String, default: null, select: false },
    failedLoginCount: { type: Number, required: true, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    shopIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Shop' },
    deletedAt: { type: Date, default: null },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'users', strict: 'throw', minimize: false },
);

userSchema.index({ phone: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true, sparse: true });
// Partial indexes exclude soft-deleted documents so they stop consuming index memory
// and cannot leak into queries (DATABASE.md 1.2).
userSchema.index({ status: 1, roles: 1 }, { partialFilterExpression: { deletedAt: null } });
userSchema.index({ lastSeenAt: -1 }, { partialFilterExpression: { status: UserStatus.ACTIVE } });
userSchema.index({ deletedAt: 1 }, { sparse: true });

userSchema.pre('validate', function enforceStatusReason(next) {
  if (this.status !== UserStatus.ACTIVE && !this.statusReason) {
    next(new Error('statusReason is required when status is not ACTIVE'));
    return;
  }
  const isAdmin = this.roles.some(
    (role) => role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN,
  );
  if (isAdmin && !this.twoFactorEnabled && this.isModified('roles')) {
    // Admin accounts are the highest-value target on the platform (AUTH.md).
    next(new Error('Admin roles require two-factor authentication to be enabled'));
    return;
  }
  next();
});

export type UserDocument = HydratedDocument<UserDoc>;
export const UserModel: Model<UserDoc> = model<UserDoc>('User', userSchema);
