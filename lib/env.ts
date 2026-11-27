import { z } from "zod";

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL");

// How many proxies of ours append to x-forwarded-for (an AWS Application Load Balancer is 1; a CDN in front
// of it makes 2). 0, also the default when unset, means the header is not trusted at all: rate limits then
// share one bucket and audit rows carry no address. See lib/auth/client-ip.ts.
const trustedProxyHops = z.coerce.number().int().min(0).max(3).default(0);

// The app's runtime variables, and nothing else. DATABASE_URL_UNPOOLED (owner
// credential, DDL-capable) is deliberately NOT here: only drizzle.config.ts reads
// it, so a deployed environment never needs to hold it (checklist 15 item 5).
const schema = z.object({
  // Pooled Neon connection string, via the app_runtime login role: the only
  // database URL app code may use.
  DATABASE_URL: postgresUrl,
  INFERENCE_MODE: z.enum(["stub", "real"]).default("stub"),
  OLLAMA_BASE_URL: z.url().default("http://localhost:11434/v1"),
});

export type Env = z.infer<typeof schema>;

// Authentication variables are a separate schema so a missing one fails where auth is used
// (sign-in, sessions) and cannot take down routes that never touch auth (/api/health).
const authSchema = z.object({
  // Pooled Neon connection string via the auth_runtime login role (migration 0006). Used by
  // Better Auth only; it cannot read clients or reports and is not the app_runtime URL.
  AUTH_DATABASE_URL: postgresUrl,
  // Signs and verifies session cookies. 32+ random characters (`openssl rand -base64 32`).
  BETTER_AUTH_SECRET: z.string().min(32),
  // Public origin of the app, used in emailed links and for the origin check.
  BETTER_AUTH_URL: z.url(),
  // "console" prints links to the server log and is refused in production. "disabled" sends
  // nothing and logs one fixed line (`mail_not_sent`); it is allowed in production for demo
  // deploys with synthetic data ONLY and must be replaced by a real transport (Resend, a later,
  // separately approved change) before Phase C. The default stays "console".
  EMAIL_TRANSPORT: z.enum(["console", "disabled"]).default("console"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  TRUSTED_PROXY_HOPS: trustedProxyHops,
});

export type AuthEnv = z.infer<typeof authSchema>;

function parse<T extends z.ZodType>(zodSchema: T, source: Record<string, string | undefined>): z.infer<T> {
  const result = zodSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.code === "invalid_type" ? "missing or wrong type" : i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration. ${problems}`);
  }
  return result.data;
}

/**
 * Validates the environment. Error text names the variable and the rule that
 * failed, never the value, so secrets cannot leak into logs.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  return parse(schema, source);
}

export function parseAuthEnv(source: Record<string, string | undefined>): AuthEnv {
  const env = parse(authSchema, source);
  if (env.NODE_ENV === "production" && env.EMAIL_TRANSPORT === "console") {
    throw new Error("Invalid environment configuration. EMAIL_TRANSPORT: the console transport is not allowed in production");
  }
  return env;
}

let cached: Env | undefined;
let cachedAuth: AuthEnv | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

export function getAuthEnv(): AuthEnv {
  cachedAuth ??= parseAuthEnv(process.env);
  return cachedAuth;
}

/**
 * Just the trusted proxy hop count, read on every call (a bare integer, so cheap) and independent of the
 * rest of the auth variables: the client address is needed by code that must not fail because an unrelated
 * variable is missing. A bad value throws, naming the variable and never the value.
 */
export function getTrustedProxyHops(): number {
  const result = trustedProxyHops.safeParse(process.env.TRUSTED_PROXY_HOPS);
  if (!result.success) throw new Error("Invalid environment configuration. TRUSTED_PROXY_HOPS: must be a whole number from 0 to 3");
  return result.data;
}
