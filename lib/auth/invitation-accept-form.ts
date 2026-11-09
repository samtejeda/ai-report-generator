import type { ApiFailure } from "@/lib/admin/api-call";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./config";
import { tooManyAttemptsMessage } from "./rate-limit-wait";

/**
 * The accept-invitation page's decisions, as pure functions. Nothing here is a gate: the route
 * (lib/auth/invitation-accept.ts) checks the token, the name and the password again, and decides
 * everything that matters. These only save a request on a typo and turn the route's answers into
 * fixed sentences. Never a value the person typed, never the token, never the server's own text.
 */

export const NAME_MAX_LENGTH = 200;

export const INVALID_LINK_MESSAGE = "This invitation link is not valid. Ask the practice owner to send you a new one.";
export const ACCEPT_RETRY_MESSAGE = "Could not create the account. Check your name and password and try again.";

/** Same checks the route makes on the body (trimmed name 1 to 200 with no control characters; password 12 to 128). */
export function validateAcceptForm(name: string, password: string, confirm: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter your name.";
  if (trimmed.length > NAME_MAX_LENGTH) return `Use at most ${NAME_MAX_LENGTH} characters for your name.`;
  if (/\p{Cc}/u.test(trimmed)) return "Your name has a character that is not allowed.";
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters for the password.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters for the password.`;
  if (password !== confirm) return "The two passwords do not match.";
  return null;
}

/**
 * `invalid_link`: the link cannot be used and retrying cannot help (the page drops its copy of the
 * token and shows only this). `retry`: the form stays, with the typed name, so the person can try again.
 * One sentence for every unusable link, whatever the reason, exactly as the route answers.
 */
export type AcceptOutcome = { kind: "invalid_link"; message: string } | { kind: "retry"; message: string };

export function acceptOutcome(failure: ApiFailure | null): AcceptOutcome {
  if (failure === null) return { kind: "retry", message: "Could not reach the server. Try again." };
  if (failure.status === 400 && failure.code === "invalid_invitation") return { kind: "invalid_link", message: INVALID_LINK_MESSAGE };
  if (failure.status === 400) return { kind: "retry", message: ACCEPT_RETRY_MESSAGE };
  if (failure.status === 429) return { kind: "retry", message: tooManyAttemptsMessage(failure.retryAfterSeconds ?? null) };
  return { kind: "retry", message: "Something went wrong. Try again." };
}
