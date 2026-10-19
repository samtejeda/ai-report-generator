import { after } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { getAuthDb } from "@/lib/db/auth-db";
import { createConsoleTransport } from "@/lib/email";
import { getAuthEnv } from "@/lib/env";
import { createAuth, type Auth } from "./auth";
import { resolveSession, type SessionContext } from "./session";

let instance: Auth | undefined;

/** The one Better Auth instance for this server process. */
export function getAuth(): Auth {
  if (!instance) {
    const env = getAuthEnv();
    const production = env.NODE_ENV === "production";
    instance = createAuth({
      authDb: getAuthDb(),
      audit: (actor, event) => audit(actor, event),
      mail: createConsoleTransport({ production }),
      baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET,
      production,
      runInBackground: (task) => {
        try {
          after(task);
        } catch {
          // Outside a request scope (scripts): let it finish on its own.
          void task.catch(() => {});
        }
      },
    });
  }
  return instance;
}

/** The caller's session, or null. For route handlers, which answer 401 themselves. */
export async function getSessionOrNull(): Promise<SessionContext | null> {
  return resolveSession(await headers(), { auth: getAuth(), authDb: getAuthDb() });
}

/**
 * The caller's session, or a redirect to the sign-in page. For pages, layouts and server
 * actions. Every protected page, action and handler calls this (or getSessionOrNull) itself:
 * a layout check or the proxy is never the only gate.
 */
export async function requireSession(): Promise<SessionContext> {
  const session = await getSessionOrNull();
  if (!session) redirect("/login");
  return session;
}
