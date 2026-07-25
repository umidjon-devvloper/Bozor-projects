import { readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const csv = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_BASE_URL: z.string().url(),
  WEB_BASE_URL: z.string().url(),
  ADMIN_BASE_URL: z.string().url(),
  CORS_ORIGINS: z.string().transform(csv),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  MONGODB_URI: z
    .string()
    .min(1)
    .refine((uri) => uri.includes('replicaSet=') || uri.includes('mongodb+srv://'), {
      // ADR-0001: transactions require a replica set. Failing at boot is far better than
      // discovering it when the first commission charge cannot be committed.
      message: 'MONGODB_URI must point at a replica set (replicaSet= or mongodb+srv://)',
    }),
  MONGODB_DB_NAME: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_PRIVATE_KEY_PATH: z.string().min(1),
  JWT_PUBLIC_KEY_PATH: z.string().min(1),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
  PII_ENCRYPTION_KEY: z.string().min(32),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(3),
  S3_SECRET_KEY: z.string().min(8),
  // MinIO addresses buckets by path, not by virtual host, so this is true in every
  // environment that is not AWS S3 proper.
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  S3_BUCKET_PUBLIC: z.string().min(1),
  S3_BUCKET_PRIVATE: z.string().min(1),
  S3_BUCKET_TEMP: z.string().min(1),
  CDN_BASE_URL: z.string().url(),

  // ---- Search ----
  TYPESENSE_URL: z.string().url(),
  TYPESENSE_API_KEY: z.string().min(8),

  // ---- Push notifications ----
  // Each provider is optional: a deployment without iOS credentials simply has no APNs
  // provider, rather than failing to boot or pretending to send.
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  FCM_PRIVATE_KEY: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_PRIVATE_KEY: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  APNS_PRODUCTION: z.coerce.boolean().default(false),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  APP_DEEP_LINK_BASE: z.string().default('bozorlar://'),

  CLAMAV_HOST: z.string().min(1).default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  MEDIA_SCAN_ENABLED: z.coerce.boolean().default(true),

  SMS_PROVIDER: z.enum(['console', 'eskiz', 'playmobile']).default('console'),
  ESKIZ_EMAIL: z.string().optional(),
  ESKIZ_PASSWORD: z.string().optional(),

  // Payment providers. Optional until the merchant contracts are signed (B5): the API must
  // boot without them, and the callback endpoints reject everything while they are unset —
  // an empty secret can never match a signature.
  PAYME_MERCHANT_ID: z.string().optional(),
  PAYME_KEY: z.string().optional(),
  CLICK_MERCHANT_ID: z.string().optional(),
  CLICK_SERVICE_ID: z.string().optional(),
  CLICK_MERCHANT_USER_ID: z.string().optional(),
  CLICK_SECRET_KEY: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default('bozorlar-api'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Deliberately not a thrown AppError: nothing downstream can recover from an invalid
    // configuration, and a service that boots half-configured fails at the worst moment.
    process.stderr.write(`\nInvalid environment configuration:\n${issues}\n\n`);
    process.exit(1);
  }
  // ADR-0030: scanning may only be disabled for local development. A production process
  // that boots with scanning off would accept unscanned passport scans into the private
  // bucket, which is the one failure in this module that cannot be undone afterwards.
  if (!parsed.data.MEDIA_SCAN_ENABLED && parsed.data.NODE_ENV === 'production') {
    process.stderr.write('\nMEDIA_SCAN_ENABLED cannot be false in production (ADR-0030)\n\n');
    process.exit(1);
  }
  if (parsed.data.SMS_PROVIDER === 'eskiz' && !parsed.data.ESKIZ_EMAIL) {
    process.stderr.write('\nSMS_PROVIDER=eskiz requires ESKIZ_EMAIL and ESKIZ_PASSWORD\n\n');
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

let cachedKeys: { privateKey: string; publicKey: string } | null = null;

/** JWT keys are read once and cached; a missing key file must stop the process at boot. */
export function getJwtKeys(): { privateKey: string; publicKey: string } {
  if (cachedKeys) return cachedKeys;
  try {
    cachedKeys = {
      privateKey: readFileSync(env.JWT_PRIVATE_KEY_PATH, 'utf8'),
      publicKey: readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf8'),
    };
    return cachedKeys;
  } catch (cause) {
    process.stderr.write(
      `\nFailed to read JWT keys. Generate them with:\n` +
        `  mkdir -p keys && openssl genpkey -algorithm RSA -out keys/jwt-private.pem -pkeyopt rsa_keygen_bits:2048\n` +
        `  openssl rsa -pubout -in keys/jwt-private.pem -out keys/jwt-public.pem\n\n${String(cause)}\n`,
    );
    process.exit(1);
  }
}
