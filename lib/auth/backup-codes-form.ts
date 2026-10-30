import type { AuthError } from "./login-messages";
import { tooManyAttemptsMessage } from "./rate-limit-wait";

/**
 * The "Make new backup codes" section of /account: its fixed sentences and small checks. The server
 * (POST /api/auth/two-factor/generate-backup-codes) re-checks the password, rate-limits, replaces
 * every old code and audits it; nothing here is a gate.
 *
 * The number of codes a person has left is NOT shown: they are stored encrypted and the API does
 * not return a count, so the screen says so rather than invent one.
 */

export const BACKUP_CODES_WARNING = "Making new backup codes replaces all your old ones. The old codes stop working as soon as the new ones are made.";
export const BACKUP_CODES_SAVE_PROMPT = "Save these somewhere safe, apart from your phone. They are shown only now. Each works once if you lose the phone. Your old codes no longer work.";
export const BACKUP_CODES_COUNT_NOTE = "How many backup codes you have left cannot be shown.";

export function validateBackupCodesPassword(password: string): string | null {
  return password.length === 0 ? "Enter your current password." : null;
}

export function backupCodesErrorMessage(error: AuthError, waitSeconds: number | null = null): string {
  if (error?.status === 429) return tooManyAttemptsMessage(waitSeconds);
  if (error?.status === 401) return "Your session ended. Sign in again.";
  if (error?.code === "INVALID_PASSWORD") return "Your password is not correct.";
  return "Could not make new backup codes. Try again.";
}

/** The text a Copy button puts on the clipboard: one code per line, nothing else. */
export function formatCodesForCopy(codes: readonly string[]): string {
  return codes.join("\n");
}
