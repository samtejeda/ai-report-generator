import { ChangeRoleForm } from "@/components/admin/change-role-form";
import { ResetMfaButton } from "@/components/admin/reset-mfa-button";
import { UserActiveButton } from "@/components/admin/user-active-button";
import { userActionsFor } from "@/lib/admin/user-actions";
import type { SessionContext } from "@/lib/auth/session";
import type { UserView } from "@/lib/db/user-admin";
import { USER_ROLES } from "@/lib/db/schema/users";

// One person on the owner's people screen (server component). The buttons shown come from the
// server's own who-may-change-whom rule; the routes re-check every action.
export function UserRow({ actor, user }: { actor: SessionContext; user: UserView }) {
  const actions = userActionsFor(actor, user);
  // Asked as if an authenticator were enrolled, so the button (and the confirmation after a reset)
  // stays mounted once the reset clears the flag; it is disabled when there is nothing to reset.
  const mayReset = userActionsFor(actor, { ...user, mfaEnabled: true }).resetMfa;
  return (
    <li className="flex flex-col gap-2 border-b border-zinc-200 pb-3 text-sm">
      <p className="font-medium">
        {user.displayName}
        {actions.isSelf ? " (you)" : ""}
      </p>
      <dl className="flex flex-col gap-1">
        <div>
          <dt className="inline font-medium">Email: </dt>
          <dd className="inline break-all">{user.email}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Role: </dt>
          <dd className="inline">{user.role}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Status: </dt>
          <dd className="inline">{user.active ? "Active" : "Deactivated"}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Authenticator: </dt>
          <dd className="inline">{user.mfaEnabled ? "On" : "Not set up"}</dd>
        </div>
      </dl>
      {actions.changeRole ? <ChangeRoleForm userId={user.id} name={user.displayName} currentRole={user.role} roles={USER_ROLES} /> : null}
      {actions.deactivate || actions.reactivate ? <UserActiveButton userId={user.id} name={user.displayName} active={user.active} /> : null}
      {mayReset ? <ResetMfaButton userId={user.id} name={user.displayName} enrolled={user.mfaEnabled} /> : null}
    </li>
  );
}
