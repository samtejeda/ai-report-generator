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

/**
 * Validates the environment. Error text names the variable and the rule that
 * failed, never the value, so secrets cannot leak into logs.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.code === "invalid_type" ? "missing or wrong type" : i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration. ${problems}`);
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
