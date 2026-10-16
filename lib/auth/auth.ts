import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { AuditActor, AuditEvent } from "@/lib/audit";
import type { AuthDb } from "@/lib/db/auth-db";
import { authAccounts, authRateLimits, authSessions, authVerifications, users } from "@/lib/db/schema";
import { mailTemplates, type MailTransport } from "@/lib/email";
import {
  CLIENT_IP_HEADERS,
  COOKIE_PREFIX,
  FRESH_PASSWORD_SECONDS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RATE_LIMITS,
  RESET_TOKEN_SECONDS,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  VERIFY_EMAIL_SECONDS,
} from "./config";

/**
 * Self-hosted Better Auth (audit 03 item 1): password hashing (scrypt), sessions, email
 * verification, password reset, rate limiting. Everything it stores goes through the
 * auth_runtime database role, which cannot read clients or reports.
 *
 * Decisions encoded here:
 * - No self-sign-up. Accounts are created by an owner/admin action (later PRs) or the
 *   bootstrap script. `disableSignUp` removes the endpoint's effect entirely.
 * - Email must be verified before a session is issued.
 * - A session row's `expires_at` is the IDLE deadline (2 h, slid forward by requireSession);
 *   `expiresIn` is the ABSOLUTE cap (12 h, which also sets the cookie lifetime) and
 *   requireSession enforces it from created_at. Better Auth's own refresh is disabled because
 *   it cannot write cookies from a Server Component.
 * - Role, organization and deactivation are read from the database on every request (no
 *   cookie cache), so a role change or deactivation applies at once.
 * - Reset tokens are stored hashed, valid 60 min, consumed atomically on use, and a reset
 *   revokes every session of the user.
 */

export type AuthDeps = {
  authDb: AuthDb;
  /** Writes one audit event (lib/audit.ts). Injected so tests can aim it at a test database. */
  audit: (actor: AuditActor, event: AuditEvent) => Promise<boolean>;
  mail: MailTransport;
  baseURL: string;
  secret: string;
  production: boolean;
  /**
   * Runs email sending after the response (Next's `after`) so response time does not reveal
   * whether an address has an account. When absent, sending is awaited (tests).
   */
  runInBackground?: (task: Promise<unknown>) => void;
  now?: () => Date;
};

type UserRow = { id: string; email: string; organizationId: string; deletedAt: Date | null; emailVerified: boolean };

export function clientIp(headers: Headers | undefined | null): string | undefined {
  for (const name of CLIENT_IP_HEADERS) {
    const first = headers?.get(name)?.split(",")[0]?.trim();
    if (first && /^[0-9a-fA-F:.]{3,45}$/.test(first)) return first;
  }
  return undefined;
}

/** Operational log line. Never includes an email address, token, or request body. */
function logEvent(event: string, fields: Record<string, string | number | boolean | undefined> = {}) {
  console.warn(JSON.stringify({ event, ...fields }));
}

export function createAuth(deps: AuthDeps) {
  const { authDb } = deps;
  const now = deps.now ?? (() => new Date());

  async function findUserById(id: string): Promise<UserRow | undefined> {
    const rows = await authDb
      .select({ id: users.id, email: users.email, organizationId: users.organizationId, deletedAt: users.deletedAt, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return rows[0];
  }

  async function findUserByEmail(email: string): Promise<UserRow | undefined> {
    const rows = await authDb
      .select({ id: users.id, email: users.email, organizationId: users.organizationId, deletedAt: users.deletedAt, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return rows[0];
  }

  async function record(
    user: Pick<UserRow, "id" | "organizationId">,
    event: Omit<AuditEvent, "resourceType" | "resourceId">,
    headers?: Headers | null,
    knownIp?: string | null,
  ) {
    const ip = knownIp ?? clientIp(headers);
    await deps.audit(
      { organizationId: user.organizationId, actorUserId: user.id, requestId: headers?.get("x-request-id") ?? null },
      { ...event, resourceType: "users", resourceId: user.id, metadata: { ...(ip ? { ip } : {}), ...event.metadata } },
    );
  }

  async function sendMail(mail: ReturnType<(typeof mailTemplates)["passwordChanged"]>) {
    try {
      await deps.mail.send(mail);
    } catch {
      // No recipient, link or error text in the log.
      logEvent("mail_send_failed");
    }
  }

  return betterAuth({
    appName: "AI Report Generator",
    baseURL: deps.baseURL,
    secret: deps.secret,
    trustedOrigins: [deps.baseURL],
    telemetry: { enabled: false },

    database: drizzleAdapter(authDb, {
      provider: "pg",
      // Better Auth model name -> our table. `user` is our own `users` table.
      schema: {
        user: users,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        rateLimit: authRateLimits,
      },
      // Reset consumes the token, revokes sessions and writes the password in one transaction.
      transaction: true,
    }),

    user: {
      fields: { name: "displayName" },
      additionalFields: {
        role: { type: "string", required: true, input: false },
        organizationId: { type: "string", required: true, input: false },
        deletedAt: { type: "date", required: false, input: false },
      },
    },

    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      resetPasswordTokenExpiresIn: RESET_TOKEN_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }, request) => {
        const row = await findUserById(user.id);
        if (!row) return;
        if (row.deletedAt) {
          await record(row, { action: "auth.password_reset_requested", outcome: "denied", metadata: { reason: "deactivated" } }, request?.headers);
          return;
        }
        await record(row, { action: "auth.password_reset_requested" }, request?.headers);
        await sendMail(mailTemplates.resetPassword(row.email, url, RESET_TOKEN_SECONDS / 60));
      },
      onPasswordReset: async ({ user }, request) => {
        const row = await findUserById(user.id);
        if (!row) return;
        await record(row, { action: "auth.password_reset_completed" }, request?.headers);
        await sendMail(mailTemplates.passwordChanged(row.email));
      },
    },

    emailVerification: {
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: VERIFY_EMAIL_SECONDS,
      sendVerificationEmail: async ({ user, url }) => {
        const row = await findUserById(user.id);
        if (!row || row.deletedAt) return;
        await sendMail(mailTemplates.verifyEmail(row.email, url, VERIFY_EMAIL_SECONDS / 3600));
      },
      afterEmailVerification: async (user, request) => {
        const row = await findUserById(user.id);
        if (row) await record(row, { action: "auth.email_verified" }, request?.headers);
      },
    },

    verification: { storeIdentifier: "hashed" },

    session: {
      // ABSOLUTE cap; also the cookie lifetime. The idle deadline is set in the create hook below.
      expiresIn: SESSION_ABSOLUTE_SECONDS,
      freshAge: FRESH_PASSWORD_SECONDS,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },

    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": RATE_LIMITS.signIn,
        "/request-password-reset": RATE_LIMITS.requestPasswordReset,
        "/reset-password": RATE_LIMITS.resetPassword,
        "/reset-password/*": RATE_LIMITS.resetPassword,
        "/send-verification-email": RATE_LIMITS.sendVerificationEmail,
        "/verify-email": RATE_LIMITS.verifyEmail,
        "/change-password": RATE_LIMITS.changePassword,
      },
    },

    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: deps.production,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: deps.production },
      ipAddress: { ipAddressHeaders: [...CLIENT_IP_HEADERS] },
      database: { generateId: "uuid" },
      // Explicit, because Better Auth silently disables both checks when NODE_ENV=test. Off here
      // would mean the cross-site and open-redirect protections are never exercised by tests.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ...(deps.runInBackground ? { backgroundTasks: { handler: deps.runInBackground } } : {}),
    },

    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const row = await findUserById(session.userId);
            if (!row || row.deletedAt) {
              if (row) await record(row, { action: "auth.login_failed", outcome: "failure", metadata: { reason: "deactivated" } }, null, session.ipAddress);
              return false;
            }
            return { data: { ...session, expiresAt: new Date(now().getTime() + SESSION_IDLE_SECONDS * 1000) } };
          },
          after: async (session) => {
            const row = await findUserById(session.userId);
            if (row) await record(row, { action: "auth.login", metadata: { method: "password" } }, null, session.ipAddress);
          },
        },
      },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-out") return;
        // The session is gone after sign-out, so record who is leaving before it runs.
        const current = await getSessionFromCtx(ctx);
        const row = current ? await findUserById(current.user.id) : undefined;
        if (row) await record(row, { action: "auth.logout" }, ctx.headers);
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        const failed = isAPIError(returned);

        if (ctx.path === "/sign-in/email" && failed) {
          const body = ctx.body as { email?: unknown } | undefined;
          const code = (returned as { body?: { code?: string } }).body?.code;
          // Already audited by the session hook (deactivated user).
          if (code === "FAILED_TO_CREATE_SESSION") return;
          const row = typeof body?.email === "string" ? await findUserByEmail(body.email) : undefined;
          if (row) {
            await record(row, { action: "auth.login_failed", outcome: "failure", metadata: { reason: code === "EMAIL_NOT_VERIFIED" ? "email_not_verified" : "bad_credentials" } }, ctx.headers);
          } else {
            // Unknown address: application log only, and never the address itself (no tenant to
            // attribute it to, and it would let anyone write arbitrary text into our logs).
            logEvent("auth.login_failed_unknown_user", { ip: clientIp(ctx.headers) });
          }
          return;
        }

        if (ctx.path === "/change-password" && !failed) {
          const userId = (returned as { user?: { id?: string } } | undefined)?.user?.id;
          const row = userId ? await findUserById(userId) : undefined;
          if (row) {
            await record(row, { action: "auth.password_changed" }, ctx.headers);
            await sendMail(mailTemplates.passwordChanged(row.email));
          }
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
