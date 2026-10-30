"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

// Owner only (the server refuses anyone else). Soft delete: the client disappears for everyone.
export function DeleteClientButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useResetWhenHidden(() => setMessage(null));

  async function onClick() {
    if (!window.confirm("Delete this client? It will disappear for everyone in the practice.")) return;
    setPending(true);
    setMessage(null);
    const res = await fetch(`/api/clients/${clientId}`, { method: "DELETE" }).catch(() => null);
    setPending(false);
    if (res?.ok) return router.push("/clients");
    setMessage("This could not be deleted.");
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <Button type="button" variant="destructive" onClick={onClick} disabled={pending}>
        Delete client
      </Button>
      {message ? <p role="alert">{message}</p> : null}
    </div>
  );
}
