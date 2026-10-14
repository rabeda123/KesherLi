import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  // Used to HMAC one-time codes. Must be long and random; never commit it.
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  CORS_ORIGINS: z.string().default('http://localhost:8081'),
  // Base URL used to build invitation links that are shared with contacts.
  PUBLIC_APP_URL: z.string().url().default('http://localhost:8081'),
  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  PUSH_PROVIDER: z.enum(['none', 'expo']).default('none'),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  // Development only: return one-time codes in API responses so the app can
  // be tried without an SMS provider. Refused in production.
  DEV_EXPOSE_OTP: bool,
  // WebRTC connectivity. STUN lets most devices connect directly; TURN relays
  // media when networks block direct connections (some cellular and school networks).
  STUN_URLS: z.string().default('stun:stun.l.google.com:19302'),
  TURN_URLS: z.string().optional(),
  // Either a shared secret (coturn "use-auth-secret", short-lived credentials)…
  TURN_SECRET: z.string().optional(),
  // …or a fixed username/credential from a hosted TURN provider.
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  GLOBAL_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(600),
  TRUST_PROXY: bool,
});

export type Config = {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  appSecret: string;
  corsOrigins: string[];
  publicAppUrl: string;
  sms:
    | { provider: 'console' }
    | { provider: 'twilio'; accountSid: string; authToken: string; from: string };
  push: { provider: 'none' } | { provider: 'expo'; accessToken?: string };
  devExposeOtp: boolean;
  globalRateLimitPerMin: number;
  trustProxy: boolean;
  webrtc: {
    stunUrls: string[];
    turn: { urls: string[]; secret?: string; username?: string; credential?: string } | null;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;

  let sms: Config['sms'];
  if (e.SMS_PROVIDER === 'twilio') {
    if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN || !e.TWILIO_FROM) {
      throw new Error('SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM');
    }
    sms = { provider: 'twilio', accountSid: e.TWILIO_ACCOUNT_SID, authToken: e.TWILIO_AUTH_TOKEN, from: e.TWILIO_FROM };
  } else {
    sms = { provider: 'console' };
  }

  if (e.TURN_URLS && !e.TURN_SECRET && !(e.TURN_USERNAME && e.TURN_CREDENTIAL)) {
    throw new Error('TURN_URLS requires TURN_SECRET, or TURN_USERNAME and TURN_CREDENTIAL');
  }

  if (e.NODE_ENV === 'production') {
    if (sms.provider === 'console') {
      throw new Error('SMS_PROVIDER=console is not allowed in production: configure a real SMS provider');
    }
    if (e.DEV_EXPOSE_OTP) throw new Error('DEV_EXPOSE_OTP is not allowed in production');
  }

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    appSecret: e.APP_SECRET,
    corsOrigins: splitList(e.CORS_ORIGINS),
    publicAppUrl: e.PUBLIC_APP_URL.replace(/\/$/, ''),
    sms,
    push: e.PUSH_PROVIDER === 'expo' ? { provider: 'expo', accessToken: e.EXPO_ACCESS_TOKEN } : { provider: 'none' },
    devExposeOtp: e.DEV_EXPOSE_OTP,
    globalRateLimitPerMin: e.GLOBAL_RATE_LIMIT_PER_MIN,
    trustProxy: e.TRUST_PROXY,
    webrtc: {
      stunUrls: splitList(e.STUN_URLS),
      turn: e.TURN_URLS
        ? { urls: splitList(e.TURN_URLS), secret: e.TURN_SECRET, username: e.TURN_USERNAME, credential: e.TURN_CREDENTIAL }
        : null,
    },
  };
}

function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
