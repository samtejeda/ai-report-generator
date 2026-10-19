import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { getAuthEnv } from "@/lib/env";
import * as schema from "./schema";

// The auth_runtime client: credentials, sessions, reset tokens, rate-limit counters and the
// identity columns of `users`. It has no privilege on clients, reports or audit_log
// (migration 0006). Only lib/auth may import this file (lint-enforced), and Better Auth is its
// only caller; feature code gets identity from requireSession() and data from tenantDb().
let pool: Pool | undefined;

function getAuthPool(): Pool {
  pool ??= new Pool({ connectionString: getAuthEnv().AUTH_DATABASE_URL });
  return pool;
}

export function getAuthDb() {
  return drizzle(getAuthPool(), { schema });
}

export type AuthDb = ReturnType<typeof getAuthDb>;
