import { connection } from "next/server";

// Process liveness for the load balancer's health check. It touches NO database, no environment
// and no tenant data, so a check every few seconds cannot keep Neon awake (/api/health runs
// `select 1` and is for manual checks only). The body is fixed. No app-level rate limit on
// purpose: the balancer probes from several addresses, so a per-address 429 could mark healthy
// targets unhealthy, and the route does no I/O (abuse protection belongs at the AWS edge).
export async function GET() {
  await connection(); // opt out of prerendering: a wedged process must not answer from a built file
  return Response.json({ status: "ok" });
}
