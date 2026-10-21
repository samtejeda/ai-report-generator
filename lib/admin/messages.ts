import type { ApiFailure } from "./api-call";

/**
 * Fixed messages for what the admin routes can answer (API.md). Nothing from the server's body
 * is shown, and no value the user typed is repeated. `failure: null` is a request that never
 * arrived. The 409 wording depends on the action because the server uses one code for several
 * states (see lib/api/user-change.ts).
 */

export type AdminAction = "change_role" | "deactivate" | "reactivate" | "reset_mfa" | "assign" | "end_assignment" | "set_endpoint" | "clear_endpoint";

export const REAUTH_MESSAGE = "Your sign-in is more than a few minutes old. Sign out and sign in again, then repeat this.";

/** True when the only thing wrong is an old sign-in: the screen then offers sign-out. */
export function needsReauth(failure: ApiFailure | null): boolean {
  return failure?.status === 403 && failure.code === "reauth_required";
}

export function adminErrorMessage(action: AdminAction, failure: ApiFailure | null): string {
  if (failure === null) return "Could not reach the server. Try again.";
  if (needsReauth(failure)) return REAUTH_MESSAGE;
  switch (failure.status) {
    case 401:
      return "Your session ended. Sign in again.";
    case 403:
      return "You do not have access to do this.";
    case 429:
      return "Too many attempts. Wait a few minutes and try again.";
    case 404:
      return action === "assign"
        ? "That client or person could not be found. Reload the page."
        : "That could not be found any more. Reload the page.";
    case 409:
      if (action === "assign") return "That person already has this client.";
      return "This could not be done: the person may be deactivated, may have been changed by someone else, or the practice needs an owner. Reload the page and try again.";
    case 400:
      if (action === "set_endpoint") {
        return "That address is not allowed. Use https://<machine>.<tailnet>.ts.net (optional port 443, 8443 or 10000, optional /v1), all lower case.";
      }
      return "The request was not accepted. Reload the page and try again.";
    default:
      return "Something went wrong. Try again.";
  }
}
