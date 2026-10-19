import { isAllowedAuthRequest } from "@/lib/auth/route-policy";
import { getAuth } from "@/lib/auth/server";

// Better Auth's HTTP surface, narrowed to the allow-list in lib/auth/route-policy.ts.
// Public by design: these endpoints establish identity, so they cannot require one. Each is
// rate limited by Better Auth (database-backed) and checked for origin (CSRF) before it runs.
async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
  if (!isAllowedAuthRequest(request.method, path)) {
    return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  }
  return getAuth().handler(request);
}

export const GET = handle;
export const POST = handle;
