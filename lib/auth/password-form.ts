import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./config";
import { tooManyAttemptsMessage } from "./rate-limit-wait";

/**
 * The checks the change-password form makes before it calls the server, so a typo costs no request
 * and no rate-limit attempt. The server enforces all of this again (length in Better Auth's config,
 * the current password by comparing the stored hash); nothing here is a gate.
 *
 * Returns a fixed message, or null when the form may be submitted.
 */
export function validatePasswordChange(current: string, next: string, confirm: string): string | null {
  if (current.length === 0) return "Enter your current password.";
  if (next.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters for the new password.`;
  if (next.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters for the new password.`;
  if (next !== confirm) return "The two new passwords do not match.";
  if (next === current) return "Choose a password different from the current one.";
  return null;
}

/** Fixed messages for what the server can answer; never the server's own text. */
export function changePasswordErrorMessage(error: { status?: number; code?: string } | null, waitSeconds: number | null = null): string | null {
  if (!error) return null;
  if (error.status === 429) return tooManyAttemptsMessage(waitSeconds);
  if (error.status === 401) return "Your session ended. Sign in again.";
  if (error.code === "INVALID_PASSWORD") return "Your current password is not correct.";
  if (error.code === "PASSWORD_TOO_SHORT") return `Use at least ${PASSWORD_MIN_LENGTH} characters for the new password.`;
  if (error.code === "PASSWORD_TOO_LONG") return `Use at most ${PASSWORD_MAX_LENGTH} characters for the new password.`;
  return "The password could not be changed. Try again.";
}
