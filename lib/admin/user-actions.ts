import { checkUserChange } from "@/lib/auth/user-rules";
import type { UserRole } from "@/lib/db/schema/users";

/**
 * Which buttons the users screen shows for one person. It asks the same rule the server applies
 * (lib/auth/user-rules.ts), so the screen cannot offer what the route would refuse for a role
 * reason. This only decides what to SHOW; the routes re-check everything and are the gate.
 */

export type ListedUser = { id: string; role: UserRole; active: boolean; mfaEnabled: boolean };
export type UserActions = { isSelf: boolean; changeRole: boolean; deactivate: boolean; reactivate: boolean; resetMfa: boolean };

export function userActionsFor(actor: { userId: string; role: UserRole }, target: ListedUser): UserActions {
  const isSelf = actor.userId === target.id;
  const target_ = { id: target.id, role: target.role };
  const ok = (change: Parameters<typeof checkUserChange>[2]) => checkUserChange(actor, target_, change) === "ok";
  return {
    isSelf,
    // A deactivated person cannot be re-roled (the server answers 409), so only reactivation is offered.
    changeRole: target.active && ok({ kind: "role", to: target.role }),
    deactivate: target.active && ok({ kind: "deactivate" }),
    reactivate: !target.active && ok({ kind: "reactivate" }),
    resetMfa: target.active && target.mfaEnabled && ok({ kind: "reset_mfa" }),
  };
}
