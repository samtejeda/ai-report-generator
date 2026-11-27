import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { getEnv } from "@/lib/env";
import { attachPoolErrorHandler } from "./pool-errors";
import * as schema from "./schema";

// WebSocket pool on the POOLED connection string: supports the interactive
// transactions that report versioning and audit writes need. The unpooled string
// is for drizzle-kit only and is never imported here.
let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getEnv().DATABASE_URL });
    attachPoolErrorHandler(pool, "app"); // an unhandled idle-client error would crash a long-lived container
  }
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}
