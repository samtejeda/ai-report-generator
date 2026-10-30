"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import {
  BACKUP_CODES_COUNT_NOTE,
  BACKUP_CODES_SAVE_PROMPT,
  BACKUP_CODES_WARNING,
  backupCodesErrorMessage,
  formatCodesForCopy,
  validateBackupCodesPassword,
} from "@/lib/auth/backup-codes-form";
import { resetFormWhenHidden, useResetWhenHidden } from "@/lib/ui/reset-when-hidden";
import { PasswordField } from "./password-field";

// "Make new backup codes" on /account. It calls the existing POST /api/auth/two-factor/generate-backup-codes
// (through Better Auth's client), which re-checks the password, rate-limits, replaces every old
// code and audits it. The new codes are held in this component's state only: shown once, never
// stored, and dropped when the person presses "I have saved them", leaves the page (Next keeps a
// page you leave alive and hidden, so this hook matters) or the component unmounts.
export function BackupCodes() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  useResetWhenHidden(() => {
    setOpen(false);
    setMessage(null);
    setCodes([]);
    setCopyNote(null);
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    const invalid = validateBackupCodesPassword(password);
    if (invalid) return setMessage(invalid);
    setPending(true);
    setMessage(null);
    const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
    setPending(false);
    if (error || !data || !Array.isArray(data.backupCodes)) {
      // The typed password stays in the box.
      return setMessage(backupCodesErrorMessage(error ?? null));
    }
    setCodes(data.backupCodes);
    setOpen(false);
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(formatCodesForCopy(codes));
      setCopyNote("Copied. Paste them somewhere safe; they stay on your clipboard until you copy something else.");
    } catch {
      setCopyNote("Could not copy. Select the codes and copy them yourself.");
    }
  }

  function done() {
    setCodes([]);
    setCopyNote(null);
  }

  return (
    <section className="flex flex-col gap-3 border-t border-zinc-200 pt-4 text-sm">
      <h2 className="text-base font-semibold">Backup codes</h2>
      {codes.length > 0 ? (
        <>
          <p>{BACKUP_CODES_SAVE_PROMPT}</p>
          <ul className="grid grid-cols-2 gap-1 rounded-md border border-zinc-300 p-2 font-mono" data-testid="new-backup-codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={onCopy}>
              Copy codes
            </Button>
            <Button type="button" onClick={done}>
              I have saved them
            </Button>
          </div>
          {copyNote ? <p role="status">{copyNote}</p> : null}
        </>
      ) : open ? (
        <form ref={resetFormWhenHidden} onSubmit={onSubmit} className="flex flex-col gap-3">
          <p>{BACKUP_CODES_WARNING}</p>
          <PasswordField label="Current password" name="password" autoComplete="current-password" />
          {message ? <p role="alert">{message}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Making…" : "Make new codes"}
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p>{BACKUP_CODES_COUNT_NOTE}</p>
          <div>
            <Button type="button" variant="outline" onClick={() => setOpen(true)}>
              Make new backup codes
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
