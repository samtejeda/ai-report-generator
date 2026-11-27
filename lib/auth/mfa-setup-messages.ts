// What the authenticator enrollment screen says about getting an app and adding the account.
//
// Placeholders awaiting the practice owner's wording (Sam, 2026-11-27): every sentence in this file.
// None of them is clinical or legal wording. The apps named are examples, not an endorsement, and
// no secret ever goes into any of these strings.

/** Step 1, before the password: how to get an authenticator app. */
export const AUTHENTICATOR_APP_HELP =
  "Don't have an authenticator app? Install one on your phone first, for example Google Authenticator, Microsoft Authenticator or your password manager's built-in one, then come back.";

/** Step 2 when the code is drawn: scan it, or use the key. */
export const SCAN_INSTRUCTION =
  'In your authenticator app, add an account: scan this code, or enter the key below. Choose "time-based" if asked. Then type the 6-digit code the app shows.';

/** Step 2 when the code could not be drawn (the text key still works on its own). */
export const KEY_ONLY_INSTRUCTION =
  'In your authenticator app, add an account and enter this setup key. Choose "time-based" if asked. Then type the 6-digit code the app shows.';

/** Under the code: for a person who is reading this on the phone that holds the app. */
export const SAME_PHONE_NOTE = "On the same phone you are reading this on? You cannot scan it, so enter the key below instead.";

/** The accessible name of the drawing. Never put the key or the address here. */
export const QR_LABEL = "QR code for your authenticator app";
