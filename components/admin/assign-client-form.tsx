"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { fieldClass } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { callAdminApi } from "@/lib/admin/api-call";
import { adminErrorMessage } from "@/lib/admin/messages";

export type Option = { id: string; label: string };

// Owner only. Ids go to the server in the body (never in the address); the server checks both
// belong to this practice and answers the same 404 for anything else. An owner cannot be picked
// (owners see every client), and the server refuses it too.
export function AssignClientForm({ people, clients }: { people: Option[]; clients: Option[] }) {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [clientId, setClientId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userId || !clientId) return setMessage("Choose a person and a client.");
    setPending(true);
    setMessage(null);
    setDone(false);
    const result = await callAdminApi("/api/admin/assignments", "POST", { clientId, userId });
    setPending(false);
    if (!result.ok) return setMessage(adminErrorMessage("assign", result.failure));
    setClientId("");
    setDone(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        Person
        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setDone(false);
          }}
          className={fieldClass}
        >
          <option value="">Choose a person…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Client
        <select
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
            setDone(false);
          }}
          className={fieldClass}
        >
          <option value="">Choose a client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {message ? <p role="alert">{message}</p> : null}
      {done ? <p role="status">Assigned. It applies on their next request.</p> : null}
      <Button type="submit" disabled={pending}>
        Assign
      </Button>
    </form>
  );
}
