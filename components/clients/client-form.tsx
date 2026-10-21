"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/auth/auth-card";

// Plain create/edit form for the four client fields (decision D6). It only calls our own routes;
// the server validates and authorizes everything again, so nothing here is a gate.
export type ClientFormValues = { displayName: string; dateOfBirth: string; gradeLevel: string; externalId: string };

const EMPTY: ClientFormValues = { displayName: "", dateOfBirth: "", gradeLevel: "", externalId: "" };

export function ClientForm({ clientId, initial = EMPTY }: { clientId?: string; initial?: ClientFormValues }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values: ClientFormValues = {
      displayName: String(form.get("displayName") ?? ""),
      dateOfBirth: String(form.get("dateOfBirth") ?? ""),
      gradeLevel: String(form.get("gradeLevel") ?? ""),
      externalId: String(form.get("externalId") ?? ""),
    };
    // An empty optional field means "none": null on the wire.
    const wire = (key: keyof ClientFormValues) => (key === "displayName" ? values[key] : values[key].trim() === "" ? null : values[key]);
    const body: Record<string, string | null> = {};
    for (const key of Object.keys(values) as (keyof ClientFormValues)[]) {
      if (!clientId || values[key] !== initial[key]) body[key] = wire(key);
    }
    if (clientId && Object.keys(body).length === 0) {
      setMessage("Nothing to save.");
      return;
    }
    if (!clientId) for (const key of ["dateOfBirth", "gradeLevel", "externalId"]) if (body[key] === null) delete body[key];

    setPending(true);
    setMessage(null);
    setSaved(false);
    const res = await fetch(clientId ? `/api/clients/${clientId}` : "/api/clients", {
      method: clientId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setPending(false);
    if (!res) return setMessage("Could not reach the server. Try again.");
    if (res.ok) {
      if (!clientId) {
        const created = (await res.json()) as { data: { id: string } };
        return router.push(`/clients/${created.data.id}`);
      }
      setSaved(true);
      return router.refresh();
    }
    if (res.status === 409) return setMessage("That external ID is already used by another client.");
    if (res.status === 400) return setMessage("Check the fields: a name is required, the date must be real and not in the future, and the grade is letters or digits.");
    if (res.status === 401) return setMessage("Your session ended. Sign in again.");
    setMessage("This could not be saved.");
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        Display name
        <input name="displayName" required maxLength={200} defaultValue={initial.displayName} className={fieldClass} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1">
        Date of birth (optional)
        <input name="dateOfBirth" type="date" defaultValue={initial.dateOfBirth} className={fieldClass} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1">
        Grade level (optional)
        <input name="gradeLevel" maxLength={20} defaultValue={initial.gradeLevel} className={fieldClass} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1">
        External ID (optional)
        <input name="externalId" maxLength={64} defaultValue={initial.externalId} className={fieldClass} autoComplete="off" />
      </label>
      {message ? <p role="alert">{message}</p> : null}
      {saved ? <p role="status">Saved.</p> : null}
      <Button type="submit" disabled={pending}>
        {clientId ? "Save changes" : "Create client"}
      </Button>
    </form>
  );
}
