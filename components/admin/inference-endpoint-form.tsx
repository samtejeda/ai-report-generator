"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { fieldClass } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { callAdminApi } from "@/lib/admin/api-call";
import { adminErrorMessage, needsReauth } from "@/lib/admin/messages";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

// Owner only; the server checks the role, the allow-list (Tailscale hosts only) and that the
// sign-in is recent. This form does not validate the address itself: the server's answer is the
// only judge, and what the person typed stays in the box when it says no.
export function InferenceEndpointForm({ current }: { current: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(current ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [pending, setPending] = useState(false);

  // Next keeps this page alive and hidden and restores its state: do not come back to a stale "saved" line, error or re-sign-in prompt.
  // The address in the box is kept.
  useResetWhenHidden(() => {
    setMessage(null);
    setSaved(null);
    setReauth(false);
  });

  async function send(endpoint: string | null) {
    setPending(true);
    setMessage(null);
    setSaved(null);
    setReauth(false);
    const result = await callAdminApi("/api/admin/inference-endpoint", "PUT", { endpoint });
    setPending(false);
    if (!result.ok) {
      setReauth(needsReauth(result.failure));
      return setMessage(adminErrorMessage(endpoint === null ? "clear_endpoint" : "set_endpoint", result.failure));
    }
    if (endpoint === null) setValue("");
    else setValue(endpoint);
    setSaved(endpoint === null ? "Endpoint cleared." : "Endpoint saved.");
    router.refresh();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === "") return setMessage("Enter an address, or use Clear to remove the current one.");
    void send(trimmed);
  }

  function onClear() {
    if (!window.confirm("Clear the inference endpoint for this practice?")) return;
    void send(null);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        Inference endpoint
        <input
          name="endpoint"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={2048}
          className={fieldClass}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="url"
          aria-describedby="endpoint-format"
        />
      </label>
      <p id="endpoint-format">
        Format: https://&lt;machine&gt;.&lt;tailnet&gt;.ts.net, optionally with port 443, 8443 or 10000 and optionally ending in /v1. Lower case. Tailscale addresses only.
      </p>
      {message ? <p role="alert">{message}</p> : null}
      {reauth ? <SignOutButton /> : null}
      {saved ? <p role="status">{saved}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={onClear} disabled={pending || current === null}>
          Clear
        </Button>
      </div>
    </form>
  );
}
