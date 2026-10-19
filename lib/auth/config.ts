/**
 * Every tunable authentication number lives in this one file. Sam wants the session times
 * adjustable later, so change them here and nowhere else.
 */

/** Idle timeout: a session ends after this long without a server request. */
export const SESSION_IDLE_SECONDS = 2 * 60 * 60;

/** Absolute cap: a session ends this long after sign-in no matter how active it is. */
export const SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60;

/**
 * How often an active session's idle deadline is pushed forward (a database write at most
 * this often per user). Idle precision is therefore this many seconds.
 */
export const SESSION_SLIDE_INTERVAL_SECONDS = 60;

/**
 * Better Auth applies this to its own "sensitive" endpoints (none of which we expose).
 * Change-password does not rely on it: it asks for the current password every time. Later
 * sensitive actions (owner MFA reset, changing the inference endpoint) must re-check
 * freshness themselves.
 */
export const FRESH_PASSWORD_SECONDS = 5 * 60;

/** How long the code step stays open after the password is accepted. */
export const TWO_FACTOR_CHALLENGE_SECONDS = 5 * 60;

/**
 * "Trust this device": a device the user ticks the box on skips the code step (never the
 * password) until it goes unused this long. Every sign-in from the device pushes the date
 * forward, so a device in daily use stays trusted: this is an idle window, not a hard cap.
 * Password change, password reset and an MFA reset revoke every trusted device of the user.
 */
export const TRUSTED_DEVICE_SECONDS = 14 * 24 * 60 * 60;

/** Consecutive wrong codes (across challenges) before the account's code step locks. */
export const MFA_LOCKOUT = { maxFailedAttempts: 5, durationSeconds: 15 * 60 } as const;

/** Authenticator app label. */
export const MFA_ISSUER = "AI Report Generator";

/** A reset link is valid for this long, and only once. */
export const RESET_TOKEN_SECONDS = 60 * 60;

/** An email verification link is valid for this long. */
export const VERIFY_EMAIL_SECONDS = 24 * 60 * 60;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Fixed-window limits per client address and path. After `max` requests in `window`
 * seconds the endpoint answers 429 until `window` seconds pass without a new request.
 */
export const RATE_LIMITS = {
  signIn: { window: 15 * 60, max: 5 },
  requestPasswordReset: { window: 15 * 60, max: 3 },
  resetPassword: { window: 15 * 60, max: 5 },
  sendVerificationEmail: { window: 15 * 60, max: 3 },
  verifyEmail: { window: 15 * 60, max: 10 },
  changePassword: { window: 15 * 60, max: 5 },
  verifyCode: { window: 15 * 60, max: 10 },
  mfaSetup: { window: 15 * 60, max: 5 },
} as const;

/**
 * Headers read, in order, for the client address that rate limits and audit events use.
 * Vercel sets x-forwarded-for itself and drops client-supplied values; that is the
 * documented behavior and is UNVERIFIED until the first deploy (see PROGRESS.md).
 */
export const CLIENT_IP_HEADERS = ["x-forwarded-for"] as const;

/** Cookie name prefix (Better Auth adds __Secure- on https). */
export const COOKIE_PREFIX = "rg";
