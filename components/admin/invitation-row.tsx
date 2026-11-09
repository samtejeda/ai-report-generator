import { InvitationActions } from "@/components/admin/invitation-actions";
import { LocalTime } from "@/components/reports/local-time";
import { invitationActionsFor, STATUS_LABEL } from "@/lib/admin/invitation-view";
import type { InvitationView } from "@/lib/db/invitation-admin";

// One invitation on the owner's screen (server component). It shows an address, a status and times,
// never a token (the screen never has one). The buttons shown come from invitationActionsFor; the
// routes re-check every action.
export function InvitationRow({ invitation }: { invitation: InvitationView }) {
  const actions = invitationActionsFor(invitation.status);
  return (
    <li className="flex flex-col gap-2 border-b border-zinc-200 pb-3 text-sm">
      <p className="font-medium break-all">{invitation.email}</p>
      <dl className="flex flex-col gap-1">
        <div>
          <dt className="inline font-medium">Status: </dt>
          <dd className="inline">{STATUS_LABEL[invitation.status]}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Created: </dt>
          <dd className="inline">
            <LocalTime iso={invitation.createdAt} />
          </dd>
        </div>
        {actions.resend ? (
          <div>
            <dt className="inline font-medium">{invitation.status === "expired" ? "Expired: " : "Expires: "}</dt>
            <dd className="inline">
              <LocalTime iso={invitation.expiresAt} />
            </dd>
          </div>
        ) : null}
      </dl>
      {actions.resend || actions.revoke ? <InvitationActions id={invitation.id} email={invitation.email} /> : null}
    </li>
  );
}
