/**
 * What the show/hide control on a password field says and does, as plain data so it can be tested.
 * The field is `type="password"` until the person presses the button; the choice lives in the
 * component's state only (never stored) and goes back to hidden when the page is hidden.
 *
 * The button's text is its accessible name's start ("Show password: Current password"), so a
 * voice-control user who says what they see gets the right button, and three fields on one form
 * are still told apart.
 */
export function passwordToggle(visible: boolean, fieldLabel: string): { inputType: "text" | "password"; buttonText: string; buttonName: string } {
  const buttonText = visible ? "Hide password" : "Show password";
  return { inputType: visible ? "text" : "password", buttonText, buttonName: `${buttonText}: ${fieldLabel}` };
}
