import { z } from "zod";

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL");

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
  // The console transport prints links to the server log and refuses to run in production.
  // A real transport (Resend) is a later, separately approved change.
  EMAIL_TRANSPORT: z.enum(["console"]).default("console"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
