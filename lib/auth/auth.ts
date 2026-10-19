import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins/two-factor";
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { AuditActor, AuditEvent } from "@/lib/audit";
import type { AuthDb } from "@/lib/db/auth-db";
import { authAccounts, authRateLimits, authSessions, authTwoFactors, authVerifications, users } from "@/lib/db/schema";
import { mailTemplates, type MailTransport } from "@/lib/email";
import {
  CLIENT_IP_HEADERS,
  COOKIE_PREFIX,
  FRESH_PASSWORD_SECONDS,
  MFA_ISSUER,
  MFA_LOCKOUT,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RATE_LIMITS,
  RESET_TOKEN_SECONDS,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  TRUSTED_DEVICE_SECONDS,
  TWO_FACTOR_CHALLENGE_SECONDS,
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

type UserRow = { id: string; email: string; organizationId: string; deletedAt: Date | null; emailVerified: boolean; twoFactorEnabled: boolean };

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
      .select({ id: users.id, email: users.email, organizationId: users.organizationId, deletedAt: users.deletedAt, emailVerified: users.emailVerified, twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return rows[0];
  }

  async function findUserByEmail(email: string): Promise<UserRow | undefined> {
    const rows = await authDb
      .select({ id: users.id, email: users.email, organizationId: users.organizationId, deletedAt: users.deletedAt, emailVerified: users.emailVerified, twoFactorEnabled: users.twoFactorEnabled })
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

  /**
   * Trusted-device records are rows in auth_verifications whose value is the user id (the
   * identifier is hashed, so the value is the handle). Deleting by value revokes every trusted
   * device of the user, and also any other pending link or challenge for them, which is wanted
   * after a password change or reset.
   */
  async function revokeTrustedDevices(userId: string) {
    await authDb.delete(authVerifications).where(eq(authVerifications.value, userId));
  }

  const MFA_VERIFY_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

  /**
   * Audit for the MFA flow. A local plugin, not `hooks.after`, because plugin hooks run in plugin
   * order and this must run AFTER the two-factor plugin has decided whether a code step is still
   * pending (it deletes the just-created session in that case). Ids and fixed words only.
   */
  const mfaAudit: BetterAuthPlugin = {
    id: "mfa-audit",
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === "/sign-in/email" || MFA_VERIFY_PATHS.has(ctx.path ?? "") || ctx.path === "/two-factor/enable" || ctx.path === "/two-factor/generate-backup-codes",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            const failed = isAPIError(returned);
            const method = ctx.path === "/two-factor/verify-backup-code" ? "backup_code" : "totp";

            if (ctx.path === "/sign-in/email") {
              if (failed) return; // handled by the credential-failure hook
              if ((returned as { twoFactorRedirect?: boolean } | undefined)?.twoFactorRedirect) {
                const body = ctx.body as { email?: unknown } | undefined;
                const row = typeof body?.email === "string" ? await findUserByEmail(body.email) : undefined;
                if (row) await record(row, { action: "auth.mfa_challenge" }, ctx.headers);
                return;
              }
              // No code step: a trusted device. (Users without MFA are logged by the session hook.)
              const created = ctx.context.newSession;
              const row = created ? await findUserById(created.user.id) : undefined;
              if (row?.twoFactorEnabled) await record(row, { action: "auth.login", metadata: { method: "password+trusted_device" } }, ctx.headers, created?.session.ipAddress);
              return;
            }

            const challengeCookie = ctx.context.createAuthCookie("two_factor").name;
            const challengeId = await ctx.getSignedCookie(challengeCookie, ctx.context.secret);
            const signIn = Boolean(challengeId);

            if (MFA_VERIFY_PATHS.has(ctx.path)) {
              if (failed) {
                let userId: string | undefined;
                if (challengeId) userId = (await ctx.context.internalAdapter.findVerificationValue(challengeId))?.value;
                else userId = (await getSessionFromCtx(ctx))?.user.id;
                const row = userId ? await findUserById(userId) : undefined;
                const code = (returned as { body?: { code?: string } }).body?.code;
                const reason = code === "ACCOUNT_TEMPORARILY_LOCKED" ? "locked" : code === "INVALID_CODE" || code === "INVALID_BACKUP_CODE" ? "invalid_code" : "rejected";
                if (row) await record(row, { action: "auth.mfa_failed", outcome: "failure", metadata: { method, reason } }, ctx.headers);
                else logEvent("auth.mfa_failed_unknown_user", { ip: clientIp(ctx.headers), method });
                return;
              }
              const userId = (returned as { user?: { id?: string } } | undefined)?.user?.id ?? ctx.context.newSession?.user.id;
              const row = userId ? await findUserById(userId) : undefined;
              if (!row) return;
              if (signIn) {
                await record(row, { action: "auth.login", metadata: { method: `password+${method}` } }, ctx.headers, ctx.context.newSession?.session.ipAddress);
                if (method === "backup_code") await record(row, { action: "auth.mfa_backup_code_used" }, ctx.headers);
                if ((ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice === true) await record(row, { action: "auth.mfa_device_trusted" }, ctx.headers);
              } else if (ctx.context.newSession) {
                // First valid code while signed in: the plugin re-issues the session when it flips the flag.
                await record(row, { action: "auth.mfa_enrolled" }, ctx.headers);
                await sendMail(mailTemplates.mfaEnabled(row.email));
              }
              return;
            }

            if (failed) return;
            const session = await getSessionFromCtx(ctx);
            const row = session ? await findUserById(session.user.id) : undefined;
            if (!row) return;
            await record(row, { action: ctx.path === "/two-factor/enable" ? "auth.mfa_enrollment_started" : "auth.mfa_backup_codes_regenerated" }, ctx.headers);
          }),
        },
      ],
    },
  };

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
        twoFactor: authTwoFactors,
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
        await revokeTrustedDevices(row.id);
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

    // Authenticator (TOTP) second factor. Email/SMS codes are off (no sendOTP): the only second
    // factors are the authenticator app and one-time backup codes. The secret and backup codes are
    // stored encrypted. Not exposed over HTTP: disable, get-totp-uri, send-otp, verify-otp (see
    // lib/auth/route-policy.ts); there is no self-service "turn MFA off".
    plugins: [
      twoFactor({
        issuer: MFA_ISSUER,
        twoFactorCookieMaxAge: TWO_FACTOR_CHALLENGE_SECONDS,
        trustDeviceMaxAge: TRUSTED_DEVICE_SECONDS,
        accountLockout: { enabled: true, ...MFA_LOCKOUT },
      }),
      mfaAudit,
    ],

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
        "/two-factor/verify-totp": RATE_LIMITS.verifyCode,
        "/two-factor/verify-backup-code": RATE_LIMITS.verifyCode,
        "/two-factor/enable": RATE_LIMITS.mfaSetup,
        "/two-factor/generate-backup-codes": RATE_LIMITS.mfaSetup,
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
            // With MFA on, a session row exists briefly before the code step (and again after it);
            // "login" is recorded by the MFA audit plugin once the sign-in is really complete.
            if (row && !row.twoFactorEnabled) await record(row, { action: "auth.login", metadata: { method: "password" } }, null, session.ipAddress);
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
            await revokeTrustedDevices(row.id);
            await record(row, { action: "auth.password_changed" }, ctx.headers);
            await sendMail(mailTemplates.passwordChanged(row.email));
          }
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
