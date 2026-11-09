/**
 * What the owner's invitations list shows and offers, as plain data so it can be tested. The server
 * (components/admin/invitation-row.tsx) renders it; the routes re-check every action: this decides
 * what to SHOW, never what is allowed. Nothing here touches a token (the screen never has one).
 */

export type InvitationStatus = "pending" | "expired" | "accepted" | "revoked";

export const STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  expired: "Expired",
  revoked: "Revoked",
};

/** A pending or expired invitation can get a new link or be ended; an accepted or revoked one is final. */
export function invitationActionsFor(status: InvitationStatus): { resend: boolean; revoke: boolean } {
  const open = status === "pending" || status === "expired";
  return { resend: open, revoke: open };
}

/** The same sentence for every address (the server hides whether it has an account). */
export const INVITE_CREATED_MESSAGE =
  "Invitation created. If the address can receive it, the person gets an email with a link that works once and lasts 7 days.";
export const INVITE_RESENT_MESSAGE =
  "A new link was sent if the address can receive it. The previous link no longer works. It lasts 7 days.";
export const INVITE_REVOKED_MESSAGE = "Invitation revoked. Its link no longer works.";

/** The screen checks only that there is something to send; the server is the judge of the address. */
export function validateInviteEmail(value: string): string | null {
  return value.trim() === "" ? "Enter the person's email address." : null;
}
