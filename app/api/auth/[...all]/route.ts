import { limitResetLink } from "@/lib/auth/reset-link-guard";
import { isAllowedAuthRequest } from "@/lib/auth/route-policy";
import { getAuth } from "@/lib/auth/server";

// Better Auth's HTTP surface, narrowed to the allow-list in lib/auth/route-policy.ts.
// Public by design: these endpoints establish identity, so they cannot require one. Each is
// rate limited by Better Auth (database-backed; the emailed reset link additionally by address, below)
// and checked for origin (CSRF) before it runs.
async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
  if (!isAllowedAuthRequest(request.method, path)) {
    return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  }
  // The emailed reset link carries its token in the path, which Better Auth's per-path limiter would count
  // once per token; count it per address here, before Better Auth sees it (lib/auth/reset-link-limit.ts).
  const refused = await limitResetLink(request, path);
  if (refused) return refused;
  return getAuth().handler(request);
}

export const GET = handle;
export const POST = handle;
