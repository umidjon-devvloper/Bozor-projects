import { z } from 'zod';
import { ObjectIdSchema } from '../common/primitives.js';

export const NotificationCategorySchema = z.enum([
  'ORDER',
  'WALLET',
  'MODERATION',
  'ACCOUNT',
  'MARKETING',
]);
export const ChannelSchema = z.enum(['PUSH', 'SMS', 'IN_APP']);

/**
 * Preferences carry every category, and the server refuses to switch off the transactional
 * ones. Filtering them out of the schema would hide the rule from anyone reading the API.
 */
export const UpdatePreferencesRequestSchema = z
  .object({
    channels: z
      .array(
        z
          .object({
            category: NotificationCategorySchema,
            channel: ChannelSchema,
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(30),
    timezone: z.string().min(3).max(64).optional(),
  })
  .strict();

export const TestNotificationRequestSchema = z
  .object({
    userId: ObjectIdSchema,
    type: z.string().min(3).max(64),
    variables: z.record(z.string()).default({}),
    channels: z.array(ChannelSchema).min(1).max(3).optional(),
  })
  .strict();

export const NotificationResponseSchema = z.object({
  id: ObjectIdSchema,
  category: NotificationCategorySchema,
  type: z.string(),
  title: z.string(),
  body: z.string(),
  target: z.object({ type: z.string(), id: z.string() }).nullable(),
  read: z.boolean(),
  createdAt: z.string().datetime(),
});
