import { jsonOk } from "@/lib/api/respond";
import { guardedRoute } from "@/lib/auth/guard";

// The signed-in caller's own identity as the server sees it right now (role is read from the
// database on every request). Every role may call it; it returns nothing about any client or
// other user, and never the organization id.
export const GET = guardedRoute({
  roles: ["owner", "associate", "admin"],
  resource: "user",
  handler: async ({ session }) => jsonOk({ id: session.userId, role: session.role }),
});
