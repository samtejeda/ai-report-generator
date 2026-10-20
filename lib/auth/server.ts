import { after } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { getAuthDb } from "@/lib/db/auth-db";
import { createConsoleTransport, type Mail, type MailTransport } from "@/lib/email";
import { getAuthEnv } from "@/lib/env";
import { createAuth, type Auth } from "./auth";
import { resolveSession, type SessionContext } from "./session";

let instance: Auth | undefined;
let transport: MailTransport | undefined;

/** The one mail transport for this server process (console in development; see lib/email.ts). */
export function getMailTransport(): MailTransport {
  if (!transport) transport = createConsoleTransport({ production: getAuthEnv().NODE_ENV === "production" });
  return transport;
}

/**
 * Sends account mail after the response, and never fails the action it follows: a mail problem is
 * logged with no recipient and no text. For notices such as "your two-step sign-in was reset".
 */
export function sendMailInBackground(mail: Mail): void {
  const task = getMailTransport()
    .send(mail)
    .catch(() => console.error(JSON.stringify({ event: "mail_send_failed" })));
  try {
    after(task);
  } catch {
    // Outside a request scope: let it finish on its own.
    void task;
  }
}

/** The one Better Auth instance for this server process. */
export function getAuth(): Auth {
  if (!instance) {
    const env = getAuthEnv();
    const production = env.NODE_ENV === "production";
    instance = createAuth({
      authDb: getAuthDb(),
      audit: (actor, event) => audit(actor, event),
      mail: getMailTransport(),
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
 * For the MFA enrollment page only: a signed-in user who has not set up the authenticator app
 * yet. Returns null when signed out. Everything else uses requireSession, which refuses these.
 */
export async function getEnrollingSessionOrNull(): Promise<SessionContext | null> {
  return resolveSession(await headers(), { auth: getAuth(), authDb: getAuthDb(), allowUnenrolled: true });
}

/**
 * The caller's session, or a redirect to the sign-in page. For pages, layouts and server
 * actions. Every protected page, action and handler calls this (or getSessionOrNull) itself:
 * a layout check or the proxy is never the only gate.
 */
export async function requireSession(): Promise<SessionContext> {
  const session = await getSessionOrNull();
  if (session) return session;
  // Signed in with a password but no authenticator yet: send them to finish setup, not to /login.
  if (await getEnrollingSessionOrNull()) redirect("/account/mfa");
  redirect("/login");
}
