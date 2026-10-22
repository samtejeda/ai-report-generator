"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { callAdminApi } from "@/lib/admin/api-call";
import { adminErrorMessage } from "@/lib/admin/messages";

// Shown only where the server's own rule would allow a role change (lib/admin/user-actions.ts);
// the route checks again and is the gate. The new role applies on the person's next request.
export function ChangeRoleForm({ userId, name, currentRole, roles }: { userId: string; name: string; currentRole: string; roles: readonly string[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState(currentRole);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected === "owner" && !window.confirm("Make this person an owner? Owners can do everything in the practice.")) return;
    if (currentRole === "owner" && !window.confirm("Remove this person's owner access?")) return;
    setPending(true);
    setMessage(null);
    setDone(false);
    const result = await callAdminApi(`/api/admin/users/${userId}`, "PATCH", { role: selected });
    setPending(false);
    if (!result.ok) return setMessage(adminErrorMessage("change_role", result.failure));
    setDone(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          Role
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setDone(false);
            }}
            aria-label={`Role for ${name}`}
            className="h-9 rounded-md border border-zinc-300 bg-transparent px-2 text-sm"
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline" disabled={pending || selected === currentRole} aria-label={`Change role of ${name}`}>
          Change role
        </Button>
      </div>
      {message ? <p role="alert">{message}</p> : null}
      {done ? <p role="status">Role changed.</p> : null}
    </form>
  );
}
