/**
 * Where people go. Pure decisions only; the session lookup that feeds them is lib/auth/visitor.ts
 * and the redirect itself happens in the page (server-side). proxy.ts is not involved: it stays a
 * cookie-presence check, and there is deliberately no `?next=` (a redirect target taken from the
 * request is an open-redirect risk; returning to the page you wanted is a separate decision).
 */

/** The working home: the screen a signed-in person lands on (Sam, 2026-10-30). */
export const HOME_PATH = "/clients";
export const SIGN_IN_PATH = "/login";
export const MFA_SETUP_PATH = "/account/mfa";

/**
 * signed_in    a complete session (password and code step)
 * enrolling    signed in with the password only; the authenticator app is not set up yet
 * signed_out   no usable session
 */
export type Visitor = "signed_in" | "enrolling" | "signed_out";

/** The address `/` sends a visitor to. Same outcome as requireSession(), but without throwing. */
export function rootRedirect(visitor: Visitor): string {
  if (visitor === "signed_in") return HOME_PATH;
  if (visitor === "enrolling") return MFA_SETUP_PATH;
  return SIGN_IN_PATH;
}

/**
 * For /login, /forgot-password and /reset-password: null shows the page, otherwise the address to
 * send the visitor to instead.
 *  - A signed-in person has no business on a sign-in form: home.
 *  - An `enrolling` session is NOT sent away. It is not a finished sign-in, and these pages are how
 *    a person stuck on someone else's half-finished session signs in as themselves.
 *  - A reset link that was opened on purpose (`resetLink`: the page got a token or an error from
 *    the emailed link) works for a signed-in person too.
 */
export function authPageRedirect(visitor: Visitor, options: { resetLink?: boolean } = {}): string | null {
  if (visitor !== "signed_in") return null;
  if (options.resetLink) return null;
  return HOME_PATH;
}
