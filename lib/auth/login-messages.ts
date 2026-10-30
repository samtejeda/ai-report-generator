/**
 * Fixed sentences for the sign-in screens, moved out of the form so they can be tested. Never
 * echo what the server said, and never reveal whether an address has an account (a wrong password
 * and an unknown address look the same).
 */

import { TOO_MANY_ATTEMPTS, tooManyAttemptsMessage } from "./rate-limit-wait";

export type AuthError = { status?: number; code?: string } | null;

export { TOO_MANY_ATTEMPTS };
export const SIGN_OUT_FAILED = "Could not sign out. Try again.";

/** `waitSeconds` is the X-Retry-After of a 429 (lib/auth/rate-limit-wait.ts); null keeps the generic text. */
export function signInErrorMessage(error: AuthError, waitSeconds: number | null = null): string | null {
  if (!error) return null;
  if (error.status === 429) return tooManyAttemptsMessage(waitSeconds);
  if (error.code === "EMAIL_NOT_VERIFIED") return "Verify your email address first. We sent you a new link.";
  if (error.status === 401) return "Email or password is incorrect.";
  return "Could not sign in. Try again.";
}

/** True when the code step can no longer succeed and the person has to start again with the password. */
export function codeStepExpired(error: AuthError): boolean {
  return error?.code === "INVALID_TWO_FACTOR_COOKIE" || error?.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE";
}

export function codeErrorMessage(error: AuthError, waitSeconds: number | null = null): string | null {
  if (!error) return null;
  if (error.status === 429) return tooManyAttemptsMessage(waitSeconds);
  if (codeStepExpired(error)) return "That sign-in expired. Enter your password again.";
  return "That code is not right. Try again.";
}
