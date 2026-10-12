import { connection } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

// Liveness plus database reachability. Returns no versions, hosts, or error text.
export async function GET() {
  await connection(); // opt out of prerendering: this must run per request
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
