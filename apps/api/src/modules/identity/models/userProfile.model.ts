import { Schema, model, type Model, type Types } from 'mongoose';

/**
 * Split from `users` deliberately: the auth document is read on every authenticated request,
 * and a 4KB profile riding along on every lookup is wasted cache (DATABASE.md 2.1).
 */
export interface UserProfileDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  firstName: string;
  lastName: string | null;
  avatarKey: string | null;
  birthDate: Date | null;
  defaultRegionId: Types.ObjectId | null;
  defaultDistrictId: Types.ObjectId | null;
  preferredMarketIds: Types.ObjectId[];
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const userProfileSchema = new Schema<UserProfileDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    firstName: { type: String, required: true, trim: true, minlength: 1, maxlength: 50 },
    lastName: { type: String, default: null, trim: true, maxlength: 50 },
    avatarKey: { type: String, default: null },
    birthDate: { type: Date, default: null },
    defaultRegionId: { type: Schema.Types.ObjectId, default: null },
    defaultDistrictId: { type: Schema.Types.ObjectId, default: null },
    preferredMarketIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 10, message: 'Max 10 markets' },
    },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'user_profiles', strict: 'throw' },
);

userProfileSchema.index({ userId: 1 }, { unique: true });
userProfileSchema.index({ defaultDistrictId: 1 }, { sparse: true });

export const UserProfileModel: Model<UserProfileDoc> = model<UserProfileDoc>(
  'UserProfile',
  userProfileSchema,
);
